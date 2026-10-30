#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');

const ORIGIN = 'https://seller.kuajingmaihuo.com';

async function firstVisible(locator) {
  for (let i = 0; i < await locator.count(); i++) {
    const item = locator.nth(i);
    if (await item.isVisible() && await item.isEnabled()) return item;
  }
  return null;
}

// One attempt only: a rejected password or a verification prompt is left to the user.
// Never log Playwright fill errors: their call logs can contain the password.
async function tryFillLogin(page, credentials, origin, onStep) {
  for (const frame of page.frames()) {
    if (new URL(frame.url(), origin).origin !== origin) continue;
    // Verified on the actual seller login page: it opens in QR mode; phone
    // and email have separate tabs and different account input IDs.
    const email = credentials.username.includes('@');
    const accountId = email ? '#userEmailId' : '#usernameId';
    const tab = await firstVisible(frame.getByText(email ? '邮箱登录' : '手机号登录', { exact: true }));
    if (tab && !await firstVisible(frame.locator(accountId))) {
      onStep(email ? '切换邮箱登录' : '切换手机号登录');
      await tab.click({ timeout: 5000 });
      await frame.locator(accountId).waitFor({ state: 'visible', timeout: 5000 });
    }
    let password = await firstVisible(frame.locator('input[type="password"]'));
    if (!password) {
      const switcher = await firstVisible(frame.getByText(/^(账号密码登录|密码登录|使用密码登录|账号登录)$/));
      if (switcher) {
        await switcher.click({ timeout: 3000 });
        await frame.locator('input[type="password"]').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        password = await firstVisible(frame.locator('input[type="password"]'));
      }
    }
    if (!password) continue;
    const account = await firstVisible(frame.locator(accountId)) || await firstVisible(frame.getByPlaceholder(/账号|账户|手机|邮箱|用户名/)) ||
      await firstVisible(frame.locator('input[autocomplete="username"], input[name="username"], input[name="account"], input[type="tel"], input[type="email"]'));
    if (!account) continue;
    onStep('填写账号');
    await account.fill(credentials.username, { timeout: 5000 });
    onStep('填写密码');
    await password.fill(credentials.password, { timeout: 5000 });
    const agreement = frame.locator('input[type="checkbox"]').first();
    if (await agreement.count() && !await agreement.isChecked()) {
      if (!credentials.acceptAgreement) return 'agreement-required';
      onStep('勾选登录协议');
      // The visible square covers the native input. The label also contains
      // agreement links, so its complete text is longer than this phrase.
      const square = await firstVisible(frame.locator('[data-testid="beast-core-checkbox-checkIcon"]').filter({ has: agreement }));
      const label = await firstVisible(frame.getByText('我已阅读并同意', { exact: false }));
      if (square) await square.click({ timeout: 5000 });
      else if (label) await label.click({ timeout: 5000, position: { x: 4, y: 4 } });
      else await agreement.check({ timeout: 5000 });
      if (!await agreement.isChecked()) return 'agreement-required';
    }
    const submit = await firstVisible(frame.getByRole('button', { name: /^登\s*录$/ })) ||
      await firstVisible(frame.locator('button[type="submit"], input[type="submit"]'));
    if (!submit) return 'filled';
    onStep('提交登录');
    await submit.click({ timeout: 5000 });
    return 'submitted';
  }
  return 'manual';
}

async function fillLogin(page, credentials, origin = ORIGIN, timeout = 15000, onStep = () => {}) {
  const deadline = Date.now() + timeout;
  do {
    const result = await tryFillLogin(page, credentials, origin, onStep);
    if (result !== 'manual') return result;
    // The login form is commonly rendered by the SPA after DOMContentLoaded.
    if (Date.now() >= deadline) return 'manual';
    await page.waitForTimeout(250);
  } while (!page.isClosed());
  return 'manual';
}

async function isLoggedIn(page) {
  if (page.isClosed() || !page.url().startsWith(`${ORIGIN}/main/`)) return false;
  if (await firstVisible(page.locator('input[type="password"]'))) return false;
  return Boolean(await firstVisible(page.getByText(/^(发货台|发货单列表|创建发货单|退出登录|切换店铺)$/)));
}

async function captureLoginPage(page, directory, name) {
  await fs.mkdir(directory, { recursive: true });
  const filename = `login-${name}-${Date.now()}`;
  const fields = await page.locator('input').evaluateAll((nodes) => nodes.map((node) => ({
    id: node.id, name: node.name, type: node.type, placeholder: node.placeholder,
    disabled: node.disabled, checked: node.type === 'checkbox' ? node.checked : undefined,
  })));
  const texts = await page.locator('button').allTextContents();
  await page.screenshot({ path: path.join(directory, `${filename}.png`), fullPage: true, mask: [page.locator('input')] });
  await fs.writeFile(path.join(directory, `${filename}.json`), JSON.stringify({ url: page.url(), capturedAt: new Date().toISOString(), fields, buttons: texts }, null, 2));
  return filename;
}

