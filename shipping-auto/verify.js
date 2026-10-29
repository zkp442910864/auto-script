/**
 * 离线验证：把 probe.html 当静态页面加载，检查选择器能否正确抓到
 *   - 每行的 修改 按钮 / 备货单号 / 收货仓库
 *   - 行是否被判为「可点」
 *   - 创建发货单 按钮及其禁用状态
 * 用法：node verify.js [html路径]
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const M = require('./index.js');

const htmlPath = process.argv[2] || path.join(__dirname, 'shots', 'probe.html');

/** 快照里带 script 会让页面自己重渲染把 DOM 冲掉，剥掉再加载 */
function makeStatic(src, dst) {
  const html = fs.readFileSync(src, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, '');
  fs.writeFileSync(dst, html, 'utf8');
  return dst;
}

(async () => {
  const staticPath = makeStatic(htmlPath, path.join(path.dirname(htmlPath), 'probe-static.html'));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.goto('file:///' + staticPath.replace(/\\/g, '/'), {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(500);
  console.log('tr 行数：', await page.evaluate(() => document.querySelectorAll('tr').length));
  console.log();

  console.log('=== 抓到的「修改」按钮 ===');
  const targets = await M.collectEditTargets(page);
  console.log('数量：', targets.length);
  for (const t of targets) {
    const ok = await M.isInteractable(t.el);
    console.log(
      `  #${t.index + 1} 可点=${ok ? "是" : "否"}  单号=${t.order}  SKU=${t.sku}  仓库=${t.warehouse}`
    );
  }

  const whs = [...new Set(targets.map((t) => t.warehouse).filter(Boolean))];
  console.log('\n仓库分组：', whs.join(' | '));
  console.log('每个仓库行数：');
  for (const w of whs) {
    console.log(`  ${w}: ${targets.filter((t) => t.warehouse === w).length} 行`);
  }

  console.log('\n=== 创建发货单按钮 ===');
  const btn = await M.findCreateButton(page);
  console.log(btn ? `找到，disabled=${btn.disabled}` : '没找到');

  console.log('\n=== 写入测试：模拟第一行被锁 ===');
  // 给第 1 行之后的按钮加上禁用类，看过滤是否生效
  await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a')).filter(
      (a) => (a.innerText || '').trim() === '修改'
    );
    links.forEach((a, i) => {
      if (i > 0) a.className += ' BTN_disabled_5-111-0';
    });
  });
  const t2 = await M.collectEditTargets(page);
  const states = [];
  for (const t of t2) states.push(await M.isInteractable(t.el));
  console.log('加禁用类后各按钮可点状态：', states.map((s) => (s ? '可点' : '禁用')).join(', '));

  await browser.close();
})().catch((e) => {
  console.error('验证脚本出错：', e);
  process.exit(1);
});
