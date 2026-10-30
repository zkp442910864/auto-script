'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const http = require('node:http');
const { createApp, taskCommand } = require('./server');

async function fixture(t, spawnProcess) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-console-test-'));
  const app = createApp({ spawnProcess, runDir, profileRoot: runDir });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => { await app.shutdown(); fs.rmSync(runDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, base, runDir, request: (body, extra = {}) => fetch(`${base}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) }) };
}
async function waitUntil(fn) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待状态超时');
}

test('各模式映射为固定 Node 脚本，参数不通过 shell', () => {
  for (const task of ['shipping', 'packing']) {
    for (const mode of ['probe', 'dry', 'auto']) {
      const command = taskCommand({ task, mode });
      assert.equal(path.basename(command.cwd), `${task}-auto`);
      assert.equal(command.args.includes('probe'), mode === 'probe');
      assert.equal(command.args.includes('--dry'), mode === 'dry');
      assert.ok(command.args.includes(`--max-rounds=${mode === 'auto' ? 200 : 1}`));
      if (task === 'shipping') assert.ok(command.args.includes('--close-browser'));
    }
  }
  for (const body of [null, { task: '__proto__', mode: 'auto' }, { task: 'shipping', mode: 'constructor' }, { task: 'packing', mode: 'auto', options: { boxes: '1; rm' } }, { task: 'shipping', mode: 'auto', options: { maxRounds: 0 } }, { task: 'shipping', mode: 'auto', options: [] }]) {
    assert.throws(() => taskCommand(body));
  }
});

test('全局互斥、实时双通道日志、刷新恢复、完成解锁与持久日志', async (t) => {
  const calls = [];
  const f = await fixture(t, (executable, args, options) => {
    calls.push({ executable, args, options });
    // Only a local synthetic child process is launched; production scripts never run in tests.
    return spawn(process.execPath, ['-e', "console.log('第一段：中文日志'); console.error('stderr 测试'); setTimeout(() => console.log('执行结束'), 900)"], { stdio: ['ignore', 'pipe', 'pipe'] });
  });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(`${f.base}/api/events`, { signal: controller.signal });
  const reader = stream.body.getReader();
  let events = '';
  const reading = (async () => {
    const decoder = new TextDecoder();
    try { while (true) { const part = await reader.read(); if (part.done) break; events += decoder.decode(part.value, { stream: true }); } } catch (error) { if (error.name !== 'AbortError') throw error; }
  })();
  const [a, b] = await Promise.all([f.request({ task: 'shipping', mode: 'dry' }), f.request({ task: 'packing', mode: 'auto' })]);
  assert.deepEqual([a.status, b.status].sort(), [202, 409]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.CDP, '');
  const running = await waitUntil(async () => {
    const state = await (await fetch(`${f.base}/api/state`)).json();
    return state.run?.logs.some((item) => item.text.includes('第一段')) && state;
  });
  assert.equal(running.run.status, 'running');
  // SSE reconnect begins with the current run and its full in-memory buffer.
  const reconnect = new AbortController();
  const reconnected = await fetch(`${f.base}/api/events`, { signal: reconnect.signal });
  const initial = await reconnected.body.getReader().read();
  const restored = new TextDecoder().decode(initial.value);
  assert.ok(restored.includes(running.run.id));
  assert.ok(restored.includes('第一段'));
  reconnect.abort();
  await waitUntil(async () => {
    const state = await (await fetch(`${f.base}/api/state`)).json();
    return state.run.status === 'succeeded';
  });
  await waitUntil(() => events.includes('执行结束') && events.includes('"status":"succeeded"'));
  assert.ok(events.includes('event: log'));
  assert.ok(events.includes('stderr 测试'));
  const download = await fetch(`${f.base}/api/log`);
  const text = await download.text();
  assert.ok(text.includes('第一段：中文日志'));
  assert.ok(text.includes('执行结束'));
  assert.equal(fs.readdirSync(f.runDir).length, 1);
  const next = await f.request({ task: 'packing', mode: 'probe' });
  assert.equal(next.status, 202);
  controller.abort();
  await reading;
});

test('异常退出和启动失败释放执行锁', async (t) => {
  let launches = 0;
  const f = await fixture(t, () => {
    launches++;
    if (launches === 2) return spawn('/not-an-existing-executable', []);
    if (launches === 3) throw new Error('同步启动异常');
    return spawn(process.execPath, ['-e', "console.error('模拟脚本失败'); process.exitCode = 7"]);
  });
  for (let index = 0; index < 3; index++) {
    assert.equal((await f.request({ task: 'shipping', mode: 'probe' })).status, 202);
    const failed = await waitUntil(async () => {
      const state = await (await fetch(`${f.base}/api/state`)).json();
      return state.run.status === 'failed' && state.run;
    });
    if (index === 0) assert.equal(failed.exitCode, 7);
    else assert.ok(failed.logs.some((item) => item.text.includes('启动失败')));
  }
});

test('拒绝非法请求与跨站执行，只提供允许的页面及 PNG 快照', async (t) => {
  const f = await fixture(t, () => { throw new Error('不应执行'); });
  assert.equal((await fetch(f.base)).status, 200);
  assert.equal((await f.request({ task: 'shipping', mode: 'auto' }, { Origin: 'https://example.com' })).status, 403);
  const invalidHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(`${f.base}/api/state`, { headers: { Host: 'evil.example' } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(invalidHostStatus, 403);
  assert.equal((await f.request({ task: 'packing', mode: 'auto', options: { boxes: -1 } })).status, 400);
  assert.equal((await fetch(`${f.base}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await f.request({ task: 'packing', mode: 'auto', excess: 'x'.repeat(9000) })).status, 413);
  assert.equal((await fetch(`${f.base}/api/shots/shipping/probe.html`)).status, 404);
  assert.equal((await fetch(`${f.base}/api/shots/shipping/..%2Findex.js`)).status, 404);
  assert.equal((await fetch(`${f.base}/shipping-auto/index.js`)).status, 404);
  const shots = await (await fetch(`${f.base}/api/shots`)).json();
  if (shots.shots.length) {
    const image = await fetch(f.base + shots.shots[0].url);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    await image.arrayBuffer();
  }
});

