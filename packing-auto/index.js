#!/usr/bin/env node
/**
 * 跨境卖货 · 发货单列表（shipping-list）批量装箱发货
 * ---------------------------------------------------------------
 * 参照 shipping-auto 的思路，按下面的循环跑：
 *
 *   1) 打开发货单列表：/main/order-manager/shipping-list
 *   2) 【循环】
 *      2.1 勾选第一行（发货单号 FH 开头的那个）
 *      2.2 点工具栏「批量装箱发货」
 *          → 若弹「同仓库单一起装箱」确认框，点确认
 *      2.3 右侧抽屉「装箱发货」打开
 *          → 填「发货总箱/包数」= 1
 *          → 等仓库/物流信息加载完（物流公司 有值 + 预约取货时间 解除禁用）
 *      2.4 设「预约取货时间」= 最近可选日期（面板里第一个可点的日期格）
 *      2.5 点「确认发货」提交
 *   3) 回到 2)，直到列表没有待装箱数据
 *
 * 用法：
 *   npm run probe      # 探测：开一单抽屉，dump 表单结构 + 日期面板结构，绝不提交
 *   npm run dry        # 演练：走完流程但最后不点「确认发货」
 *   npm run auto       # 正式执行
 *
 *   参数（cmd / PowerShell / Git Bash 写法一致）：
 *   --boxes=1          发货总箱/包数，默认 1
 *   --max-rounds=200   最多处理多少单
 *   --slowmo=120       每步延迟（毫秒），页面卡就调大
 *   --profile=<dir>    Chrome 配置目录，默认 ../shipping-auto/.pw-profile
 *   --browser=auto --browser-port=9222  优先连接本机用户 Chrome，失败回退原方式
 *   --cdp=http://127.0.0.1:9222   复用已开调试端口的 Chrome
 *   --keep-open        跑完不关浏览器（默认关掉，好让脚本正常退出）
 *   --debug            详细日志
 *
 * 页面 DOM 锚点（2026-10 实测，beast design + 商家后台）：
 *   抽屉          [data-testid="beast-core-drawer"]，标题 .index-module__title-text = 「装箱发货」
 *   批量装箱发货  button[data-tracking-id="R2Lild75FOBx_5nw"]
 *   发货总箱/包数 #expressPackageNum input
 *   发货仓库      #deliveryAddressId
 *   物流公司      #expressCompanyId   (Select，未加载完时带 ST_headDisabled)
 *   预约取货日期  #expectPickUpGoodsDate input   (仓库信息没回来之前是 disabled)
 *   预约取货时间  #expectPickUpGoodsTime input   (同上)
 *   确认发货      button[data-tracking-id="KJ_BATCH_SHIP_CONFIRM_BTN"]
 *   行复选框      label[data-testid="beast-core-checkbox"][data-checked="true|false"]
 *
 * 两个实测出来的页面行为（踩过坑）：
 *   1) 物流公司的值不在 input.value 里，只是一段可见文本（input 是空的搜索框）；
 *   2) 预约取货时间是"双列滚轮"（小时列 + 分钟列，格子只有裸数字），
 *      已经过去 / 不足 1 小时的时段会带 cIL_disabled，
 *      所以"最近可选"= 每列第一个不带 disabled 的格子（≈ 当前时间 + 1 小时）。
 *
 * 设计原则（和 shipping-auto 一致）：
 *   · 一律"看页面自己的状态"，不用 sleep 猜：
 *     勾没勾上读 data-checked；仓库/物流好没好读 #expressCompanyId 的值和
 *     预约取货输入的 disabled 状态；提交成不成看抽屉关没关。
 *   · 任何一步没确认成功就停住截图，绝不硬点「确认发货」——
 *     宁可少发一单，不要发出错的单。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { openTaskBrowser, runtimeOptions } = require('../shared/browser-session');

/* ------------------------------ 命令行参数 ------------------------------ */
const ARGV = process.argv.slice(2);
const hasFlag = (n) => ARGV.includes(`--${n}`);
const flagVal = (n) => {
  const hit = ARGV.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};

const CFG = {
  url: 'https://seller.kuajingmaihuo.com/main/order-manager/shipping-list',
  boxCount: Number(flagVal('boxes') || process.env.BOXES || 1),
  profileDir: flagVal('profile') || process.env.PROFILE || path.resolve(__dirname, '../shipping-auto/.pw-profile'),
  shotDir: path.join(__dirname, 'shots'),
  maxRounds: Number(flagVal('max-rounds') || process.env.MAX_ROUNDS || 200),
  slowMo: Number(flagVal('slowmo') || process.env.SLOWMO || 120),
  cdp: flagVal('cdp') || process.env.CDP || '',
  dry: hasFlag('dry') || process.env.DRY === '1',
  debug: hasFlag('debug') || process.env.DEBUG === '1',
  probe: ARGV.includes('probe') || hasFlag('probe'),
  keepOpen: hasFlag('keep-open'),
};

/* 发货单号：FH + 数字（列表第一列） */
const FH_RE = /FH\d{8,}/;
/* 备货单号：WB + 数字（商品信息列里那个） */
const WB_RE = /WB\d{8,}/;

