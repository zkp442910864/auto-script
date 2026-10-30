'use strict';

const http = require('node:http');

function browserOptions(options = {}) {
  const browserMode = options.browserMode ?? 'profile';
  const browserPort = options.browserPort ?? 9222;
  if (!['auto', 'profile'].includes(browserMode)) throw new Error('未知浏览器方式');
  if (!Number.isSafeInteger(browserPort) || browserPort < 1024 || browserPort > 65535) throw new Error('调试端口必须是 1024–65535 的整数');
  return { browserMode, browserPort };
}

function runtimeOptions() {
  const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  return browserOptions({ browserMode: flag('browser') ?? process.env.AUTO_BROWSER_MODE, browserPort: Number(flag('browser-port') ?? process.env.AUTO_BROWSER_PORT ?? 9222) });
}

// Only inspect the explicitly selected loopback port. Never follow redirects or
// trust an advertised websocket pointing at another host/service.
function discoverBrowser(port = 9222) {
  browserOptions({ browserPort: port });
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    const request = http.get({ hostname: '127.0.0.1', port, path: '/json/version' }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('error', () => finish({ available: false, reason: '调试端口响应中断' }));
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 16384) { finish({ available: false, reason: '调试端口响应无效' }); response.destroy(); }
      });
      response.on('end', () => {
        try {
          const data = JSON.parse(body);
          const endpoint = new URL(data.webSocketDebuggerUrl);
          if (response.statusCode !== 200 || !/Chrome|Chromium|Edg\//.test(data.Browser) || endpoint.protocol !== 'ws:' ||
              !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || Number(endpoint.port) !== port ||
              endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^\/devtools\/browser\/[\w-]+$/.test(endpoint.pathname)) throw new Error();
          endpoint.hostname = '127.0.0.1';
          finish({ available: true, endpoint: endpoint.href });
        } catch { finish({ available: false, reason: '该端口不是可连接的 Chrome 调试服务' }); }
      });
    });
    const timer = setTimeout(() => { finish({ available: false, reason: '连接调试端口超时' }); request.destroy(); }, 1500);
    request.on('error', () => finish({ available: false, reason: '未检测到已开启调试端口的 Chrome' }));
  });
}

async function openBrowser({ chromium, profileDir, slowMo = 120, cdp = '', browserMode = 'profile', browserPort = 9222, log = console.log, discover = discoverBrowser }) {
  browserOptions({ browserMode, browserPort });
  let browser;
  let context;
  let page;
  let fallbackReason = '';
  if (cdp || browserMode === 'auto') {
    const found = cdp ? { available: true, endpoint: cdp } : await discover(browserPort);
    if (found.available) {
      try {
        browser = await chromium.connectOverCDP(found.endpoint, { timeout: 4000, slowMo });
        context = browser.contexts()[0];
        if (!context) throw new Error('No default context');
        // Use the existing profile's cookies without navigating an unrelated tab.
        page = await context.newPage();
      } catch (error) {
        await browser?.close().catch(() => {});
        browser = null;
        if (cdp) throw error;
        fallbackReason = 'Chrome 连接或新建任务标签页失败';
      }
    } else fallbackReason = found.reason;
    if (fallbackReason) log(`用户浏览器不可用：${fallbackReason}；回退到原来的独立 Chrome。`);
  }
  const attached = Boolean(browser);
  if (!attached) {
    log('启动独立 Chrome，使用原来的共享登录配置。');
    context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chrome', headless: false, viewport: null,
      args: ['--start-maximized', '--disable-blink-features=AutomationControlled'], slowMo,
    });
    page = context.pages()[0] || await context.newPage();
    await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  } else log('已连接用户浏览器：复用登录状态，在新标签页中操作。结束时仅断开连接，保留浏览器和标签页。');

  // Track only task pages/popups when attached, so snapshots and login checks
  // cannot include unrelated tabs in the user's browser.
  const taskPages = new Set([page]);
  const watchPage = async (candidate) => {
    try { if (taskPages.has(await candidate.opener())) taskPages.add(candidate); } catch {}
  };
  if (attached) context.on('page', watchPage);
  let closing;
  const close = () => {
    if (!closing) {
      context.removeListener('page', watchPage);
      // With connectOverCDP, browser.close disconnects the transport. Never
      // close the user's default context (that would close their other tabs).
      closing = Promise.resolve().then(() => attached ? browser.close() : context.close()).catch(() => {});
    }
    return closing;
  };
  const info = { mode: attached ? 'attached' : 'profile', fallbackReason };
  process.send?.({ type: 'browser-session', ...info });
  return { context, page, browser, attached, close, info, pages: () => attached ? [...taskPages].filter((item) => !item.isClosed()) : context.pages() };
}

// Install termination handlers before the first startup await. A stop during
// CDP discovery/Chrome launch must wait for ownership-aware cleanup as well.
async function openTaskBrowser(options) {
  let stopping = false;
  const opening = openBrowser(options);
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const session = await opening.catch(() => null);
    await session?.close();
    process.exit(143);
  };
  const remove = () => {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    process.removeListener('disconnect', stop);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  if (process.send) process.once('disconnect', stop);
  try {
    const session = await opening;
    const close = session.close;
    session.close = () => { remove(); return close(); };
    if (stopping) return await new Promise(() => {}); // stop() owns cleanup and exit
    return session;
  } catch (error) { remove(); throw error; }
}

module.exports = { browserOptions, runtimeOptions, discoverBrowser, openBrowser, openTaskBrowser };