async function openSession({ chromium, profileDir, credentials, probe = false, log = console.log, onSaved = () => {}, onRequired = () => {} }) {
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome', headless: false, viewport: null,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
    slowMo: 120,
  });
  const closed = new Promise((resolve) => context.once('close', resolve));
  // Keep the session alive even if initialization, navigation or login fails.
  // It only ends when Chrome closes or the parent explicitly stops this process.
  const keepAlive = setInterval(() => {}, 60000);
  let timer;
  context.once('close', () => { clearInterval(keepAlive); clearInterval(timer); });
  const watchPage = (page) => page.once('close', () => {
    if (!context.pages().length) context.close().catch(() => {});
  });
  context.pages().forEach(watchPage);
  context.on('page', watchPage);
  const prepare = async () => {
    const page = context.pages()[0] || await context.newPage();
    let stage = '打开页面';
    try {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      await page.goto(probe ? `${ORIGIN}/login` : `${ORIGIN}/main/order-manager/shipping-desk`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (probe) {
        const directory = path.join(__dirname, 'shots');
        await page.getByText('手机号登录', { exact: true }).waitFor({ state: 'visible', timeout: 20000 });
        for (const [name, tab] of [['qr', null], ['phone', '手机号登录'], ['email', '邮箱登录']]) {
          if (tab) await page.getByText(tab, { exact: true }).click();
          log(`登录页面快照已保存：${await captureLoginPage(page, directory, name)}`);
        }
        log('快照完成，Chrome 保持打开；请关闭窗口或手动停止。');
        return;
      }
      if (credentials.username) {
        // An existing valid session needs no login attempt.
        stage = '识别登录表单';
        const result = await isLoggedIn(page) ? 'saved' : await fillLogin(page, credentials, ORIGIN, 15000, (value) => { stage = value; });
        log({ saved: '已复用登录状态。', submitted: '已自动切换登录方式、填写账号密码并提交登录；如出现验证码，请在 Chrome 中完成。', filled: '已填写账号密码，请在 Chrome 中确认登录。', 'agreement-required': '请先在 Chrome 中阅读并同意登录协议，再确认登录；或停止后在控制台授权自动勾选。', manual: '未找到账号密码表单，请在 Chrome 中手动继续。' }[result]);
      } else log('已打开页面并复用浏览器登录信息；若登录已失效，请在 Chrome 中重新登录。');
    } catch (error) {
      if (!context.pages().length) return;
      // Raw Playwright errors can include the password passed to fill().
      log(`自动登录未完成：${stage}${error.name === 'TimeoutError' ? '超时' : '失败'}。Chrome 保持打开，可手动继续或停止后重试。`);
    } finally {
      credentials.username = '';
      credentials.password = '';
    }
    log('前置准备会话已就绪：可手动完成登录、选择店铺等操作。完成后请关闭 Chrome 或点击「停止准备」，再运行后续脚本。');
    let checking = false;
    let saved = false;
    let required = false;
    const check = async () => {
      if (checking || saved) return;
      checking = true;
      try {
        for (const candidate of context.pages()) {
          if (!await isLoggedIn(candidate)) {
            if (!required && candidate.url().startsWith(`${ORIGIN}/login`)) {
              required = true;
              await fs.rm(path.join(profileDir, '.login-state.json'), { force: true });
              onRequired();
            }
            continue;
          }
          await fs.writeFile(path.join(profileDir, '.login-state.json'), JSON.stringify({ savedAt: new Date().toISOString() }), { mode: 0o600 });
          saved = true;
          log('登录状态已保存在本机，后续可直接打开页面。');
          onSaved();
          clearInterval(timer);
          break;
        }
      } catch { /* Navigation and closed tabs are normal during manual preparation. */ }
      finally { checking = false; }
    };
    if (context.pages().length) {
      timer = setInterval(check, 2000);
      await check();
    }
  };
  return { context, closed, prepare };
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== '--probe')) throw new Error('未知参数');
  const { chromium } = require('../shipping-auto/node_modules/playwright-core');
  let session;
  let launching;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    // A stop during Chrome startup must also close the window once it launches.
    if (launching) session = await launching.catch(() => null);
    if (session) await session.context.close().catch(() => {});
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.once('disconnect', stop);
  let credentials = { username: '', password: '' };
  if (process.send) {
    const received = once(process, 'message');
    process.send({ type: 'login-input-ready' });
    const [message] = await received;
    if (message?.type !== 'login-credentials' || typeof message.username !== 'string' || typeof message.password !== 'string') throw new Error('登录信息格式错误');
    credentials = { username: message.username, password: message.password, acceptAgreement: message.acceptAgreement === true };
  }
  const profileDir = path.resolve(__dirname, '../shipping-auto/.pw-profile');
  console.log(`启动独立 Chrome（配置目录 ${profileDir}），与创建发货单和装箱发货共用登录状态。`);
  launching = openSession({ chromium, profileDir, credentials, probe: process.argv.includes('--probe'), onSaved: () => process.send?.({ type: 'login-saved' }), onRequired: () => process.send?.({ type: 'login-required' }) });
  session = await launching;
  if (stopping) return;
  session.closed.then(() => process.exit(0));
  await session.prepare();
  await session.closed;
}

if (require.main === module) main().catch(() => {
  console.error('无法启动登录准备会话，请确认 Chrome 已安装、依赖已安装，且没有其他窗口占用该登录配置。');
  process.exit(1);
});

module.exports = { fillLogin, openSession, captureLoginPage };