/* --------------------------- 页面锚点（选择器） --------------------------- */
const SEL = {
  drawer: '[data-testid="beast-core-drawer"]',
  drawerTitle: '.index-module__title-text___2lZPs',
  drawerFooter: '[class*="footer"] [data-testid="beast-core-button"]',
  confirmShip: 'button[data-tracking-id="KJ_BATCH_SHIP_CONFIRM_BTN"]',
  batchPack: 'button[data-tracking-id="R2Lild75FOBx_5nw"]',
  boxNum: '#expressPackageNum',
  warehouse: '#deliveryAddressId',
  company: '#expressCompanyId',
  pickupDate: '#expectPickUpGoodsDate',
  pickupTime: '#expectPickUpGoodsTime',
  checkbox: '[data-testid="beast-core-checkbox"]',
  deliverMethod: '#deliverMethod',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
function log(...a) {
  console.log(`[${ts()}]`, ...a);
}
function dlog(...a) {
  if (CFG.debug) console.log(`[${ts()}]   ·`, ...a);
}

/* ------------------------------- 通用工具 ------------------------------- */

/** 等页面稳定：网络空闲 + loading 遮罩消失 */
async function settle(page, extra = 350) {
  await sleep(extra);
  try {
    await page.waitForLoadState('networkidle', { timeout: 8000 });
  } catch {}
}

async function shot(page, name) {
  try {
    fs.mkdirSync(CFG.shotDir, { recursive: true });
    const p = path.join(CFG.shotDir, `${name}-${Date.now()}.png`);
    await page.screenshot({ path: p, fullPage: false });
    log(`  📷 ${p}`);
    return p;
  } catch {
    return null;
  }
}

async function firstVisible(locator) {
  const n = await locator.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = locator.nth(i);
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

/** 读页面上可见的报错/成功提示 */
async function readToast(page) {
  return page
    .evaluate(() => {
      const vis = (el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      };
      const nodes = document.querySelectorAll(
        '[class*="toast"], [class*="Toast"], [class*="message"], [class*="Message"], [class*="notice"], [class*="Notice"]'
      );
      for (const el of nodes) {
        if (!vis(el)) continue;
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (t && t.length < 160 && /超过|不能|不可|请输入|无效|错误|失败|请选择|已提交|成功|完成/.test(t)) return t;
      }
      return '';
    })
    .catch(() => '');
}

/* ------------------------------- 登录/导航 ------------------------------- */

async function ensureListPage(page) {
  log(`打开发货单列表：${CFG.url}`);
  await page.goto(CFG.url, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch((e) => log('导航异常：', e.message));
  await settle(page, 1200);

  if (/login|passport|sign/i.test(page.url())) {
    log('⚠️ 未登录，请在打开的浏览器窗口里手动完成登录（最长等 5 分钟）…');
    await page.waitForURL((u) => !/login|passport|sign/i.test(u.toString()), { timeout: 300000 });
    log('登录完成，继续。');
    await page.goto(CFG.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await settle(page, 1200);
  }
}

/* ------------------------------- 列表 & 勾选 ------------------------------- */

/**
 * 收集表格数据行：只认行文本里带「FHxxxx」的 <tr>，表头/提示行自然过滤掉。
 */
async function collectRows(page) {
  const rows = page.locator('tbody tr');
  const total = await rows.count().catch(() => 0);
  const out = [];
  for (let i = 0; i < total; i++) {
    const el = rows.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const txt = (await el.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (!txt) continue;
    const fh = (txt.match(FH_RE) || [])[0];
    if (!fh) continue;
    out.push({ el, fh, wb: (txt.match(WB_RE) || [])[0] || '', text: txt.slice(0, 260), index: out.length });
  }
  return out;
}

/** 行是否被勾选：读 beast 复选框的 data-checked */
async function rowChecked(row) {
  return row.el
    .evaluate((tr) => {
      const box = tr.querySelector('[data-testid="beast-core-checkbox"]');
      if (!box) {
        const inp = tr.querySelector('input[type="checkbox"]');
        return inp ? !!inp.checked : null;
      }
      return box.getAttribute('data-checked') === 'true';
    })
    .catch(() => null);
}

/** 点一行的复选框（点 label 最稳，input 是透明的） */
async function clickRowCheckbox(page, row) {
  const label = row.el.locator('[data-testid="beast-core-checkbox"]').first();
  if ((await label.count().catch(() => 0)) > 0) {
    await label.click({ timeout: 6000, force: true }).catch(() => {});
  } else {
    const bb = await row.el.boundingBox().catch(() => null);
    if (bb) await page.mouse.click(bb.x + 24, bb.y + bb.height / 2);
  }
  await sleep(280);
}

async function selectRow(page, row) {
  if ((await rowChecked(row)) === true) {
    dlog('该行本来就勾着');
    return true;
  }
  await clickRowCheckbox(page, row);
  let ok = (await rowChecked(row)) === true;
  if (!ok) {
    // 再点一次（有些表格点 label 会先聚焦再勾）
    await clickRowCheckbox(page, row);
    ok = (await rowChecked(row)) === true;
  }
  dlog(`勾选 ${row.fh} → ${ok ? '成功' : '失败'}`);
  return ok;
}

/** 清空所有已勾选的行（避免一次带进多张单） */
async function clearSelection(page) {
  for (let round = 0; round < 3; round++) {
    const rows = await collectRows(page);
    const checked = [];
    for (const r of rows) if ((await rowChecked(r)) === true) checked.push(r);
    if (!checked.length) return true;
    log(`  · 清空 ${checked.length} 个已勾选的行`);
    for (const r of checked) {
      await clickRowCheckbox(page, r);
      await sleep(150);
    }
  }
  const rows = await collectRows(page);
  let left = 0;
  for (const r of rows) if ((await rowChecked(r)) === true) left++;
  if (left) log(`  ⚠️ 仍有 ${left} 行勾着，请人工看一眼`);
  return left === 0;
}

/* ------------------------------- 浮层确认框 ------------------------------- */

/**
 * 「批量装箱发货」偶尔会弹同仓库提示框。
 * 判定：可见的 dialog/popover 容器、含「确认/确定」按钮、且不是抽屉本体。
 * 找不到就安静返回 false（不截图、不刷日志）——
 * 之前那版把抽屉里的「装箱发货」标题当成了提示文案，误判了一次。
 */
async function findConfirmDialog(page) {
  return page
    .evaluate(() => {
      const vis = (el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      };
      const cands = [];
      const sels = [
        '[role="dialog"]',
        '[class*="Dialog"]',
        '[class*="dialog"]',
        '[class*="Modal"]',
        '[class*="modal"]',
        '[class*="opconfirm"]',
        '[class*="Popconfirm"]',
        '[class*="Popover"]',
        '[class*="popover"]',
        '[class*="confirm"]',
      ];
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          if (!vis(el)) continue;
          if (el.querySelector('#expressPackageNum')) continue; // 抽屉本体，跳过
          if (el.closest('[data-testid="beast-core-drawer"]')) continue;
          const btns = Array.from(el.querySelectorAll('button')).filter((b) => {
            const t = (b.innerText || '').trim();
            return /^(确认|确定|继续|确认装箱|一起装箱|确认合并)/.test(t) && vis(b);
          });
          if (!btns.length) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 100 || r.height < 40) continue;
          const br = btns[0].getBoundingClientRect();
          cands.push({
            text: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
            btn: (btns[0].innerText || '').trim(),
            x: br.x + br.width / 2,
            y: br.y + br.height / 2,
          });
        }
      }
      if (!cands.length) return null;
      cands.sort((a, b) => a.text.length - b.text.length);
      return cands[0];
    })
    .catch(() => null);
}

/** 点完「批量装箱发货」后等一小会儿，有确认框就确认掉 */
async function confirmSameWarehouseDialog(page, timeout = 3500) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const dlg = await findConfirmDialog(page);
    if (dlg) {
      log(`  ⇢ 出现确认框：${dlg.text.slice(0, 90)}`);
      log(`  ⇢ 点击「${dlg.btn}」`);
      if (CFG.dry) return true;
      await page.mouse.click(dlg.x, dlg.y);
      await sleep(1200);
      await settle(page, 400);
      log('  ✓ 确认框已处理');
      return true;
    }
    await sleep(400);
  }
  dlog('没有同仓库确认框，直接进抽屉');
  return false;
}

