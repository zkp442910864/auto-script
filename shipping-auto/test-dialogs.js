/**
 * 弹窗按钮选择测试：按截图里的真实文案造两个浮层样本，
 * 验证 locateFloatingButton 会不会点错按钮（尤其别点到"取消"那个）。
 * 用法：node test-dialogs.js
 */
const { chromium } = require('playwright-core');
const { CFG } = require('./index.js');

const MODAL_HTML = `
<!doctype html><html><body>
<div class="modal-mask_5-117-0" style="position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.45)">
  <div class="modal-content_5-117-0" style="position:fixed;top:20%;left:35%;width:400px;z-index:1001;background:#fff;padding:20px">
    <div class="modal-title">本次计划发货 37 件，确认批量发货吗？</div>
    <div>如下第2项核对无误？(1) 货期商城发货的备货单？(2) 用快于万快递计您...</div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button class="BTN_outerWrapper_5-111-0 BTN_gray_5-111-0 BTN_medium_5-111-0">取消并返回</button>
      <button class="BTN_outerWrapper_5-111-0 BTN_gray_5-111-0 BTN_medium_5-111-0">调整结果，去核对修改</button>
      <button class="BTN_outerWrapper_5-111-0 BTN_primary_5-111-0 BTN_medium_5-111-0">取消其他，去创建发货单</button>
    </div>
  </div>
</div></body></html>`;

const BUBBLE_HTML = `
<!doctype html><html><body>
<div class="PC_outer_5-117-0" style="position:absolute;top:60px;left:80px;width:280px;z-index:1200;background:#fff;border:1px solid #ddd">
  <div class="PC_title">相同可直发至快递员打印发货单，确认创建？</div>
  <div>要创建 1 张发货单，实际发货 2 件</div>
  <div style="display:flex;gap:8px;margin-top:12px">
    <button class="BTN_outerWrapper_5-111-0 BTN_primary_5-111-0 BTN_small_5-111-0">继续合并，已确认合并发货</button>
    <button class="BTN_outerWrapper_5-111-0 BTN_gray_5-111-0 BTN_small_5-111-0">取消创建，去核对修改</button>
  </div>
</div></body></html>`;

const EDIT_BUBBLE_HTML = `
<!doctype html><html><body>
<div class="POP_outer_5-117-0" style="position:absolute;top:200px;left:600px;width:200px;z-index:1200;background:#fff">
  <div>实际发货数（件）</div>
  <input placeholder="请输入" value="" />
  <div>不能超过该数 35</div>
  <div style="display:flex;gap:8px;margin-top:10px">
    <button class="BTN_outerWrapper_5-111-0 BTN_primary_5-111-0 BTN_small_5-111-0">确认</button>
    <button class="BTN_outerWrapper_5-111-0 BTN_gray_5-111-0 BTN_small_5-111-0">取消</button>
  </div>
</div></body></html>`;

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  // 直接复用 index.js 里的实现
  const src = require('fs').readFileSync('index.js', 'utf8');
  const fnBody = src.slice(src.indexOf('async function locateFloatingButton'), src.indexOf('/**\n * 点「创建发货单」后弹的居中确认框'));
  const findJoin = src.slice(src.indexOf('async function findJoinDialog'), src.indexOf('/** 处理「本次计划发货'));
  const factory = new Function(
    'page',
    `${fnBody}\n${findJoin}\nreturn { locateFloatingButton, findJoinDialog };`
  );

  let pass = 0;
  let fail = 0;
  const check = (name, got, expect) => {
    const ok = got === expect;
    console.log(`${ok ? '✓' : '✗'} ${name}\n    点到的按钮: ${got}\n    期望: ${expect}`);
    ok ? pass++ : fail++;
  };

  // 1) 批量发货确认弹窗
  await page.setContent(MODAL_HTML);
  const api1 = factory(page);
  const j = await api1.findJoinDialog(page);
  check('批量发货确认弹窗', j && j.label, '取消其他，去创建发货单');

  // 2) 确认创建气泡
  await page.setContent(BUBBLE_HTML);
  const api2 = factory(page);
  const b = await api2.locateFloatingButton(page, /确认创建？|确认创建\?|打印发货单/, /继续合并|确认创建|确认|确定/);
  check('确认创建气泡', b && b.label, '继续合并，已确认合并发货');

  // 3) 输入框上限提示
  await page.setContent(EDIT_BUBBLE_HTML);
  const max = await page.evaluate(() => {
    const input = document.querySelector('input');
    let n = input;
    for (let d = 0; d < 8 && n; d++) {
      const m = (n.innerText || '').match(/(?:最大不超过|不能超过|最多不超过)\s*(?:该数\s*)?(\d+)/);
      if (m) return Number(m[1]);
      n = n.parentElement;
    }
    return null;
  });
  console.log(`${max === 35 ? '✓' : '✗'} 上限提示解析\n    解析到: ${max}  期望: 35`);
  max === 35 ? pass++ : fail++;

  // 4) 确认弹窗里「确认」按钮不能选成「取消」
  await page.setContent(EDIT_BUBBLE_HTML);
  const ok = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const target = btns.filter((b) => /^确认$/.test((b.innerText || '').trim()));
    return target.length === 1 ? target[0].innerText : '多个匹配';
  });
  console.log(`${ok === '确认' ? '✓' : '✗'} 修改气泡「确认」按钮唯一匹配: ${ok}`);
  ok === '确认' ? pass++ : fail++;

  console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试脚本出错：', e);
  process.exit(1);
});