test('关闭服务等待子进程清理与最后日志落盘', async (t) => {
  const f = await fixture(t, () => spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{console.log('浏览器清理完成');process.exit(0)}); console.log('READY'); setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] }));
  await f.request({ task: 'shipping', mode: 'dry' });
  const run = await waitUntil(async () => {
    const state = await (await fetch(`${f.base}/api/state`)).json();
    return state.run.logs.some((item) => item.text.includes('READY')) && state.run;
  });
  await f.shutdown();
  const log = fs.readFileSync(path.join(f.runDir, `${run.id}.log`), 'utf8');
  assert.ok(log.includes('浏览器清理完成'));
  assert.ok(log.includes('退出码：0'));
});

test('手动停止等待进程清理，拒绝旧任务停止请求并恢复执行', async (t) => {
  const f = await fixture(t, () => spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>setTimeout(()=>{console.log('清理完成');process.exit(0)},250));console.log('READY');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] }));
  const post = (id) => fetch(`${f.base}/api/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  await f.request({ task: 'packing', mode: 'dry' });
  const run = await waitUntil(async () => {
    const state = await (await fetch(`${f.base}/api/state`)).json();
    return state.run.logs.some((item) => item.text.includes('READY')) && state.run;
  });
  assert.equal((await post('old-id')).status, 409);
  assert.equal((await post(run.id)).status, 202);
  assert.equal((await f.request({ task: 'shipping', mode: 'probe' })).status, 409);
  const stopped = await waitUntil(async () => {
    const state = await (await fetch(`${f.base}/api/state`)).json();
    return state.run.status === 'stopped' && state.run;
  });
  assert.ok(stopped.logs.some((item) => item.text.includes('清理完成')));
  assert.equal((await post(run.id)).status, 409);
  assert.equal((await f.request({ task: 'shipping', mode: 'probe' })).status, 202);
});


test('清除指定登录配置，运行期间禁止清除', async (t) => {
  const f = await fixture(t, () => spawn(process.execPath, ['-e', "setTimeout(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] }));
  for (const name of ['shipping-auto', 'packing-auto']) {
    const dir = path.join(f.runDir, name, '.pw-profile');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'login'), 'test');
  }
  const clear = (profile) => fetch(`${f.base}/api/clear-profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile }) });
  assert.equal((await clear('../shipping')).status, 400);
  assert.equal((await clear('shipping')).status, 200);
  assert.equal(fs.existsSync(path.join(f.runDir, 'shipping-auto', '.pw-profile')), false);
  assert.equal(fs.existsSync(path.join(f.runDir, 'packing-auto', '.pw-profile')), true);
  await f.request({ task: 'shipping', mode: 'dry' });
  assert.equal((await clear('packing')).status, 409);
  assert.equal(fs.existsSync(path.join(f.runDir, 'packing-auto', '.pw-profile')), true);
});