/* ------------------------------- 工具栏动作 ------------------------------- */

function batchPackBtn(page) {
  return page.locator(SEL.batchPack);
}

async function clickBatchPack(page) {
  let btn = await firstVisible(batchPackBtn(page));
  if (!btn) btn = await firstVisible(page.locator('button').filter({ hasText: /^批量装箱发货$/ }));
  if (!btn) {
    log('✗ 找不到「批量装箱发货」按钮');
    return false;
  }
  if (await btn.isDisabled().catch(() => false)) {
    log('✗「批量装箱发货」是禁用状态（没勾选 / 选中的单状态不允许装箱）');
    return false;
  }
  log('点击「批量装箱发货」');
  if (CFG.dry) return true;
  await btn.click({ timeout: 15000 }).catch((e) => log('  点击异常：', e.message.split('\n')[0]));
  await sleep(1500);
  return true;
}

/* ------------------------------- 抽屉 ------------------------------- */

async function drawerOpened(page) {
  const d = await firstVisible(page.locator(SEL.drawer));
  if (!d) return false;
  const title = await page.locator(SEL.drawerTitle).first().innerText().catch(() => '');
  if (title && !/装箱发货/.test(title)) return false;
  const hasForm = await page.locator(SEL.boxNum).count().catch(() => 0);
  return hasForm > 0;
}

async function waitDrawer(page, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await drawerOpened(page)) {
      log('  ✓ 装箱发货抽屉已打开');
      return true;
    }
    await sleep(500);
  }
  return false;
}

/**
 * 读一个表单字段的状态。
 * sel 传 form-item 的 id 选择器（#expressPackageNum 这种）。
 *
 * 注意：不是所有值都在 input.value 里——
 *   发货仓库 【沙井仓】   → select 的 input.value
 *   物流公司 圆通专揽特惠 → 只是可见文本（input 是空的搜索框）
 * 所以三级兜底：input.value → .IPT_mirror → item 的 innerText 去掉 label。
 */
async function fieldState(page, sel) {
  const item = page.locator(sel).first();
  if ((await item.count().catch(() => 0)) === 0) return { exists: false, value: '', disabled: true };
  return item
    .evaluate((root) => {
      const inp = root.querySelector('input, textarea');
      const mirror = root.querySelector('[class*="mirror"], [class*="Mirror"]');
      const label = ((root.querySelector('label') || {}).innerText || '').trim();

      let v = inp ? (inp.value || '').trim() : '';
      if (!v && mirror) v = (mirror.innerText || '').trim();
      if (!v) {
        let t = (root.innerText || '').replace(/\s+/g, ' ').trim();
        if (label && t.includes(label)) t = t.slice(t.indexOf(label) + label.length);
        t = t.replace(/^\s*[*＊]\s*/, '').trim();
        // 去掉右侧的说明文案，只留取值本身
        v = t.split(/商家预估承担|根据物流公司提供|为保证能按时履约|可以当日上门取件|号码保护/)[0].trim().slice(0, 80);
      }

      const disabled =
        !!inp &&
        (inp.disabled === true ||
          !!inp.closest('[class*="Disabled"]') ||
          !!inp.closest('[class*="disabled"]'));

      return {
        exists: true,
        value: v,
        disabled,
        placeholder: inp ? inp.placeholder || '' : '',
        label,
        text: (root.innerText || '').replace(/\s+/g, ' ').slice(0, 140),
      };
    })
    .catch(() => ({ exists: true, value: '', disabled: false }));
}

/**
 * 这一单是不是「在线物流下单」——只有这种发货方式才要预约取货时间。
 * 自送 / 自行委托第三方物流 的话，预约取货时间永远是禁用的，别死等。
 */
async function needsPickup(page) {
  const txt = await page
    .locator(SEL.deliverMethod)
    .first()
    .evaluate((root) => {
      const checked = root.querySelector('input[type="radio"]:checked');
      if (checked) {
        const lab = checked.closest('label');
        if (lab) return (lab.innerText || '').trim();
      }
      const active = root.querySelector('[class*="checked"], [class*="Checked"], [class*="active"]');
      const lab = active && active.closest('label');
      return lab ? (lab.innerText || '').trim() : '';
    })
    .catch(() => '');
  if (!txt) return true; // 读不出来就按"需要"处理，保守
  dlog(`发货方式：${txt}`);
  return /在线物流/.test(txt);
}

