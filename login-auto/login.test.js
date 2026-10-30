'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { chromium } = require('../shipping-auto/node_modules/playwright-core');
const { fillLogin } = require('./index');

// Local replica of the observed seller login controls. No external requests,
// real credentials or real login submissions are made by these tests.
const html = `<!doctype html><meta charset="utf-8">
<div id="root"></div><script>
window.submissions = [];
function show(mode) {
  document.querySelector('#form').innerHTML = '<input id="' + (mode === 'email' ? 'userEmailId' : 'usernameId') +
    '" placeholder="' + (mode === 'email' ? '仅支持子账号邮箱登录' : '请输入手机号') +
    '"><input id="passwordId" type="password" placeholder="请输入密码">' +
    '<label data-testid="beast-core-checkbox"><span data-testid="beast-core-checkbox-checkIcon" style="display:inline-block;position:relative;width:18px;height:18px">' +
    '<input type="checkbox" style="position:absolute;inset:0;margin:0;opacity:0">' +
    '<i style="position:absolute;inset:0;border:1px solid #777;background:white"></i></span>' +
    '<span>我已阅读并同意<a href="#account"><span>《账号使用须知》</span></a><a href="#privacy"><span>《隐私政策》</span></a></span></label><button>登录</button>';
}
function render() {
  document.querySelector('#root').innerHTML = '<button data-mode="qr">扫码登录</button>' +
    '<button data-mode="phone">手机号登录</button><button data-mode="email">邮箱登录</button>' +
    '<form id="form">扫码区域</form>';
  document.querySelectorAll('[data-mode]').forEach(button => button.onclick = () => show(button.dataset.mode));
  document.querySelector('#form').onsubmit = event => {
    event.preventDefault();
    if (!document.querySelector('input[type=checkbox]').checked) return;
    window.submissions.push({account: document.querySelector('#usernameId, #userEmailId').value, password: document.querySelector('#passwordId').value});
  };
}
if (location.search) setTimeout(render, 300); else render();
</script>`;

let browser;
let server;
let origin;
before(async () => {
  server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

for (const [name, username, id] of [['手机号', '13800000000', 'usernameId'], ['邮箱', 'test@example.test', 'userEmailId']]) {
  test(`${name}自动从扫码模式切换，填写真实字段并提交一次`, async (t) => {
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.goto(origin);
    assert.equal(await page.locator('input[type="password"]').count(), 0);
    const result = await fillLogin(page, { username, password: 'local-test-password', acceptAgreement: true }, origin, 2000);
    assert.equal(result, 'submitted');
    assert.equal(await page.locator(`#${id}`).inputValue(), username);
    assert.equal(await page.locator('input[type="checkbox"]').isChecked(), true);
    assert.equal(await page.getByText('我已阅读并同意', { exact: true }).count(), 0);
    assert.equal(new URL(page.url()).hash, '');
    assert.deepEqual(await page.evaluate(() => window.submissions), [{ account: username, password: 'local-test-password' }]);
  });
}

test('没有用户协议授权时不勾选、不提交，保留表单', async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(origin);
  assert.equal(await fillLogin(page, { username: '13800000000', password: 'local-test-password' }, origin, 2000), 'agreement-required');
  assert.equal(await page.locator('input[type="checkbox"]').isChecked(), false);
  assert.deepEqual(await page.evaluate(() => window.submissions), []);
  assert.equal(page.isClosed(), false);
});

test('等待延迟渲染的登录入口，再切换和自动登录', async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(`${origin}/?delayed`);
  assert.equal(await fillLogin(page, { username: 'test@example.test', password: 'local-test-password', acceptAgreement: true }, origin, 2000), 'submitted');
  assert.equal((await page.evaluate(() => window.submissions)).length, 1);
});