test('主动快照会话支持连续抓取，拦截旧会话及并发请求', async (t) => {
  const f = await fixture(t, () => spawn(process.execPath, ['-e', `
    process.on('message', m => setTimeout(() => process.send({ type: 'snapshot-result', id: m.id, files: ['manual-test.png'] }), 100));
    process.send({ type: 'snapshot-ready' });
  `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
  const command = taskCommand({ task: 'packing', mode: 'manual', options: { reuseShippingProfile: true } });
  assert.ok(command.args[0].endsWith('manual-snapshot.js'));
  assert.deepEqual(command.args.slice(1), ['packing', '--reuse']);
  await f.request({ task: 'packing', mode: 'manual' });
  const run = await waitUntil(async () => {
    const state = await (await fetch(`${f.base}/api/state`)).json();
    return state.run.snapshotReady && state.run;
  });
  const capture = (id) => fetch(`${f.base}/api/snapshot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  assert.equal((await capture('old')).status, 409);
  const responses = await Promise.all([capture(run.id), capture(run.id)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.deepEqual((await (await capture(run.id)).json()).files, ['manual-test.png']);
  assert.equal((await f.request({ task: 'shipping', mode: 'auto' })).status, 409);
});

test('主动快照抓取每次最新 DOM，保留多页与 frame', async (t) => {
  const { capturePages } = require('./manual-snapshot');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-capture-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let html = '<button>第一步</button>';
  const page = {
    isClosed: () => false, url: () => 'https://example.test',
    frames: () => [{ url: () => 'https://example.test', content: async () => html }],
    screenshot: async ({ path: file }) => fs.writeFileSync(file, 'mock image'),
  };
  const context = { pages: () => [page, page] };
  const first = await capturePages(context, directory);
  html = '<div role="dialog">动态节点</div>';
  const second = await capturePages(context, directory);
  assert.equal(first.length, 2);
  assert.notEqual(first[0], second[0]);
  const read = name => JSON.parse(fs.readFileSync(path.join(directory, name.replace('.png', '.json'))));
  assert.match(read(first[0]).frames[0].html, /第一步/);
  assert.match(read(second[0]).frames[0].html, /动态节点/);
});

test('登录使用固定独立脚本，校验配置和成对凭据', () => {
  const command = taskCommand({ task: 'login', mode: 'login', options: { username: 'test-user', password: 'test-password', acceptAgreement: true } });
  assert.equal(path.basename(command.cwd), 'login-auto');
  assert.deepEqual(command.args, ['index.js']);
  assert.deepEqual(command.credentials, { username: 'test-user', password: 'test-password', acceptAgreement: true });
  for (const options of [{ profile: 'packing' }, { profile: '../shipping' }, { username: 'user' }, { password: 'password' }, { username: [], password: 'x' }, { username: 'user', password: 'x'.repeat(1025) }, { acceptAgreement: 'yes' }]) {
    assert.throws(() => taskCommand({ task: 'login', mode: 'login', options }));
  }
  assert.throws(() => taskCommand({ task: 'login', mode: 'auto' }));
  assert.throws(() => taskCommand({ task: 'shipping', mode: 'login' }));
});

test('登录通过 IPC 传递凭据，持续运行直到停止，日志与状态不泄露凭据', async (t) => {
  let call;
  const f = await fixture(t, (executable, args, options) => {
    call = { executable, args, options };
    return spawn(process.execPath, ['-e', `
      process.on('message', message => {
        if (message.username !== 'private-user' || message.password !== 'private-password') process.exit(2);
        console.log('LOGIN_READY');
      });
      process.on('SIGTERM', () => setTimeout(() => { console.log('LOGIN_CLOSED'); process.exit(0); }, 50));
      process.send({ type: 'login-input-ready' });
    `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  });
  assert.equal((await f.request({ task: 'login', mode: 'login' })).status, 400);
  assert.equal((await f.request({ task: 'login', mode: 'login', options: { username: 'private-user', password: 'private-password' } })).status, 202);
  const run = await waitUntil(async () => {
    const state = await (await fetch(`${f.base}/api/state`)).json();
    return state.run.logs.some((item) => item.text.includes('LOGIN_READY')) && state.run;
  });
  assert.equal(run.mode, 'login');
  assert.equal(run.profile, 'shipping');
  assert.equal(run.status, 'running');
  assert.equal(call.options.shell, false);
  assert.equal(call.options.stdio[3], 'ipc');
  assert.doesNotMatch(JSON.stringify(call), /private-user|private-password/);
  assert.doesNotMatch(JSON.stringify(run), /private-user|private-password/);
  assert.equal((await f.request({ task: 'packing', mode: 'auto' })).status, 409);
  const stop = await fetch(`${f.base}/api/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: run.id }) });
  assert.equal(stop.status, 202);
  await waitUntil(async () => (await (await fetch(`${f.base}/api/state`)).json()).run.status === 'stopped');
  const log = await (await fetch(`${f.base}/api/log`)).text();
  assert.match(log, /LOGIN_CLOSED/);
  assert.doesNotMatch(log, /private-user|private-password/);
});