/** 填「发货总箱/包数」 */
async function fillBoxCount(page, n = CFG.boxCount) {
  const st = await fieldState(page, SEL.boxNum);
  if (String(st.value).trim() === String(n)) {
    log(`  ✓ 发货总箱/包数已经是 ${n}`);
    return true;
  }
  const input = page.locator(`${SEL.boxNum} input`).first();
  if ((await input.count().catch(() => 0)) === 0) {
    log('  ✗ 找不到「发货总箱/包数」输入框');
    await shot(page, 'boxcount-notfound');
    return false;
  }
  log(`  填「发货总箱/包数」= ${n}${st.value ? `（原值 ${st.value}）` : ''}`);
  if (CFG.dry) return true;

  await input.click({ timeout: 8000 }).catch(() => {});
  await input.fill(String(n)).catch(async () => {
    await input.press('Control+A').catch(() => {});
    await input.pressSequentially(String(n), { delay: 60 });
  });
  await sleep(200);
  await input.press('Tab').catch(() => {}); // 失焦触发校验/重算
  await sleep(700);

  const after = await fieldState(page, SEL.boxNum);
  if (String(after.value).trim() === String(n)) {
    log(`  ✓ 已填 ${n}`);
    return true;
  }
  log(`  ⚠️ 填完后读到的值是「${after.value}」，可能被校验拦下`);
  return false;
}

/**
 * 等仓库信息加载完。
 * 硬判据只有两个：① 发货仓库 有值 ② 预约取货日期框 解除 disabled。
 * 物流公司（#expressCompanyId）会晚一点才被平台自动带出，且它的值只是可见文本，
 * 所以不作为"就绪"的前置条件——真没带出来由 ensureCompany 去补。
 */
async function waitWarehouseReady(page, timeout = 45000) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeout) {
    const wh = await fieldState(page, SEL.warehouse);
    const dateSt = await fieldState(page, SEL.pickupDate);
    const whOk = !!wh.value && !/请选择/.test(wh.value);
    const dateReady = dateSt.exists && !dateSt.disabled;

    if (whOk && dateReady) {
      log(`  ✓ 仓库信息已就绪：仓库=${wh.value}`);
      return true;
    }
    const cur = `仓库=${wh.value || '-'} 日期框=${dateReady ? '可用' : '禁用'}`;
    if (cur !== last) dlog(`等待加载… ${cur}`);
    last = cur;
    await sleep(700);
  }
  const wh = await fieldState(page, SEL.warehouse);
  const dateSt = await fieldState(page, SEL.pickupDate);
  log(`  ⚠️ 等 ${Math.round(timeout / 1000)}s 仍未就绪：仓库=${wh.value || '-'}，日期框=${dateSt.disabled ? '禁用' : '可用'}`);
  await shot(page, 'warehouse-timeout');
  return false;
}

/**
 * 确保「物流公司」有值。
 * 平台一般会根据重量/体积自动带出（选项首部那个"运费相对低、时效相对快"的），
 * 但偶尔迟迟不带 → 这里手动打开下拉选第一项。
 */
async function ensureCompany(page, timeout = 15000) {
  const ok = (v) => !!v && !/请选择/.test(v);
  for (let t = 0; t < timeout; t += 800) {
    const st = await fieldState(page, SEL.company);
    if (ok(st.value)) return st.value;
    await sleep(800);
  }
  log('  · 物流公司迟迟没带出来，手动选第一个');
  if (CFG.dry) return '(演练未选)';

  const header = page.locator(`${SEL.company} [data-testid="beast-core-select-header"]`).first();
  const target = (await header.count().catch(() => 0)) > 0 ? header : page.locator(SEL.company).first();
  await target.click({ timeout: 8000 }).catch(() => {});
  await sleep(700);
  await page.keyboard.press('ArrowDown').catch(() => {});
  await sleep(250);
  await page.keyboard.press('Enter').catch(() => {});
  await sleep(600);

  const st = await fieldState(page, SEL.company);
  if (ok(st.value)) {
    log(`  ✓ 物流公司 = ${st.value.slice(0, 40)}`);
    return st.value;
  }
  log('  ⚠️ 物流公司仍为空，提交时可能被必填校验拦下');
  return '';
}

/**
 * 在浮层面板里取"第一个可用格"。
 *
 * 不能全页找数字：抽屉里还有「已选发货单 1」「序号 1」之类。
 * 所以先把面板找出来——absolute/fixed、可见、有面积、离触发框最近的那个，
 * 只在面板内部挑格子；面板里凑不够数才退回全局。
 *
 * kind='day'  → 1~31 的纯数字
 * kind='time' → HH:mm
 *
 * 排序按"从上到下、从左到右"，第一个 = 最近可选。
 */
