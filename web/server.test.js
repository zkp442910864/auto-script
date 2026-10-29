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