test('Cookie 空库不算登录，确认登录后可直接打开页面，关闭后释放锁', async (t) => {
  const f = await fixture(t, () => spawn(process.execPath, ['-e', `
    process.on('message', message => {
      if (message.username || message.password) process.exit(2);
      console.log('OPENED');
      setTimeout(() => process.exit(0), 200);
    });
    process.send({ type: 'login-input-ready' });
  `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
  const directory = path.join(f.runDir, 'shipping-auto', '.pw-profile', 'Default');
  fs.mkdirSync(directory, { recursive: true });
  // Chrome creates this database before authentication: do not hide credential inputs.
  fs.writeFileSync(path.join(directory, 'Cookies'), 'mock cookies');
  const state = await (await fetch(`${f.base}/api/state`)).json();
  assert.deepEqual(state.profiles, { shipping: { saved: false } });
  assert.equal((await f.request({ task: 'login', mode: 'login' })).status, 400);
  fs.writeFileSync(path.join(directory, '..', '.login-state.json'), JSON.stringify({ savedAt: new Date().toISOString() }));
  assert.deepEqual((await (await fetch(`${f.base}/api/state`)).json()).profiles, { shipping: { saved: true } });
  assert.equal((await f.request({ task: 'login', mode: 'login', options: { profile: 'packing' } })).status, 400);
  assert.equal((await f.request({ task: 'login', mode: 'login' })).status, 202);
  await waitUntil(async () => (await (await fetch(`${f.base}/api/state`)).json()).run.status === 'succeeded');
  assert.equal((await f.request({ task: 'login', mode: 'login' })).status, 202);
});

test('登录导航失败后保留会话及浏览器，清空内存凭据，手动关闭后结束', async (t) => {
  const { EventEmitter } = require('node:events');
  const { openSession } = require('../login-auto');
  const page = Object.assign(new EventEmitter(), {
    addInitScript: async () => {},
    goto: async () => { throw new Error('模拟网络错误'); },
    isClosed: () => false,
    url: () => 'about:blank',
  });
  const context = Object.assign(new EventEmitter(), {
    pages: () => [page],
    close: async () => { context.emit('close'); },
  });
  t.after(() => context.close());
  const credentials = { username: 'private-user', password: 'private-password' };
  const logs = [];
  const session = await openSession({
    chromium: { launchPersistentContext: async () => context },
    profileDir: '/not-used', task: 'shipping', credentials, log: (message) => logs.push(message),
  });
  let closed = false;
  session.closed.then(() => { closed = true; });
  await session.prepare();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(closed, false);
  assert.match(logs.join('\n'), /手动继续/);
  assert.deepEqual(credentials, { username: '', password: '' });
  assert.doesNotMatch(logs.join('\n'), /private-user|private-password/);
  await context.close();
  await session.closed;
  assert.equal(closed, true);
});

test('所有流程自动共用同一 Chrome 登录目录，无需配置选项', () => {
  const profile = path.resolve(__dirname, '../shipping-auto/.pw-profile');
  for (const mode of ['probe', 'dry', 'auto']) {
    for (const options of [{}, { reuseShippingProfile: false }, { reuseShippingProfile: true }]) {
      const command = taskCommand({ task: 'packing', mode, options });
      assert.ok(command.args.includes(`--profile=${profile}`));
    }
  }
  assert.deepEqual(taskCommand({ task: 'packing', mode: 'manual' }).args.slice(1), ['packing', '--reuse']);
});

test('三个脚本及主动快照共用浏览器选项，拒绝非法模式与端口', () => {
  for (const [task, modes] of [['login', ['login']], ['shipping', ['probe', 'dry', 'auto', 'manual']], ['packing', ['probe', 'dry', 'auto', 'manual']]]) {
    for (const mode of modes) {
      const command = taskCommand({ task, mode, options: { browserMode: 'auto', browserPort: 9333 } });
      assert.deepEqual(command.browser, { browserMode: 'auto', browserPort: 9333 });
      assert.doesNotMatch(command.args.join(' '), /9333|--browser=/);
      for (const options of [{ browserMode: 'other' }, { browserPort: '9222' }, { browserPort: 0 }, { browserPort: 65536 }]) assert.throws(() => taskCommand({ task, mode, options }));
    }
  }
});

test('用户浏览器方式允许无凭据准备，状态同步实际方式及回退原因', async (t) => {
  let call;
  const f = await fixture(t, (exe, args, options) => {
    call = options;
    return spawn(process.execPath, ['-e', `
      process.on('message', m => {
        if (m.username || m.password) process.exit(2);
        process.send({ type: 'browser-session', mode: 'profile', fallbackReason: '未检测到用户浏览器' });
        console.log('FALLBACK_READY');
      });
      process.send({ type: 'login-input-ready' });
    `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  });
  assert.equal((await f.request({ task: 'login', mode: 'login', options: { browserMode: 'auto', browserPort: 9333 } })).status, 202);
  const state = await waitUntil(async () => {
    const state = await (await fetch(`${f.base}/api/state`)).json();
    return state.run?.browser && state;
  });
  assert.deepEqual(state.run.browser, { mode: 'profile', fallbackReason: '未检测到用户浏览器' });
  assert.equal(call.env.AUTO_BROWSER_MODE, 'auto');
  assert.equal(call.env.AUTO_BROWSER_PORT, '9333');
  assert.equal(call.env.CDP, '');
  assert.equal((await f.request({ task: 'shipping', mode: 'auto' })).status, 409);
});

test('浏览器检测 API 限制为本机数字端口，失败后仍可使用原流程', async (t) => {
  const f = await fixture(t, () => spawn(process.execPath, ['-e', 'process.exit(0)']));
  const server = http.createServer((req, res) => {
    res.end(JSON.stringify({ Browser: 'Chrome/140', webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/test` }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const response = await fetch(`${f.base}/api/browser-check?port=${port}`);
  assert.deepEqual(await response.json(), { available: true, reason: '', port });
  for (const port of ['0', '65536', 'http://example.test', '9222.5']) assert.equal((await fetch(`${f.base}/api/browser-check?port=${port}`)).status, 400);
  await new Promise((resolve) => server.close(resolve));
  assert.equal((await (await fetch(`${f.base}/api/browser-check?port=${port}`)).json()).available, false);
  assert.equal((await f.request({ task: 'shipping', mode: 'probe' })).status, 202);
});