async function pickFirstInPanel(page, box, kind = 'day') {
  const hit = await page
    .evaluate(
      ({ bx, by, bw, bh, kind }) => {
        const vis = (el) => {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        };
        const isDisabled = (el) => {
          let n = el;
          for (let d = 0; d < 4 && n; d++) {
            if (n.disabled === true) return true;
            if (n.getAttribute && n.getAttribute('aria-disabled') === 'true') return true;
            const cls = String(n.className || '');
            if (/(^|[-_\s])(disabled|forbid|not-allowed|gray|grey|unavailable)([-_\s]|$)/i.test(cls)) return true;
            if (/(disabled|Disabled|forbid|Forbid)/.test(cls)) return true;
            if (getComputedStyle(n).pointerEvents === 'none') return true;
            n = n.parentElement;
          }
          return parseFloat(getComputedStyle(el).opacity || '1') < 0.6;
        };
        const isCell = (el) => {
          if (el.children.length > 2) return false;
          const t = (el.innerText || el.textContent || '').trim();
          if (kind === 'day') {
            if (!/^\d{1,2}$/.test(t)) return false;
            const v = Number(t);
            if (v < 1 || v > 31) return false;
          } else {
            if (!/^\d{1,2}:\d{2}$/.test(t)) return false;
          }
          if (!vis(el) || isDisabled(el)) return false;
          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.height < 8 || r.width > 120 || r.height > 90) return false;
          return true;
        };

        const panels = [];
        for (const el of document.querySelectorAll('body *')) {
          const cs = getComputedStyle(el);
          if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
          if (!vis(el) || cs.pointerEvents === 'none') continue;
          const r = el.getBoundingClientRect();
          if (r.width < 120 || r.height < 70 || r.width > 900 || r.height > 760) continue;
          panels.push({ el, r, z: Number(cs.zIndex || 0) });
        }
        const dist = (r) => {
          const dy = r.top >= by + bh - 8 ? r.top - (by + bh) : Math.abs(r.top - by) + 200;
          const dx = r.left > bx + bw ? r.left - (bx + bw) : bx - r.right > 0 ? bx - r.right : 0;
          return dy + dx;
        };
        panels.sort((a, b) => dist(a.r) - dist(b.r) || b.z - a.z);

        const threshold = kind === 'day' ? 15 : 5;
        let cells = [];
        let where = 'panel';
        for (const p of panels.slice(0, 4)) {
          const c = Array.from(p.el.querySelectorAll('div,span,td,li'))
            .filter(isCell)
            .map((el) => ({
              label: (el.innerText || '').trim(),
              r: el.getBoundingClientRect(),
            }));
          if (c.length >= threshold) {
            cells = c;
            break;
          }
        }
        if (!cells.length) {
          where = 'global';
          cells = Array.from(document.querySelectorAll('div,span,td,li'))
            .filter(isCell)
            .filter((el) => {
              let n = el;
              for (let d = 0; d < 10 && n; d++) {
                const cs = getComputedStyle(n);
                if (/picker|calendar|panel|popup|popover|dropdown|overlay/i.test(String(n.className || ''))) return true;
                if ((cs.position === 'absolute' || cs.position === 'fixed') && Number(cs.zIndex || 0) >= 10) return true;
                n = n.parentElement;
              }
              return false;
            })
            .map((el) => ({ label: (el.innerText || '').trim(), r: el.getBoundingClientRect() }));
        }
        if (!cells.length) return null;

        cells.sort(
          (a, b) => Math.round(a.r.top / 8) - Math.round(b.r.top / 8) || Math.round(a.r.left) - Math.round(b.r.left)
        );
        const f = cells[0];
        return {
          label: f.label,
          count: cells.length,
          where,
          x: f.r.x + f.r.width / 2,
          y: f.r.y + f.r.height / 2,
        };
      },
      { bx: (box && box.x) || 0, by: (box && box.y) || 0, bw: (box && box.width) || 0, bh: (box && box.height) || 0, kind }
    )
    .catch(() => null);

  if (!hit) return null;
  dlog(`面板候选 ${hit.count} 个（${hit.where}），取「${hit.label}」`);
  await page.mouse.click(hit.x, hit.y);
  await sleep(700);
  return hit;
}

/**
 * 时间选择是「小时列 + 分钟列」的滚轮列表：
 *   ul[class*="TPK_ul"]  →  li[class*="cIL_item"]（禁用时带 cIL_disabled）
 * 已经过去的时段会被置为 disabled，所以"最近可选"= 每一列第一个非 disabled 的格子。
 * 先点小时列、再点分钟列（点完小时，分钟列的可用集合可能会变，所以每列都重新查）。
 */
async function pickTimeWheel(page) {
  const lists = page.locator('[class*="TPK_ul"]');
  const cnt = await lists.count().catch(() => 0);
  if (!cnt) return false;

  let clicked = 0;
  for (let i = 0; i < cnt; i++) {
    const ul = lists.nth(i);
    if (!(await ul.isVisible().catch(() => false))) continue;
    const opt = ul.locator('[class*="cIL_item"]:not([class*="disabled"])').first();
    if ((await opt.count().catch(() => 0)) === 0) {
      dlog(`第 ${i + 1} 列没有可选项`);
      continue;
    }
    const label = (await opt.innerText().catch(() => '')).trim();
    await opt.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(120);
    await opt.click({ timeout: 5000 }).catch(() => {});
    await sleep(400);
    dlog(`滚轮第 ${i + 1} 列 → ${label}`);
    clicked++;
  }
  return clicked > 0;
}

/**
 * 设「预约取货时间」= 最近可选时间。
 * 日期框、时间框是两个独立控件（#expectPickUpGoodsDate / #expectPickUpGoodsTime）。
 */
