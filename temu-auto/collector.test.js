'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SEARCH_URL, readPage, parseCard, mergeCards, collect, saveResults, advancePage } = require('./collector');
const { notificationCommand, notify } = require('./notify');

const raw = (id, extra = {}) => ({ goodsId: String(id), title: '200 张贴纸', url: `https://www.temu.com/sticker-g-${id}.html`, mainImage: 'https://img.example.test/main.jpg', rawText: '200 张贴纸\n$1.29\n4.8\n1.2K+ sold', priceText: '', ratingText: '', salesText: '', ...extra });

test('价格、评分和销量来自相应文案，未显示的值留空', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(parseCard(raw(1))).filter(([key]) => ['price', 'rating', 'sales'].includes(key))), { price: '$1.29', rating: '4.8', sales: '1.2K+ sold' });
  const missing = parseCard(raw(2, { rawText: '200 张贴纸\n原价 $9.99\n已售 2万+\n无评分', priceText: '￥ 12.90' }));
  assert.equal(missing.price, '￥ 12.90');
  assert.equal(missing.rating, null);
  assert.equal(missing.sales, '已售 2万+');
  assert.equal(parseCard(raw(3, { rawText: '2.5 inch sticker pack, 5.0 cm, $10 off coupon' })).rating, null);
  assert.equal(parseCard(raw(4, { rawText: '200 张贴纸\n原价 $9.99' })).price, null);
  assert.equal(parseCard(raw(5, { priceText: '$\n1\n.\n29' })).price, '$1.29');
});

test('商品 ID 去重、保序，后续补齐懒加载字段，严格限制 200 条', () => {
  const items = new Map();
  mergeCards(items, [raw(1, { rawText: '' }), raw(2)], 200);
  mergeCards(items, [raw(1), ...Array.from({ length: 250 }, (_, index) => raw(index + 2))], 200);
  assert.equal(items.size, 200);
  assert.deepEqual(Array.from(items.keys()).slice(0, 3), ['1', '2', '3']);
  assert.equal(items.get('1').rating, '4.8');
});

test('滚动/加载更多跨批次收集，验证期间暂停并在处理后继续', async () => {
  const items = new Map();
  let round = 0;
  let verified = false;
  let pauses = 0;
  let checkpoints = 0;
  const result = await collect({
    limit: 200, items, log: () => {}, delay: async () => {},
    inspect: async () => round === 2 && !verified ? { cards: [raw(9999)], blocked: '安全验证' } : { cards: Array.from({ length: 45 }, (_, index) => raw(round * 40 + index)), end: false },
    advance: async () => { round++; },
    pause: async (reason, automatic) => { assert.equal(automatic, true); assert.match(reason, /验证/); assert.equal(items.has('9999'), false); pauses++; verified = true; },
    checkpoint: async () => { checkpoints++; },
  });
  assert.equal(result.status, 'complete');
  assert.equal(items.size, 200);
  assert.equal(pauses, 1);
  assert.ok(checkpoints >= 5);
  assert.deepEqual(Array.from(items.keys()), Array.from({ length: 200 }, (_, i) => String(i)));
});

test('结果不足、加载停滞和用户停止均保留真实数量', async () => {
  const partial = await collect({ inspect: async () => ({ cards: [raw(1)], end: true }), advance: async () => {}, checkpoint: async () => {}, pause: async () => assert.fail('不应等待'), log: () => {}, delay: async () => {} });
  assert.equal(partial.status, 'partial');
  let stopped = false;
  let paused = false;
  const items = new Map();
  const stoppedResult = await collect({ items, inspect: async () => ({ cards: [raw(1)], end: false }), stopped: () => stopped, advance: async () => {}, checkpoint: async () => {}, pause: async (_, automatic) => { assert.equal(automatic, false); paused = true; stopped = true; }, log: () => {}, delay: async () => {} });
  assert.equal(paused, true);
  assert.equal(stoppedResult.status, 'stopped');
  assert.equal(items.size, 1);
});

test('JSON/CSV 持续落盘，保留原始值和缺失统计，并处理 CSV 特殊字符', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'temu-output-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const items = new Map();
  mergeCards(items, [raw(1, { title: '=HYPERLINK("x")\n贴纸', rawText: '' })], 200);
  await saveResults(dir, 'temu-test', items, { sourceUrl: SEARCH_URL, status: 'collecting', target: 200 });
  mergeCards(items, [raw(2)], 200);
  await saveResults(dir, 'temu-test', items, { sourceUrl: SEARCH_URL, status: 'stopped', target: 200 });
  const payload = JSON.parse(await fs.readFile(path.join(dir, 'temu-test.json'), 'utf8'));
  assert.equal(payload.count, 2);
  assert.equal(payload.status, 'stopped');
  assert.equal(payload.missing.rating, 1);
  const csv = await fs.readFile(path.join(dir, 'temu-test.csv'), 'utf8');
  assert.ok(csv.startsWith('\ufeff'));
  assert.ok(csv.includes('"\'=HYPERLINK(""x"")\n贴纸"'));
  assert.deepEqual((await fs.readdir(dir)).sort(), ['temu-test.csv', 'temu-test.json']);
});

