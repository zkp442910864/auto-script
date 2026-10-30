'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { chromium } = require('../shipping-auto/node_modules/playwright-core');
const { openBrowser, discoverBrowser } = require('./browser-session');
const { openSession } = require('../login-auto');
const { createApp } = require('../web/server');

test('真实 Chrome CDP 复用 cookie，结束/停止准备后原窗口与其他标签页仍可用', { timeout: 15000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-browser-integration-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const owned = await chromium.launchPersistentContext(directory, { channel: 'chrome', headless: true, args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] });
  t.after(() => owned.close());
  const port = Number((await fs.readFile(path.join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
  assert.equal((await discoverBrowser(port)).available, true);
  const original = owned.pages()[0];
  await original.setContent('<h1>用户原来的标签页</h1>');
  await owned.addCookies([{ name: 'session-test', value: 'local-cookie', domain: '127.0.0.1', path: '/' }]);
  const session = await openBrowser({ chromium, profileDir: '/must-not-launch', browserMode: 'auto', browserPort: port, log: () => {} });
  assert.equal(session.attached, true);
  assert.notEqual(session.page, session.context.pages()[0]);
  assert.equal((await session.context.cookies()).find((cookie) => cookie.name === 'session-test').value, 'local-cookie');
  await session.page.setContent('<p>本次任务页面</p>');
  assert.equal(session.pages().length, 1);
  await session.close();
  assert.equal(await original.locator('h1').textContent(), '用户原来的标签页');
  assert.equal(owned.pages().length, 2);
  assert.equal(await owned.pages()[1].locator('p').textContent(), '本次任务页面');

  const login = await openSession({ chromium, profileDir: '/must-not-write', browserMode: 'auto', browserPort: port, credentials: { username: '', password: '' }, log: () => {} });
  await login.close();
  await login.closed;
  assert.equal(await original.locator('h1').textContent(), '用户原来的标签页');
  // Closing only the preparation tab must also release its session.
  const second = await openSession({ chromium, profileDir: '/must-not-write', browserMode: 'auto', browserPort: port, credentials: { username: '', password: '' }, log: () => {} });
  await second.page.close();
  await second.closed;
  await second.close();
  assert.equal(await original.locator('h1').textContent(), '用户原来的标签页');
});

test('Web 页面展示步骤、保存设置、同步实际浏览器方式，保持移动端可用', { timeout: 15000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-ui-integration-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let call;
  const app = createApp({ profileRoot: directory, runDir: directory, spawnProcess: (exe, args, options) => {
    call = options;
    return spawn(process.execPath, ['-e', `process.send({type:'browser-session',mode:'attached'}); console.log('LOCAL_MOCK_ONLY'); setTimeout(()=>{},1500);`], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.shutdown());
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${app.server.address().port}`);
  await page.waitForFunction(() => document.querySelector('#connection-text').textContent === '服务已连接');
  assert.equal(await page.locator('#browser-mode').inputValue(), 'auto');
  await page.locator('.browser-guide summary').click();
  assert.match(await page.locator('.browser-guide').textContent(), /失败时|连接失败/);
  await page.locator('#browser-port').fill('9333');
  assert.match(await page.locator('#browser-command-mac').textContent(), /--remote-debugging-port=9333/);
  await page.reload();
  assert.equal(await page.locator('#browser-port').inputValue(), '9333');
  await page.locator('[data-task="shipping"] [data-mode="probe"]').click();
  await page.waitForFunction(() => document.querySelector('#browser-run').textContent.includes('使用用户浏览器'));
  assert.equal(call.env.AUTO_BROWSER_MODE, 'auto');
  assert.equal(call.env.AUTO_BROWSER_PORT, '9333');
  assert.equal(await page.locator('#browser-mode').isDisabled(), true);
  await page.locator('#stop').click();
  await page.waitForFunction(() => !document.querySelector('#browser-mode').disabled);
  await page.locator('#browser-mode').selectOption('profile');
  assert.equal(await page.locator('#browser-port').isDisabled(), true);
  assert.equal(await page.locator('#login-username').getAttribute('required'), '');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});