async function setPickupNearest(page) {
  const dateInput = page.locator(`${SEL.pickupDate} input`).first();
  const timeInput = page.locator(`${SEL.pickupTime} input`).first();

  if ((await dateInput.count().catch(() => 0)) === 0) {
    log('  ✗ 找不到「预约取货时间」日期框');
    await shot(page, 'pickup-notfound');
    return false;
  }
  if (await dateInput.isDisabled().catch(() => false)) {
    log('  ✗ 日期框还是禁用状态，说明可预约时段还没拉回来');
    await shot(page, 'pickup-disabled');
    return false;
  }

  if (CFG.dry) {
    log('  [演练] 将点开日期面板选最近可选日期、时间滚轮选最近可选时间');
    return true;
  }

  // ① 日期
  let dv = (await dateInput.inputValue().catch(() => '')).trim();
  if (!/\d{4}-\d{2}-\d{2}/.test(dv)) {
    const box = await dateInput.boundingBox().catch(() => null);
    await dateInput.click({ timeout: 8000 }).catch(() => {});
    await sleep(800);

    const picked = await pickFirstInPanel(page, box, 'day');
    if (!picked) {
      dlog('日期面板没抓到日期格，试键盘 ↓ + Enter');
      await page.keyboard.press('ArrowDown').catch(() => {});
      await sleep(300);
      await page.keyboard.press('Enter').catch(() => {});
      await sleep(600);
    } else {
      dlog(`日期取「${picked.label}」`);
    }
    dv = (await dateInput.inputValue().catch(() => '')).trim();

    // 有些面板要再点一次「确定」
    if (!/\d{4}-\d{2}-\d{2}/.test(dv)) {
      const ok = await firstVisible(page.locator('button').filter({ hasText: /^(确定|确认|完成)$/ }));
      if (ok) {
        dlog('面板内点「确定」');
        await ok.click({ timeout: 5000 }).catch(() => {});
        await sleep(600);
        dv = (await dateInput.inputValue().catch(() => '')).trim();
      }
    }
  }
  if (!/\d{4}-\d{2}-\d{2}/.test(dv)) {
    log(`  ✗ 日期没落上（当前值「${dv}」）`);
    await shot(page, 'pickup-date-fail');
    return false;
  }

  // ② 时间（双列滚轮）
  let tv = (await timeInput.inputValue().catch(() => '')).trim();
  if (!tv) {
    await timeInput.click({ timeout: 8000 }).catch(() => {});
    await sleep(900);

    const ok = await pickTimeWheel(page);
    if (!ok) {
      log('  ✗ 时间滚轮没找到可选项，试键盘 ↓ + Enter');
      await page.keyboard.press('ArrowDown').catch(() => {});
      await sleep(300);
      await page.keyboard.press('Enter').catch(() => {});
      await sleep(500);
    }
    tv = (await timeInput.inputValue().catch(() => '')).trim();

    if (!tv) {
      const ok2 = await firstVisible(page.locator('button').filter({ hasText: /^(确定|确认|完成)$/ }));
      if (ok2) {
        dlog('时间面板点「确定」');
        await ok2.click({ timeout: 5000 }).catch(() => {});
        await sleep(500);
        tv = (await timeInput.inputValue().catch(() => '')).trim();
      }
    }
  }

  await page.keyboard.press('Escape').catch(() => {}); // 关掉残留面板
  await sleep(300);

  if (!/\d{1,2}:\d{2}/.test(tv)) {
    log(`  ✗ 时间没落上（当前值「${tv}」）`);
    await shot(page, 'pickup-time-fail');
    return false;
  }
  log(`  ✓ 预约取货时间 = ${dv} ${tv}`);
  return true;
}

/** 点「确认发货」并确认抽屉关掉 */
async function submitDrawer(page, needPickup = true) {
  // 提交前体检
  const boxes = await fieldState(page, SEL.boxNum);
  let bad = !boxes.value;
  let detail = `箱数=「${boxes.value}」`;
  if (needPickup) {
    const d = await fieldState(page, SEL.pickupDate);
    const t = await fieldState(page, SEL.pickupTime);
    detail += ` 日期=「${d.value}」时间=「${t.value}」`;
    if (!/\d{4}-\d{2}-\d{2}/.test(d.value) || !t.value) bad = true;
  }
  if (bad) {
    log(`  ✗ 提交前检查未过：${detail} → 不提交`);
    await shot(page, 'pre-submit-check');
    return false;
  }

  let btn = await firstVisible(page.locator(SEL.confirmShip));
  if (!btn) btn = await firstVisible(page.locator('button').filter({ hasText: /^确认发货$/ }));
  if (!btn) {
    log('  ✗ 找不到「确认发货」按钮');
    await shot(page, 'submit-notfound');
    return false;
  }

  if (CFG.dry) {
    log('  [演练] 将点击「确认发货」——演练中跳过');
    return true;
  }

  log('点击「确认发货」');
  await btn.click({ timeout: 15000 }).catch(async (e) => {
    log('  点击异常，改坐标点：', e.message.split('\n')[0]);
    const bb = await btn.boundingBox().catch(() => null);
    if (bb) await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
  });
  await sleep(1200);

  // 可能的二层确认气泡：必须带问号，避免把抽屉里的「确认发货」本体再点一遍
  for (let i = 0; i < 2; i++) {
    if (!(await drawerOpened(page))) break;
    const dlg = await findConfirmDialog(page);
    if (!dlg || !/[？?]|确定要/.test(dlg.text)) break;
    log(`  二层确认：${dlg.text.slice(0, 70)} → 点「${dlg.btn}」`);
    await page.mouse.click(dlg.x, dlg.y);
    await sleep(1200);
  }

  // 成功判据：抽屉关掉
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if (!(await drawerOpened(page))) {
      const toast = await readToast(page);
      log(`  ✓ 抽屉已关闭，提交完成${toast ? `（提示：${toast}）` : ''}`);
      return true;
    }
    await sleep(500);
  }

  const toast = await readToast(page);
  log(`  ✗ 抽屉没关，提交可能失败${toast ? `：${toast}` : ''}`);
  await shot(page, 'submit-fail');
  return false;
}

/* ------------------------------- 探测模式 ------------------------------- */

