'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once, EventEmitter } = require('node:events');
const { browserOptions, discoverBrowser, openBrowser } = require('./browser-session');

test('浏览器参数只接受固定模式与本机数字端口', () => {
  assert.deepEqual(browserOptions(), { browserMode: 'profile', browserPort: 9222 });
  for (const options of [{ browserMode: 'other' }, { browserPort: '9222' }, { browserPort: 80 }, { browserPort: 65536 }, { browserPort: 9222.5 }]) assert.throws(() => browserOptions(options));
});

test('调试探测不跟随重定向、拒绝非本机或其他端口的 websocket', async (t) => {
  let data;
  let status = 200;
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/json/version');
    res.writeHead(status, { 'Content-Type': 'application/json', Location: 'https://example.test' });
    res.end(JSON.stringify(data));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  data = { Browser: 'Chrome/140.0', webSocketDebuggerUrl: `ws://localhost:${port}/devtools/browser/test-id` };
  assert.deepEqual(await discoverBrowser(port), { available: true, endpoint: `ws://127.0.0.1:${port}/devtools/browser/test-id` });
  for (const endpoint of [`ws://example.test:${port}/devtools/browser/test`, `ws://127.0.0.1:${port + 1}/devtools/browser/test`, `ws://127.0.0.1:${port}/other`, `ws://user@127.0.0.1:${port}/devtools/browser/test`]) {
    data.webSocketDebuggerUrl = endpoint;
    assert.equal((await discoverBrowser(port)).available, false);
  }
  status = 302;
  data.webSocketDebuggerUrl = `ws://127.0.0.1:${port}/devtools/browser/test`;
  assert.equal((await discoverBrowser(port)).available, false);
});

function fakeChrome() {
  let launches = 0;
  let closedContext = 0;
  let disconnected = 0;
  const page = Object.assign(new EventEmitter(), { isClosed: () => false, addInitScript: async () => {}, opener: async () => null });
  const original = { isClosed: () => false };
  const context = Object.assign(new EventEmitter(), {
    pages: () => [original, page], newPage: async () => page,
    close: async () => { closedContext++; context.emit('close'); },
  });
  const browser = Object.assign(new EventEmitter(), {
    contexts: () => [context], close: async () => { disconnected++; browser.emit('disconnected'); },
  });
  const chromium = {
    connectOverCDP: async () => browser,
    launchPersistentContext: async () => { launches++; return context; },
  };
  // Persistent profile mocks start at the supplied page as a real Chrome does.
  original.addInitScript = async () => {};
  return { chromium, browser, context, page, original, stats: () => ({ launches, closedContext, disconnected }) };
}

test('连接用户浏览器新建任务页，快照只含任务页，关闭只断开连接', async () => {
  const f = fakeChrome();
  const session = await openBrowser({ chromium: f.chromium, browserMode: 'auto', discover: async () => ({ available: true, endpoint: 'test' }), log: () => {} });
  assert.equal(session.page, f.page);
  assert.equal(session.attached, true);
  assert.deepEqual(session.pages(), [f.page]);
  const unrelated = { opener: async () => null, isClosed: () => false };
  const popup = { opener: async () => f.page, isClosed: () => false };
  f.context.emit('page', unrelated); f.context.emit('page', popup);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(session.pages(), [f.page, popup]);
  await Promise.all([session.close(), session.close()]);
  assert.deepEqual(f.stats(), { launches: 0, closedContext: 0, disconnected: 1 });
});

test('条件不满足只在启动阶段回退一次，连接中断不会重开浏览器', async () => {
  for (const failure of ['unavailable', 'connect', 'page']) {
    const f = fakeChrome();
    if (failure === 'connect') f.chromium.connectOverCDP = async () => { throw new Error('private error'); };
    if (failure === 'page') f.context.newPage = async () => { throw new Error('page error'); };
    const logs = [];
    const session = await openBrowser({ chromium: f.chromium, profileDir: '/mock', browserMode: 'auto', discover: async () => ({ available: failure !== 'unavailable', endpoint: 'test', reason: '调试不可用' }), log: (value) => logs.push(value) });
    assert.equal(session.attached, false);
    assert.equal(f.stats().launches, 1);
    assert.match(logs.join('\n'), /回退/);
    assert.doesNotMatch(logs.join('\n'), /private error|page error/);
    await session.close();
    assert.equal(f.stats().closedContext, 1);
  }
  const f = fakeChrome();
  const session = await openBrowser({ chromium: f.chromium, browserMode: 'auto', discover: async () => ({ available: true }), log: () => {} });
  f.browser.emit('disconnected');
  assert.equal(f.stats().launches, 0);
  await session.close();
});

test('独立方式保持原路径，显式 CDP 连接失败仍报错', async () => {
  const f = fakeChrome();
  const session = await openBrowser({ chromium: f.chromium, profileDir: '/mock', log: () => {}, discover: () => { throw new Error('不能探测'); } });
  assert.equal(session.attached, false);
  await session.close();
  assert.equal(f.stats().closedContext, 1);
  f.chromium.connectOverCDP = async () => { throw new Error('explicit CDP failure'); };
  await assert.rejects(openBrowser({ chromium: f.chromium, cdp: 'http://127.0.0.1:9222', log: () => {} }), /explicit CDP failure/);
  assert.equal(f.stats().launches, 1);
});

test('启动期间收到停止信号，等待浏览器清理后退出且不开始业务', { timeout: 5000 }, async (t) => {
  const { spawn } = require('node:child_process');
  const modulePath = require.resolve('./browser-session');
  const code = `
    const { EventEmitter } = require('node:events');
    const { openTaskBrowser } = require(${JSON.stringify(modulePath)});
    const page = { addInitScript: async () => {} };
    const context = Object.assign(new EventEmitter(), {
      pages: () => [page], close: async () => console.log('CLEANED')
    });
    openTaskBrowser({chromium: {launchPersistentContext: async () => {
      console.log('LAUNCHING');
      await new Promise(r => setTimeout(r, 200));
      return context;
    }}, profileDir: '/mock', log: () => {}}).then(() => console.log('BUSINESS_STARTED'));
  `;
  const child = spawn(process.execPath, ['-e', code]);
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = '';
  const ready = new Promise((resolve) => child.stdout.on('data', (chunk) => { output += chunk; if (output.includes('LAUNCHING')) resolve(); }));
  const closed = once(child, 'close');
  await ready;
  child.kill('SIGTERM');
  const [exitCode] = await closed;
  assert.equal(exitCode, 143);
  assert.match(output, /CLEANED/);
  assert.doesNotMatch(output, /BUSINESS_STARTED/);
});
