'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function capturePages(context, directory) {
  await fs.mkdir(directory, { recursive: true });
  const prefix = `manual-${Date.now()}-${randomUUID()}`;
  const pages = context.pages().filter((page) => !page.isClosed());
  if (!pages.length) throw new Error('浏览器中没有可抓取的页面');
  const files = [];
  for (const [index, page] of pages.entries()) {
    const name = `${prefix}-${index + 1}`;
    const frames = [];
    for (const frame of page.frames()) {
      frames.push({ url: frame.url(), html: await frame.content() });
    }
    await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true, timeout: 15000 });
    await fs.writeFile(path.join(directory, `${name}.json`), JSON.stringify({ capturedAt: new Date().toISOString(), url: page.url(), frames }, null, 2));
    files.push(`${name}.png`);
  }
  return files;
}

async function main() {
  const { chromium } = require('../shipping-auto/node_modules/playwright-core');
  const task = process.argv[2];
  if (!['shipping', 'packing'].includes(task)) throw new Error('未知流程');
  const root = path.resolve(__dirname, '..');
  const profile = 'shipping';
  const context = await chromium.launchPersistentContext(path.join(root, `${profile}-auto`, '.pw-profile'), {
    channel: 'chrome', headless: false, viewport: null,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
  });
  const stop = async () => { await context.close().catch(() => {}); process.exit(0); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.once('disconnect', stop);
  context.on('close', () => process.exit(0));
  const page = context.pages()[0] || await context.newPage();
  await page.goto(`https://seller.kuajingmaihuo.com/main/order-manager/${task === 'shipping' ? 'shipping-desk' : 'shipping-list'}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  let busy = false;
  process.on('message', async (message) => {
    if (message.type !== 'snapshot' || busy) return;
    busy = true;
    try {
      const files = await capturePages(context, path.join(root, `${task}-auto`, 'shots'));
      console.log(`主动快照已保存：${files.join('、')}（同名 JSON 包含各 frame 的 DOM）`);
      process.send?.({ type: 'snapshot-result', id: message.id, files });
    } catch (error) {
      process.send?.({ type: 'snapshot-result', id: message.id, error: error.message });
    } finally { busy = false; }
  });
  console.log('主动快照已就绪：请在 Chrome 中手动操作，每一步渲染完成后点击「抓取当前页面」。');
  process.send?.({ type: 'snapshot-ready' });
}

if (require.main === module) main().catch((error) => { console.error(error); process.exit(1); });
module.exports = { capturePages };