async function probe(page) {
  log('=== 探测模式：只选择、只打开抽屉，绝不提交 ===');
  await ensureListPage(page);
  await settle(page, 1500);
  await shot(page, 'probe-list');

  await clearSelection(page);
  const rows = await collectRows(page);
  log(`识别到数据行 ${rows.length} 行`);
  rows.slice(0, 8).forEach((r, i) => log(`  #${i + 1} ${r.fh}${r.wb ? ' / ' + r.wb : ''}`));
  if (!rows.length) {
    log('⚠️ 没识别到行，先看 shots/probe-list-*.png');
    return;
  }

  const ok = await selectRow(page, rows[0]);
  log(`勾选第一行：${ok ? '成功' : '失败'}`);
  if (!ok) {
    await shot(page, 'probe-select-fail');
    return;
  }

  if (!(await clickBatchPack(page))) return;
  await confirmSameWarehouseDialog(page);
  if (!(await waitDrawer(page))) {
    await shot(page, 'probe-drawer-fail');
    return;
  }
  await shot(page, 'probe-drawer');

  // 1) 填箱数
  const boxOk = await fillBoxCount(page);
  log(`填箱数：${boxOk ? 'OK' : '失败'}`);

  // 2) 等仓库信息就绪（关键：日期框要解除 disabled 才谈得上选时间）
  const ready = await waitWarehouseReady(page, 60000);
  log(`仓库信息就绪：${ready ? '是' : '否'}`);

  const wh = await fieldState(page, SEL.warehouse);
  const cp = await fieldState(page, SEL.company);
  log(`发货仓库 = ${wh.value}（${wh.disabled ? '禁用' : '可用'}）`);
  log(`物流公司 = ${cp.value.slice(0, 60)}（${cp.disabled ? '禁用' : '可用'}）`);

  // 3) 点开日期面板，把真实结构 dump 出来
  const dateInput = page.locator(`${SEL.pickupDate} input`).first();
  if ((await dateInput.count().catch(() => 0)) > 0) {
    const disabled = await dateInput.isDisabled().catch(() => false);
    log(`日期框 disabled=${disabled}`);
    if (!disabled) {
      const box = await dateInput.boundingBox().catch(() => null);
      await dateInput.click({ timeout: 8000 }).catch(() => {});
      await sleep(1200);
      await shot(page, 'probe-date-panel');

      const dump = await page
        .evaluate(() => {
          const vis = (el) => {
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
          };
          const panels = [];
          for (const el of document.querySelectorAll('body *')) {
            const cs = getComputedStyle(el);
            if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
            if (!vis(el)) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 120 || r.height < 70) continue;
            const text = (el.innerText || '').replace(/\s+/g, ' ').slice(0, 300);
            panels.push({
              cls: String(el.className || '').slice(0, 160),
              rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
              z: Number(cs.zIndex || 0),
              text,
            });
          }
          // 单元格样本
          const cells = [];
          for (const el of document.querySelectorAll('div,span,td,li')) {
            if (el.children.length > 1) continue;
            const t = (el.innerText || '').trim();
            if (!/^\d{1,2}$/.test(t) && !/^\d{1,2}:\d{2}$/.test(t)) continue;
            if (!vis(el)) continue;
            const cls = String(el.className || '');
            if (!/cell|Cell|item|Item|day|Day/.test(cls)) continue;
            const r = el.getBoundingClientRect();
            cells.push({ t, cls: cls.slice(0, 120), disabled: /disabled|Disabled|forbid/.test(cls), rect: [Math.round(r.x), Math.round(r.y)] });
            if (cells.length > 12) break;
          }
          return { panels: panels.slice(0, 6), cells };
        })
        .catch(() => ({}));
      console.log('--- 浮层 ---');
      console.log(JSON.stringify(dump.panels, null, 2));
      console.log('--- 格子样本 ---');
      console.log(JSON.stringify(dump.cells, null, 2));

      // 实际点一下第一个可用日期，看能不能落上
      const picked = await pickFirstInPanel(page, box, 'day');
      log(`选中的日期格：${picked ? picked.label : '无'}`);
      const dv = (await dateInput.inputValue().catch(() => '')).trim();
      log(`点完后日期框 = ${dv || '(空)'}`);
      await shot(page, 'probe-date-picked');
    }
  } else {
    log('⚠️ 定位不到预约取货日期框');
  }

  // 4) 时间面板
  const timeInput = page.locator(`${SEL.pickupTime} input`).first();
  if ((await timeInput.count().catch(() => 0)) > 0) {
    const disabled = await timeInput.isDisabled().catch(() => false);
    log(`时间框 disabled=${disabled}`);
    if (!disabled) {
      const tbox = await timeInput.boundingBox().catch(() => null);
      await timeInput.click({ timeout: 8000 }).catch(() => {});
      await sleep(1000);
      await shot(page, 'probe-time-panel');

      // 时间面板是"小时列 + 分钟列"的滚轮，格子只有裸数字，
      // 所以按几何范围（输入框下方 ±300px）dump 一下候选，再实际点一下
      const sample = await page
        .evaluate(({ bx, by, bw, bh }) => {
          const vis = (el) => {
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
          };
          const out = [];
          for (const el of document.querySelectorAll('body *')) {
            if (el.children.length > 2) continue;
            const t = (el.innerText || '').trim();
            if (!/^\d{1,2}$/.test(t) && !/^\d{1,2}:\d{2}$/.test(t)) continue;
            if (!vis(el)) continue;
            const r = el.getBoundingClientRect();
            if (r.top < by + bh - 10 || r.top > by + bh + 420) continue;
            if (r.left < bx - 320 || r.left > bx + bw + 320) continue;
            out.push({
              t,
              cls: String(el.className || '').slice(0, 120),
              xy: [Math.round(r.x), Math.round(r.y)],
              parentCls: String((el.parentElement && el.parentElement.className) || '').slice(0, 120),
            });
            if (out.length > 8) break;
          }
          return out;
        }, { bx: (tbox && tbox.x) || 0, by: (tbox && tbox.y) || 0, bw: (tbox && tbox.width) || 0, bh: (tbox && tbox.height) || 0 })
        .catch(() => []);
      console.log('--- 时间格样本（前 8 个）---');
      console.log(JSON.stringify(sample, null, 1));

      const wheelOk = await pickTimeWheel(page);
      const tv = (await timeInput.inputValue().catch(() => '')).trim();
      log(`时间滚轮点击=${wheelOk ? '有' : '无'}，点完后时间框 = ${tv || '(空)'}`);
      await shot(page, 'probe-time-picked');
    }
  }

  // 5) 物流公司
  const cpFinal = await fieldState(page, SEL.company);
  log(`物流公司 = 「${cpFinal.value}」`);

  fs.mkdirSync(CFG.shotDir, { recursive: true });
  const htmlPath = path.join(CFG.shotDir, 'probe.html');
  fs.writeFileSync(htmlPath, await page.content(), 'utf8');
  log(`页面 HTML 已存：${htmlPath}`);
  log('（探测到此为止：没有点「确认发货」）');
}