test('Win/mac 通知通过参数数组调用，Windows 编码保留中文和 XML 转义，通知失败不阻断采集', async () => {
  const mac = notificationCommand('darwin', 'Temu "验证"', '请处理\\验证\n');
  assert.equal(mac.file, 'osascript');
  assert.match(mac.args[1], /display notification/);
  assert.ok(mac.args[1].includes('\\"验证\\"'));
  const win = notificationCommand('win32', '验证 <&>', '中文 "登录"');
  assert.equal(win.file, 'powershell.exe');
  const script = Buffer.from(win.args.at(-1), 'base64').toString('utf16le');
  const xml = Buffer.from(script.match(/FromBase64String\('([^']+)'\)/)[1], 'base64').toString('utf8');
  assert.ok(xml.includes('验证 &lt;&amp;&gt;'));
  assert.ok(xml.includes('中文 &quot;登录&quot;'));
  assert.equal(await notify('t', 'm', { platform: 'darwin', execute: (_file, _args, _options, done) => done(null) }), true);
});

test('真实浏览器本地夹具：滚动加载、重复链接、加载更多、验证覆盖层和字段提取', async (t) => {
  let chromium;
  try { ({ chromium } = require('playwright-core')); }
  catch { ({ chromium } = require('../shipping-auto/node_modules/playwright-core')); }
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.route('https://img.example.test/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>' }));
  await page.setContent(`<!doctype html><style>article{height:100px}img{width:80px;height:80px}#grid{display:grid;grid-template-columns:repeat(5,1fr)}</style><main><div id="grid"></div><button id="more" hidden>加载更多</button></main><script>
    let total=0;
    function append(){let start=total;for(let id=start;id<start+40;id++){let a=document.createElement('article');a.innerHTML='<a href="https://www.temu.com/item-g-'+id+'.html"><img alt="贴纸 200 张" src="https://img.example.test/'+id+'.svg"></a><a href="https://www.temu.com/goods.html?goods_id='+id+'">商品详情</a><div data-testid="product-price">$1.29</div><div aria-label="4.8 out of 5 stars"></div><div data-testid="sales-count">1.2K+ sold</div>';document.getElementById('grid').append(a);}total+=40;document.getElementById('more').hidden=total===40 || total>=240;}
    append();
    window.addEventListener('scroll',()=>{if(total===40 && innerHeight+scrollY>=document.documentElement.scrollHeight-10)append();});
    document.getElementById('more').onclick=append;
  </script>`);
  await page.locator('img').first().waitFor();
  const initial = await page.evaluate(readPage);
  assert.equal(initial.cards.length, 40);
  assert.equal(initial.blocked, null);
  const first = parseCard(initial.cards[0]);
  assert.equal(first.price, '$1.29');
  assert.equal(first.rating, '4.8');
  assert.equal(first.sales, '1.2K+ sold');
  assert.equal(first.mainImage, 'https://img.example.test/0.svg');
  await page.locator('article').first().evaluate((node) => { const oldPrice = document.createElement('div'); oldPrice.dataset.testid = 'original-price'; oldPrice.textContent = '$9.99'; node.prepend(oldPrice); });
  assert.equal(parseCard((await page.evaluate(readPage)).cards[0]).price, '$1.29');
  await page.evaluate(() => { const dialog = document.createElement('div'); dialog.id = 'captcha'; dialog.setAttribute('role', 'dialog'); dialog.textContent = '请完成安全验证'; document.body.append(dialog); });
  assert.match((await page.evaluate(readPage)).blocked, /验证/);
  await page.locator('#captcha').evaluate((node) => node.remove());
  const items = new Map();
  let scrolls = 0;
  let clicks = 0;
  const result = await collect({ page, items, pause: async (reason) => assert.fail(reason), checkpoint: async () => {}, log: () => {}, interval: 15, advance: async () => { const type = await advancePage(page); if (type === 'more') clicks++; else scrolls++; } });
  assert.equal(result.status, 'complete');
  assert.equal(items.size, 200);
  assert.ok(scrolls > 0);
  assert.ok(clicks >= 3);
  assert.equal(Array.from(items.keys()).at(-1), '199');
});