/* ------------------------------- 主流程 ------------------------------- */

async function launch() {
  return openTaskBrowser({ chromium, profileDir: CFG.profileDir, slowMo: CFG.slowMo, cdp: CFG.cdp, ...runtimeOptions(), log });
}

/** 处理一单：勾选 → 批量装箱发货 → 抽屉填表 → 提交 */
async function processOne(page, target) {
  const sel = await selectRow(page, target);
  const cnt = (await collectRows(page)).length;
  log(`  勾选结果：${sel ? '已勾' : '未勾'}`);
  if (!sel) {
    await shot(page, 'select-fail');
    return false;
  }
  // 保险：确认只有这一行勾着
  const rows = await collectRows(page);
  const checkedRows = [];
  for (const r of rows) if ((await rowChecked(r)) === true) checkedRows.push(r.fh);
  if (checkedRows.length > 1) {
    log(`  · 勾了 ${checkedRows.length} 行（${checkedRows.join(',')}），清空后只勾第一行`);
    await clearSelection(page);
    if (!(await selectRow(page, target))) {
      await shot(page, 'select-again-fail');
      return false;
    }
  }
  dlog(`列表当前 ${cnt} 行`);

  if (!(await clickBatchPack(page))) {
    await shot(page, 'batchbtn-fail');
    return false;
  }

  await confirmSameWarehouseDialog(page);
  if (!(await waitDrawer(page))) {
    await shot(page, 'drawer-fail');
    return false;
  }

  if (!(await fillBoxCount(page))) return false;

  const needPickup = await needsPickup(page);
  if (needPickup) {
    if (!(await waitWarehouseReady(page))) {
      log('  ✗ 仓库信息没加载全，不往下走（否则预约取货时段是无效的）');
      return false;
    }
    if (!(await setPickupNearest(page))) {
      log('  ✗ 预约取货时间没设好，不提交');
      return false;
    }
  } else {
    log('  · 发货方式不是「在线物流下单」，跳过预约取货时间');
    if (!(await waitWarehouseReady(page, 15000))) {
      log('  ⚠️ 仓库信息没完全就绪，继续尝试提交（这种单不依赖预约时段）');
    }
  }

  // 物流公司：等平台自动带出，带不出来就手动选第一项
  await ensureCompany(page);

  return submitDrawer(page, needPickup);
}

async function main() {
  const session = await launch();
  const { page } = session;
  page.on('dialog', (d) => d.accept().catch(() => {}));
  page.setDefaultTimeout(20000);

  try {
    if (CFG.probe) {
      await probe(page);
      return;
    }
    await runLoop(page);
  } finally {
    // 默认收工关浏览器，脚本能正常退出；要看现场就加 --keep-open
    if (!CFG.keepOpen) {
      await session.close();
      log(session.attached ? '已断开用户浏览器连接，窗口保留' : '浏览器已关闭（想保留窗口请加 --keep-open）');
    }
  }
}

async function runLoop(page) {
  let success = 0;
  let consecutiveFail = 0;
  const handled = new Set();

  for (let round = 1; round <= CFG.maxRounds; round++) {
    log(`\n========== 第 ${round} 轮 ==========`);
    await ensureListPage(page);
    await settle(page, 900);

    const empty = await firstVisible(page.getByText(/暂无数据|暂无待|没有数据/));
    const rows0 = await collectRows(page);
    if (empty || !rows0.length) {
      log('✅ 列表已无待装箱数据，全部处理完成');
      break;
    }
    await shot(page, `round-${round}-list`);

    await clearSelection(page);
    const rows = await collectRows(page);
    if (!rows.length) {
      log('✅ 没有可处理的行，结束');
      break;
    }
    const target = rows[0];
    log(`第一行：${target.fh}${target.wb ? ' / ' + target.wb : ''}`);

    if (handled.has(target.fh)) {
      consecutiveFail++;
      log(`⚠️ 这个单号刚才处理过（第 ${consecutiveFail} 次碰到），可能没提交成功，停止`);
      await shot(page, 'same-order-again');
      break;
    }
    handled.add(target.fh);

    const ok = await processOne(page, target);
    if (ok) {
      success++;
      consecutiveFail = 0;
      log(`✓ 第 ${round} 轮完成（累计 ${success} 单）`);
    } else {
      consecutiveFail++;
      log(`✗ 第 ${round} 轮失败（连续 ${consecutiveFail} 次）`);
      await shot(page, `round-${round}-fail`);
      if (consecutiveFail >= 2) {
        log('✗ 连续 2 轮失败，停止，保留现场请人工检查');
        break;
      }
    }

    await settle(page, 1200);
  }

  log(`\n结束：成功提交 ${success} 单`);
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error('\n❌ 脚本异常：', e && e.message);
      console.error(e && e.stack);
      process.exitCode = 1;
    })
    .finally(() => {
      log(CFG.keepOpen ? '脚本结束（浏览器窗口保留，可手动检查）' : '脚本结束');
    });
}

module.exports = {
  CFG,
  SEL,
  collectRows,
  selectRow,
  clearSelection,
  clickBatchPack,
  fieldState,
  fillBoxCount,
  waitWarehouseReady,
  setPickupNearest,
  submitDrawer,
  settle,
};
