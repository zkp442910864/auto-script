#!/usr/bin/env node
/**
 * 跨境卖货 · 发货台（shipping-desk）批量自动创建发货单
 * ---------------------------------------------------------------
 * 流程（按你描述的循环）：
 *   1) 打开发货台列表
 *   2) 逐行点「修改」→ 输入实际发货数（默认 99999，若被校验拦下自动回退到「最大不超过 N」）
 *      ※ 关键：改了某仓库的单之后，其他仓库的行会被整行置灰不可操作。
 *        所以脚本只动「还能点」的行，置灰的一律跳过。
 *      ※ 同仓库的单可能跨到第二页：本页改完后会弹「是否加入其他同仓库单」，
 *        脚本会自动点确认把它并进来，然后继续改，不靠"连续失败几次"猜结束。
 *   3) 点「创建发货单」→ 居中弹窗「本次计划发货 N 件，确认批量发货吗？」
 *      → 点蓝色按钮「取消其他，去创建发货单」（同仓库单跨页时也是这个框）
 *   4) 创建页把「发货仓库」下拉选第一个
 *   5) 点「确认创建」→ 气泡「…打印发货单，确认创建？」
 *      → 点蓝色按钮「继续合并，已确认合并发货」
 *   6) 页面重定向后重新回到 1)，下一轮处理下一个仓库，直到列表没有数据
 *
 * 用法（cmd / PowerShell / Git Bash 通用，推荐）：
 *   npm run probe             # 只探测页面结构，不做任何修改（第一次建议先跑这个）
 *   npm run dry               # 演练：全程只打印日志，不真提交
 *   npm run auto              # 正式执行
 *   npm run verify            # 用 shots/probe.html 离线复验选择器（不用登录）
 *
 *   其他参数（跟在 node index.js 后面）：
 *   --fill=99999     要输入的实际发货数，默认 99999
 *   --max-rounds=3   最多跑几轮，默认 200
 *   --slowmo=300     每步延迟（毫秒），默认 120，页面卡就调大
 *   --browser=auto --browser-port=9222  优先连接本机用户 Chrome，失败回退原方式
 *   --cdp=http://127.0.0.1:9222   连接已开远程调试的 Chrome，复用现有登录态
 *   --debug          详细日志
 *
 * 也可以继续用环境变量（Git Bash / PowerShell 各自的写法）：
 *   DRY=1 DEBUG=1 npm run auto        # Git Bash
 *   $env:DRY="1"; npm run auto        # PowerShell
 *   set DRY=1 && npm run auto         # cmd
 *
 * 首次运行会在脚本目录生成 .pw-profile 目录（独立 Chrome 配置），
 * 浏览器窗口里手动登录一次，之后就不用再登录了。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { openBrowser, openTaskBrowser, runtimeOptions } = require('../shared/browser-session');

/* ------------------------------ 命令行参数 ------------------------------ */
// 支持 --dry / --debug / --fill=53 / --max-rounds=3 / --slowmo=300 / --cdp=... / --probe
// 在 cmd、PowerShell、Git Bash 里写法一致，不用折腾环境变量
const ARGV = process.argv.slice(2);
const hasFlag = (n) => ARGV.includes(`--${n}`);
const flagVal = (n) => {
  const hit = ARGV.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};

const CFG = {
  url: 'https://seller.kuajingmaihuo.com/main/order-manager/shipping-desk',
  fillValue: Number(flagVal('fill') || process.env.FILL || 99999),
  profileDir: path.join(__dirname, '.pw-profile'),
  shotDir: path.join(__dirname, 'shots'),
  maxRounds: Number(flagVal('max-rounds') || process.env.MAX_ROUNDS || 200),
  maxEditsPerRound: 300,
  slowMo: Number(flagVal('slowmo') || process.env.SLOWMO || 120),
  cdp: flagVal('cdp') || process.env.CDP || '',
  dry: hasFlag('dry') || process.env.DRY === '1',
  debug: hasFlag('debug') || process.env.DEBUG === '1',
  probe: ARGV.includes('probe') || hasFlag('probe'),
};

const ORDER_RE = /W[A-Z]*\d{8,}/;

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
  try {
    await page
      .locator('[class*="spin-spinning"], [class*="loading"]:visible, [class*="Loading"]:visible, [class*="mask"]:visible')
      .first()
      .waitFor({ state: 'hidden', timeout: 3000 });
  } catch {}
}

async function shot(page, name) {
  try {
    fs.mkdirSync(CFG.shotDir, { recursive: true });
    const p = path.join(CFG.shotDir, `${name}-${Date.now()}.png`);
    await page.screenshot({ path: p, fullPage: false });
    dlog('截图', p);
  } catch {}
}

/** 取第一个可见的元素 */
async function firstVisible(locator) {
  const n = await locator.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = locator.nth(i);
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

/** 取最后一个可见的元素（弹层通常后插入 DOM） */
async function lastVisible(locator) {
  const n = await locator.count().catch(() => 0);
  for (let i = n - 1; i >= 0; i--) {
    const el = locator.nth(i);
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

/** 读取页面上可见的报错/提示文案 */
async function readToast(page) {
  const sels = [
    '[class*="toast"]',
    '[class*="Toast"]',
    '[class*="message"]',
    '[class*="Message"]',
    '[class*="notice"]',
    '[class*="Notice"]',
    '[class*="alert"]',
  ];
  for (const s of sels) {
    const l = page.locator(`${s}:visible`);
    const c = await l.count().catch(() => 0);
    for (let i = 0; i < Math.min(c, 6); i++) {
      const t = (await l.nth(i).innerText().catch(() => '')).trim();
      if (t && /超过|不能|不可|请输入|无效|错误|最大|失败|请选择/.test(t)) {
        return t.replace(/\s+/g, ' ').slice(0, 100);
      }
    }
  }
  return '';
}

/* ------------------------------- 登录/导航 ------------------------------- */

async function ensureListPage(page) {
  log(`打开发货台：${CFG.url}`);
  await page.goto(CFG.url, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch((e) => log('导航异常：', e.message));
  await settle(page, 800);

  if (/login|passport|sign/i.test(page.url())) {
    log('⚠️ 未登录，请在打开的浏览器窗口里手动完成登录（最长等 5 分钟）…');
    await page.waitForURL((u) => !/login|passport|sign/i.test(u.toString()), { timeout: 300000 });
    log('登录完成，继续。');
    await page.goto(CFG.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await settle(page, 800);
  }
}

/** 列表是否还有数据 */
async function listHasData(page) {
  const empty = await firstVisible(page.getByText(/暂无数据|暂无待|没有数据|空空如也/));
  if (empty) return false;
  const orderHit = await page.getByText(ORDER_RE).count().catch(() => 0);
  if (orderHit > 0) return true;
  const editHit = await page.getByText('修改', { exact: true }).count().catch(() => 0);
  return editHit > 0;
}

/* ------------------------------- 修改实际发货数 ------------------------------- */

/**
 * 收集当前页所有可点的「修改」按钮。
 * 已按 probe 快照确认真实结构：
 *   <a data-testid="beast-core-button-link" class="BTN_...textPrimary..."><span>修改</span></a>
 *   行是 <tr>，仓库在第 3 个 td（文本以「仓」结尾），单号形如 WB2610266178100
 */
async function collectEditTargets(page) {
  let links = page
    .locator('a[data-testid="beast-core-button-link"]')
    .filter({ hasText: /^修改$/ });
  if ((await links.count().catch(() => 0)) === 0) {
    // 兜底：页面改版后仍能工作
    links = page.getByText('修改', { exact: true });
  }
  const total = await links.count().catch(() => 0);
  const out = [];
  for (let i = 0; i < total; i++) {
    const el = links.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const info = await el
      .evaluate((node) => {
        const row = node.closest('tr');
        let order = null;
        let warehouse = null;
        let sku = null;
        let rowText = '';
        if (row) {
          rowText = (row.innerText || '').replace(/\s+/g, ' ').slice(0, 400);
          const om = rowText.match(/W[A-Z]*\d{8,}/);
          if (om) order = om[0];
          const sm = rowText.match(/SKU\s*ID[：:]\s*([A-Za-z0-9]+)/);
          if (sm) sku = sm[1];
          for (const td of row.querySelectorAll('td')) {
            const t = (td.innerText || '').trim();
            if (t && t.length <= 30 && /仓$/.test(t)) {
              warehouse = t;
              break;
            }
          }
        }
        if (!order) {
          let n = node;
          for (let d = 0; d < 12 && n; d++) {
            const m = (n.innerText || '').match(/W[A-Z]*\d{8,}/);
            if (m) {
              order = m[0];
              break;
            }
            n = n.parentElement;
          }
        }
        return {
          order,
          warehouse,
          sku,
          trackingId: node.getAttribute ? node.getAttribute('data-tracking-id') : null,
          rowText,
        };
      })
      .catch(() => ({ order: null, warehouse: null, sku: null, trackingId: null, rowText: '' }));
    out.push({
      el,
      index: i,
      order: info.order,
      warehouse: info.warehouse,
      sku: info.sku,
      trackingId: info.trackingId,
      rowText: info.rowText,
    });
  }
  // 收货仓库列存在合并单元格（rowspan），部分行取不到自己的仓库名 → 继承上一行
  let lastWh = null;
  for (const t of out) {
    if (t.warehouse) {
      lastWh = t.warehouse;
      t.whInherited = false;
    } else {
      t.warehouse = lastWh;
      t.whInherited = true;
    }
  }
  return out;
}

/** 读取弹层里数量上限提示（实测文案：「不能超过该数 35」） */
async function readMaxHint(input) {
  return input
    .evaluate((node) => {
      const HINT = /(?:最大不超过|不能超过|最多不超过)\s*(?:该数\s*)?(\d+)/;
      // ① 从输入框往上找祖先
      let n = node;
      for (let d = 0; d < 12 && n; d++) {
        const m = (n.innerText || '').match(HINT);
        if (m) return Number(m[1]);
        n = n.parentElement;
      }
      // ② 提示可能是 input 的兄弟节点（如 el-form-item 的 error 区）
      n = node;
      for (let d = 0; d < 8 && n; d++) {
        for (const sib of n.parentElement ? Array.from(n.parentElement.children) : []) {
          if (sib === n) continue;
          const m = (sib.innerText || '').match(HINT);
          if (m) return Number(m[1]);
        }
        n = n.parentElement;
      }
      return null;
    })
    .catch(() => null);
}

/**
 * 点气泡里的「确认」。
 * 关键：确认按钮必须锚定在「输入框所在的那个气泡」里，不能用全页文本匹配，
 * 否则可能点到别的 确认（如批量发货弹窗）。
 * 返回 true 表示气泡已关闭（= 修改成功）。
 */
async function clickConfirmNearInput(page, input) {
  const hit = await input
    .evaluate((node) => {
      const vis = (el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      };
      let box = node.parentElement;
      // 实测：输入框 → …IPT_inputWrapper(4) → Form_item(9) → FORM(10) → 气泡根(11)
      // 气泡根在第 11 层才出现，必须走够 14 层
      for (let d = 0; d < 14 && box; d++) {
        const cands = Array.from(box.querySelectorAll('button, [role="button"], a, span, div')).filter(
          (e) => vis(e) && (e.innerText || '').trim() === '确认' && e.querySelectorAll('*').length <= 2
        );
        if (cands.length) {
          const b = cands[cands.length - 1];
          const r = b.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: b.tagName, cls: String(b.className).slice(0, 60) };
        }
        box = box.parentElement;
      }
      return null;
    })
    .catch(() => null);

  if (!hit) {
    log('  ⚠️ 气泡里没找到「确认」按钮');
    return false;
  }
  dlog('气泡内确认按钮：', hit.tag, hit.cls);

  await page.mouse.click(hit.x, hit.y);
  // 气泡关闭 = 成功；input 被卸载或被隐藏
  try {
    await input.waitFor({ state: 'hidden', timeout: 5000 });
    return true;
  } catch {
    const err = await readToast(page);
    if (err) log(`  ⚠️ 校验提示：${err}`);
    return false;
  }
}

/**
 * 用页面自身状态判断某行是否已改：行文本里还有「未修改实际发货数」= 没改
 * 返回 true=已改 / false=未改 / null=找不到这行
 */
async function rowModifiedNow(page, target) {
  const cands = await collectEditTargets(page);
  const hit =
    (target.order && target.sku
      ? cands.find((c) => c.order === target.order && c.sku === target.sku)
      : null) || cands[target.index];
  if (!hit) return null;
  return !/未修改实际发货数/.test(hit.rowText || '');
}

/**
 * 判断一个「修改」是不是还能点。
 * 页面在改了同仓库的单之后，会把其他仓库的行整行置灰（不可操作），
 * 所以不能只看文案，必须看实际可交互状态。
 */
async function isInteractable(el) {
  return el
    .evaluate((node) => {
      let n = node;
      for (let d = 0; d < 8 && n; d++) {
        const cs = getComputedStyle(n);
        if (n.disabled === true) return false;
        if (n.getAttribute && n.getAttribute('aria-disabled') === 'true') return false;
        if (cs.pointerEvents === 'none') return false;
        if (cs.cursor === 'not-allowed') return false;
        const cls = typeof n.className === 'string' ? n.className : '';
        if (/(^|[-_\s])(disabled|is-disabled|gray|grey|forbid)([-_\s]|$)/i.test(cls)) return false;
        n = n.parentElement;
      }
      const cs2 = getComputedStyle(node);
      if (parseFloat(cs2.opacity || '1') < 0.5) return false;
      return true;
    })
    .catch(() => true);
}

/** 从行文本里兜底嗅出仓库名，纯粹用来打日志 */
function guessWarehouse(rowText) {
  const m = (rowText || '').match(/[\u4e00-\u9fa5A-Za-z0-9()（）]{2,24}?(?:子仓|仓)/g);
  return m && m.length ? m[0] : '';
}

/** 记录点击前页面上可见 input 的特征，用于识别弹层新冒出来的输入框 */
async function snapshotInputs(page) {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll('input'))
        .filter((el) => {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        })
        .map((el) => el.outerHTML.slice(0, 150))
    )
    .catch(() => []);
}

/** 弹层是否还开着（还有点击前不存在的可见 input） */
async function popupStillOpen(page, before) {
  return page
    .evaluate((before) => {
      const vis = (el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      };
      return Array.from(document.querySelectorAll('input'))
        .filter(vis)
        .some((el) => !before.includes(el.outerHTML.slice(0, 150)));
    }, before)
    .catch(() => false);
}

/** 找弹层里的实际发货数输入框：优先 placeholder，其次对比点击前快照找新冒出来的 input */
async function locateEditInput(page, before) {
  try {
    const byPh = page.locator('input[placeholder*="请输入"]:visible');
    await byPh.last().waitFor({ state: 'visible', timeout: 4000 });
    return byPh.last();
  } catch {}
  try {
    const h = await page.evaluateHandle((before) => {
      const vis = (el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      };
      const inputs = Array.from(document.querySelectorAll('input')).filter(vis);
      const news = inputs.filter((el) => !before.includes(el.outerHTML.slice(0, 150)));
      return news.length ? news[news.length - 1] : null;
    }, before);
    const el = h.asElement();
    if (el) return el;
  } catch {}
  // 最后兜底：找「最大不超过」附近的 input
  try {
    const h = await page.evaluateHandle(() => {
      const all = Array.from(document.querySelectorAll('input')).filter((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return cs.display !== 'none' && r.width > 0;
      });
      for (const el of all) {
        let n = el;
        for (let d = 0; d < 6 && n; d++) {
          if (/(?:最大不超过|不能超过|最多不超过)/.test(n.innerText || '')) return el;
          n = n.parentElement;
        }
      }
      return null;
    });
    return h.asElement();
  } catch {}
  return null;
}

/**
 * 改一行，返回 'ok' | 'skipped' | 'fail'
 * skipped = 该行被置灰/点不开弹层（属于别的仓库，本轮不该动）
 */
async function editOneRow(page, target) {
  const label = target.order
    ? `${target.order}${target.sku ? ' · SKU ' + target.sku : ''}`
    : `第${target.index + 1}个修改按钮`;
  const wh = target.warehouse || guessWarehouse(target.rowText);
  log(`  → 修改 ${label}${wh ? '（' + wh + '）' : ''}`);

  if (!(await isInteractable(target.el))) {
    log('  · 该行已置灰（其他仓库被锁定），跳过');
    return 'skipped';
  }

  const before = await snapshotInputs(page);
  // 点击重试：第一次普通点，失败后按 Esc 清掉可能残留的气泡再 force 点
  let clicked = false;
  for (let attempt = 1; attempt <= 2 && !clicked; attempt++) {
    try {
      await target.el.click({ timeout: 6000, force: attempt === 2 });
      clicked = true;
    } catch (e) {
      if (attempt === 1) {
        dlog('第一次点击失败，清气泡后重试：', e.message.split('\n')[0]);
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(500);
      } else {
        log(`  ✗ 点击「修改」失败：${e.message.split('\n')[0]}`);
        await shot(page, 'edit-click-fail');
        return 'fail';
      }
    }
  }
  await sleep(600);

  // 点完必须真的弹出输入框，否则视为不可操作
  const input = await locateEditInput(page, before);
  if (!input) {
    log('  · 点击后没有弹出输入框，判定不可操作，跳过');
    await shot(page, 'edit-no-popup');
    await page.keyboard.press('Escape').catch(() => {});
    return 'skipped';
  }
  dlog('✓ 修改气泡已弹出，输入框已定位');

  const max = await readMaxHint(input);
  if (max) dlog('行内上限提示：', max);

  // 演练模式：到此为止，不填数不确认，点「取消」把气泡正常关掉（Esc 关不掉会挡住下一行）
  if (CFG.dry) {
    log(`  [演练] 气泡已弹出 ✓（上限=${max ?? '未读到'}），将填 ${CFG.fillValue} 并确认 —— 演练中跳过`);
    const cancel = await lastVisible(page.getByText('取消', { exact: true }));
    if (cancel) await cancel.click({ timeout: 5000 }).catch(() => page.keyboard.press('Escape'));
    else await page.keyboard.press('Escape').catch(() => {});
    await sleep(500);
    return 'ok';
  }

  // 先按配置值填（默认 99999）
  await input.click({ timeout: 8000 }).catch(() => {});
  await input.fill(String(CFG.fillValue)).catch(async () => {
    await input.press('Control+A');
    await input.pressSequentially(String(CFG.fillValue), { delay: 30 });
  });
  await sleep(250);
  const typed = (await input.inputValue().catch(() => '')).trim();
  dlog('输入框实际值：', typed);

  let ok = await clickConfirmNearInput(page, input);
  if (ok) log(`  ✓ 已改为 ${typed}`);
  if (!ok && max) {
    log(`  ↺ 被上限拦下，回退为 ${max} 重试`);
    const again = await locateEditInput(page, before);
    if (again) {
      await again.click({ timeout: 8000 }).catch(() => {});
      await again.fill(String(max)).catch(() => {});
      await sleep(300);
      ok = await clickConfirmNearInput(page, again);
      if (ok) log(`  ✓ 已改为 ${max}`);
    }
  }

  if (!ok) {
    // 最后一道核实：直接看这行还带不带「未修改实际发货数」——页面自己的状态最可信
    await sleep(600);
    const modified = await rowModifiedNow(page, target);
    if (modified === true) {
      log('  ✓ 页面显示已生效（「未修改实际发货数」标记消失）');
      ok = true;
    } else if (modified === false) {
      await shot(page, 'edit-fail');
      const err = await readToast(page);
      log(`  ✗ 该行修改未成功${err ? '：' + err : ''}`);
      return 'fail';
    }
  }
  if (!ok) {
    await shot(page, 'edit-fail');
    const err = await readToast(page);
    log(`  ✗ 该行修改未成功${err ? '：' + err : ''}`);
    return 'fail';
  }
  await sleep(400);
  return 'ok';
}

/**
 * 在浮层（模态框 / 气泡 Popconfirm / Popover）里定位确认按钮。
 * hintRe  命中提示文案；positiveRe 是要点的按钮文案。
 * 返回 { hint, found, label, x, y } 或 null（没找到提示）。
 * 气泡和模态框都认：类名 / role 命中，或浮层定位。
 */
async function locateFloatingButton(page, hintRe, positiveRe) {
  return page
    .evaluate(
      ({ hintSrc, posSrc }) => {
        const hintRe = new RegExp(hintSrc);
        const positiveRe = new RegExp(posSrc);
        const vis = (el) => {
          if (!el) return false;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const clsOf = (el) => (el.className && el.className.toString ? el.className.toString() : '') || '';
        const floating = (el) => {
          if (!el || !el.tagName) return false;
          const cls = clsOf(el);
          if (/modal|dialog|popup|popover|popconfirm|confirm|alert|layer|bubble|tooltip|overlay|float/i.test(cls))
            return true;
          const meta =
            (el.getAttribute && (el.getAttribute('role') || '') + ' ' + (el.getAttribute('data-testid') || '')) || '';
          if (/dialog|tooltip|popover|menu|modal/i.test(meta)) return true;
          const cs = getComputedStyle(el);
          return (cs.position === 'fixed' || cs.position === 'absolute') && Number(cs.zIndex || 0) >= 50;
        };

        let hint = null;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        while (walker.nextNode()) {
          const el = walker.currentNode;
          if (!vis(el)) continue;
          const t = (el.innerText || '').trim();
          if (!t || t.length > 200) continue;
          if (hintRe.test(t)) {
            hint = el;
            break;
          }
        }
        if (!hint) return null;

        // 往上找最近的、既像浮层又带目标按钮的容器
        let box = null;
        let n = hint;
        for (let d = 0; d < 14 && n; d++) {
          const kids = Array.from(n.querySelectorAll('*')).filter(vis);
          const hasBtn = kids.some((e) => positiveRe.test((e.innerText || '').trim()));
          if (hasBtn && floating(n)) {
            box = n;
            break;
          }
          n = n.parentElement;
        }
        if (!box) return { hint: (hint.innerText || '').slice(0, 160), found: false };

        const all = Array.from(
          box.querySelectorAll('button, [role="button"], [class*="btn"], span, div')
        ).filter(vis);
        // 候选：文案命中且不太长（避免把整个弹窗容器当按钮）
        const cands = all.filter((e) => {
          const t = (e.innerText || '').trim();
          return t.length > 0 && t.length <= 24 && positiveRe.test(t);
        });
        // 打分：蓝色主按钮 > 带 button/btn 类的真按钮
        const score = (e) => {
          let s = 0;
          const cls = clsOf(e);
          if (/primary|BTN_primary|btn-primary/i.test(cls)) s += 3;
          const bg = getComputedStyle(e).backgroundColor || '';
          const m = bg.match(/\d+/g);
          if (m && m.length >= 3) {
            const [r, g, b] = m.map(Number);
            if (b > 150 && b > r + 40 && b > g + 30) s += 2; // 蓝色底
          }
          if (/button|btn|role/i.test(cls + (e.getAttribute && e.getAttribute('role')))) s += 1;
          return s;
        };
        let target = cands[0] || null;
        for (const c of cands) if (score(c) > score(target)) target = c;

        const hintText = (box.innerText || '').replace(/\s+/g, ' ').slice(0, 200);
        if (!target) return { hint: hintText, found: false };
        const r = target.getBoundingClientRect();
        return {
          hint: hintText,
          found: true,
          label: (target.innerText || '').trim(),
          x: r.x + r.width / 2,
          y: r.y + r.height / 2,
        };
      },
      { hintSrc: hintRe.source, posSrc: positiveRe.source }
    )
    .catch(() => null);
}

/**
 * 点「创建发货单」后弹的居中确认框。实测有两种文案：
 *   A) 「本次共计发货 95 件，确认创建发货单？」
 *      按钮：取消创建，去核对发货数 / 发货数一致，继续创建（蓝色，要点这个）
 *   B) 「本次计划发货 37 件，确认批量发货吗？」
 *      按钮：取消并返回 / 调整结果，去核对修改 / 取消其他，去创建发货单（蓝色）
 * 同仓库单跨页时也是这个框。
 */
async function findJoinDialog(page) {
  return locateFloatingButton(
    page,
    /本次.{0,6}发货|确认创建发货单|确认批量发货|同仓库|加入其他|一并加入|发货数一致/,
    /发货数一致|取消其他|去创建发货单|继续创建|确认创建|继续合并|^(确认|确定|加入|继续)$/
  );
}

/** 处理「本次计划发货…确认批量发货吗？」弹窗；确认掉了返回 true */
async function tryHandleJoinDialog(page, tag = '') {
  const info = await findJoinDialog(page);
  if (!info) return false;

  log(`  ⇢ 出现批量发货确认框${tag ? '（' + tag + '）' : ''}：${info.hint}`);
  if (!info.found) {
    log('  ⚠️ 找到提示文案但没定位到确认按钮，请人工确认一下');
    await shot(page, 'join-dialog');
    return false;
  }
  log(`  ⇢ 点击「${info.label}」`);
  if (CFG.dry) return true;

  await page.mouse.click(info.x, info.y);
  await sleep(1500);
  await settle(page, 800);

  // 确认后弹窗应该消失，否则说明没点成功
  const still = await findJoinDialog(page);
  if (still) {
    log('  ⚠️ 确认后弹窗仍在，可能没点中');
    await shot(page, 'join-dialog-stuck');
    return false;
  }
  log('  ✓ 弹窗已确认');
  return true;
}

/**
 * 一轮里把「当前页能点的行」全部改完（不靠连续失败次数猜，跨度按整页算）。
 * 本页没得改时，检查是否要加入其他页的同仓库单，加入了就继续改。
 */
async function modifyAllRows(page) {
  const done = new Set();
  let okCount = 0;
  let joinTries = 0;
  let fails = 0;

  for (let i = 0; i < CFG.maxEditsPerRound; i++) {
    const cands = await collectEditTargets(page);
    // 同一备货单多 SKU 会拆成多行，单号会重复 → 用「单号+SKU」做唯一键
    const key = (c) =>
      c.order && c.sku ? `${c.order}|${c.sku}` : c.trackingId || c.order || `idx-${c.index}`;
    const remaining = cands.filter((c) => !done.has(key(c)));

    // 筛掉置灰的（其他仓库，或被锁定）
    const clickable = [];
    for (const c of remaining) {
      if (await isInteractable(c.el)) clickable.push(c);
    }

    // 观测：可点行应同属一个仓库，跨仓库就报警（不改变行为）
    const whs = [...new Set(clickable.map((c) => c.warehouse).filter(Boolean))];
    if (whs.length > 1) log(`  ⚠️ 可点行跨了多个仓库：${whs.join('、')}`);
    else if (whs.length === 1) dlog('当前可操作仓库：', whs[0]);

    if (!clickable.length) {
      // 本页能改的改完了 —— 可能还有同仓库单在下一页
      if (joinTries < 5 && (await tryHandleJoinDialog(page, '本页已改完'))) {
        joinTries++;
        log('  已并入其他同仓库单，继续处理');
        await settle(page, 800);
        continue;
      }
      log('  · 当前页已无可操作的行，收手去创建发货单');
      break;
    }

    const prefer = clickable.filter((c) => /未修改/.test(c.rowText));
    const target = prefer[0] || clickable[0];

    const status = await editOneRow(page, target);
    done.add(key(target));

    if (status === 'ok') {
      okCount++;
      fails = 0;
    } else if (status === 'skipped') {
      // 刚被置灰，不算错误，继续看下一个
      dlog('该行不可操作，继续');
    } else {
      fails++;
      log(`  ⚠️ 连续失败 ${fails} 次`);
      if (fails >= 3) {
        log('  ✗ 连续 3 行改失败，停止本轮（保留现场）');
        break;
      }
    }
    await settle(page, 300);
  }

  log(`本轮修改成功 ${okCount} 行`);
  return okCount;
}

/* ------------------------------- 创建发货单 ------------------------------- */

async function findCreateButton(page) {
  // probe 确认：真 <button>，禁用时带 BTN_disabled_5-111-0
  let el = await firstVisible(page.locator('button').filter({ hasText: /^创建发货单$/ }));
  if (!el) el = await firstVisible(page.getByText('创建发货单', { exact: true }));
  if (!el) return null;
  const disabled = await el
    .evaluate((node) => {
      const btn = node.closest('button') || node;
      return (
        btn.disabled === true ||
        btn.getAttribute('aria-disabled') === 'true' ||
        /disabled/i.test(btn.className || '')
      );
    })
    .catch(() => false);
  return { el, disabled };
}

/**
 * 在下拉里选第一项。
 * 关键：不能全页瞎找选项——创建页上还有「发货店铺」下拉（已自动填好），
 * 之前就是点到了它的选项（Magic Sticker当前），仓库反而没选上。
 * 策略：① 键盘 ↓ + Enter；② 只认触发框下方、紧贴它的那个下拉面板里的第一项。
 */
async function pickFirstOption(page, trigger) {
  const readVal = async () => (await trigger.inputValue().catch(() => '')).trim();
  const good = (v) => !!v && v !== '请选择';

  // ① 键盘
  await page.keyboard.press('ArrowDown').catch(() => {});
  await sleep(350);
  await page.keyboard.press('Enter').catch(() => {});
  await sleep(500);
  let v = await readVal();
  if (good(v)) {
    dlog('  已选（键盘）：', v);
    return true;
  }

  const box = await trigger.boundingBox().catch(() => null);
  if (!box) return false;

  // ② 位置兜底：不依赖任何 class 名，纯几何——
  //    取「在触发框正下方、横向重叠、由近到远」的第一个文字叶节点
  for (let round = 0; round < 3; round++) {
    const hit = await page.evaluate(
      ({ x, y, w, h }) => {
        const vis = (el) => {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const leaves = Array.from(document.querySelectorAll('body *')).filter((e) => {
          if (e.children.length) return false; // 只要文字叶节点
          if (!vis(e)) return false;
          const t = (e.innerText || e.textContent || '').trim();
          if (!t || t.length > 40) return false;
          const r = e.getBoundingClientRect();
          if (r.height > 60 || r.width < 8) return false;
          // 必须落在触发框下方，且横向有重叠
          return r.top >= y + h - 6 && r.left < x + w && r.right > x;
        });
        if (!leaves.length) return null;
        leaves.sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return ra.top - rb.top || ra.left - rb.left;
        });
        const f = leaves[0];
        const r = f.getBoundingClientRect();
        return {
          label: (f.innerText || f.textContent || '').trim().slice(0, 40),
          x: r.x + r.width / 2,
          y: r.y + r.height / 2,
          count: leaves.length,
          dist: Math.round(r.top - (y + h)),
        };
      },
      { x: box.x, y: box.y, w: box.width, h: box.height }
    ).catch(() => null);

    if (!hit) {
      await sleep(400);
      continue;
    }
    dlog(`  候选 ${hit.count} 项，最近一项「${hit.label}」距触发框 ${hit.dist}px`);
    await page.mouse.click(hit.x, hit.y);
    await sleep(600);
    v = await readVal();
    if (good(v)) {
      dlog('  已选（点击）：', v);
      return true;
    }
    // 没选上 → 重新点开触发框再来一次
    await trigger.click({ timeout: 5000 }).catch(() => {});
    await sleep(600);
  }
  return false;
}

/** 统计还有几个「请选择」没填（发货仓库列） */
async function countEmptySelects(page) {
  const triggers = page.locator('input[placeholder="请选择"]:visible');
  const n = await triggers.count().catch(() => 0);
  let empty = 0;
  for (let i = 0; i < n; i++) {
    const v = (await triggers.nth(i).inputValue().catch(() => '')).trim();
    if (!v || v === '请选择') empty++;
  }
  return { total: n, empty };
}

/** 创建页：把所有「发货仓库 · 请选择」都选成第一个 */
async function selectAllWarehouses(page) {
  const triggers = page.locator('input[placeholder="请选择"]:visible');
  let guard = 0;
  let filled = 0;
  while (guard++ < 30) {
    const n = await triggers.count().catch(() => 0);
    let idx = -1;
    for (let i = 0; i < n; i++) {
      const v = (await triggers.nth(i).inputValue().catch(() => '')).trim();
      if (!v || v === '请选择') {
        idx = i;
        break;
      }
    }
    if (idx < 0) break; // 全部选好了
    const trigger = triggers.nth(idx);

    if (CFG.dry) {
      log('  [演练] 将选择仓库第一个选项');
      break;
    }

    await trigger.click({ timeout: 10000 }).catch((e) => log('  点仓库下拉失败：', e.message.split('\n')[0]));
    await sleep(700);
    let ok = false;
    for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
      ok = await pickFirstOption(page, trigger);
      if (!ok) {
        dlog(`第 ${attempt} 次选择没成功，重开下拉再试`);
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(400);
        await trigger.click({ timeout: 5000 }).catch(() => {});
        await sleep(600);
      }
    }
    if (ok) {
      filled++;
      log(`  ✓ 发货仓库已选：${(await trigger.inputValue().catch(() => '')).trim()}`);
    } else {
      log('  ✗ 该仓库下拉没选上');
      await page.keyboard.press('Escape').catch(() => {});
      await shot(page, 'warehouse-fail');
      break;
    }
    await sleep(500);
  }
  if (filled === 0 && !CFG.dry) log('  ⚠️ 一个发货仓库都没选上');
  return filled;
}

/** 点「确认创建」，含二次确认（二次确认是气泡 Popconfirm，要点气泡里的按钮） */
async function confirmCreateFlow(page) {
  // 第一次
  const b1 = await lastVisible(page.getByText('确认创建', { exact: true }));
  if (!b1) {
    log('  ⚠️ 没找到「确认创建」按钮');
    return false;
  }
  if (CFG.dry) {
    log('  [演练] 将点击「确认创建」');
    return true;
  }
  await b1.click({ timeout: 15000 });
  await sleep(1200);

  // 二次确认气泡（实测：「…打印发货单，确认创建？」+
  //   蓝色「继续合并，已确认合并发货」/ 白色「取消创建，去核对修改」）
  for (let i = 0; i < 2; i++) {
    const bubble = await locateFloatingButton(
      page,
      /确认创建？|确认创建\?|打印发货单|打包装箱发货/,
      /继续合并|继续创建|已确认一致|确认创建|确认|确定/
    );
    if (!bubble) break;
    log(`  二次确认气泡：${bubble.hint}`);
    if (!bubble.found) {
      log('  ⚠️ 气泡里没定位到确认按钮');
      await shot(page, 'confirm-bubble');
      return false;
    }
    log(`  点击气泡里的「${bubble.label}」`);
    await page.mouse.click(bubble.x, bubble.y);
    await sleep(1500);
    await settle(page, 600);
  }
  return true;
}

/** 创建整套动作，成功返回 true */
async function createShippingOrder(page) {
  const btn = await findCreateButton(page);
  if (!btn) {
    log('⚠️ 列表页没有「创建发货单」按钮');
    return false;
  }

  // 交代一下还有多少行被锁着（属于其他仓库，下一轮再处理）
  const all = await collectEditTargets(page);
  let locked = 0;
  for (const c of all) {
    if (!(await isInteractable(c.el))) locked++;
  }
  if (locked) log(`另有 ${locked} 行仍被锁定（其他仓库），留到下一轮处理`);

  if (btn.disabled) {
    log('⚠️「创建发货单」按钮是禁用状态（本仓库可能还有没改完的行）');
    return false;
  }

  log('点击「创建发货单」');
  if (CFG.dry) return true;
  await btn.el.click({ timeout: 15000 });
  await sleep(1500);

  // 点完之后：先处理确认框（「本次共计发货 N 件，确认创建发货单？」→
  // 蓝色「发货数一致，继续创建」），它会挡住页面，必须先点掉，再等创建页
  let sawCreatePage = false;
  for (let i = 0; i < 6; i++) {
    if (await tryHandleJoinDialog(page, i === 0 ? '创建前' : `第${i + 1}次`)) continue;
    if (await firstVisible(page.getByText('发货仓库'))) {
      sawCreatePage = true;
      break;
    }
    await sleep(1200);
  }
  if (!sawCreatePage) {
    await page.getByText('发货仓库').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {
      log('⚠️ 没等到创建页的「发货仓库」，可能页面结构变了');
    });
  }
  await settle(page, 600);
  await shot(page, 'create-page');

  await selectAllWarehouses(page);
  await settle(page, 500);

  // 保险：仓库没选全就绝不点「确认创建」，避免创建出没仓库的发货单
  if (!CFG.dry) {
    const { total, empty } = await countEmptySelects(page);
    if (empty > 0) {
      log(`✗ 还有 ${empty}/${total} 个「请选择」没填（发货仓库），不点确认创建，保留现场`);
      await shot(page, 'warehouse-missing');
      return false;
    }
    log(`✓ 仓库已全部选好（共 ${total} 个下拉）`);
  }

  const ok = await confirmCreateFlow(page);
  if (!ok) {
    await shot(page, 'create-fail');
    return false;
  }

  const toast = await readToast(page);
  if (toast) log('  提示：', toast);

  await sleep(1500);
  await settle(page, 800);
  return true;
}

/* ------------------------------- 探测模式 ------------------------------- */

async function probe(page) {
  log('=== 探测模式：只读，不做任何修改 ===');
  await ensureListPage(page);
  await settle(page, 1500);
  await shot(page, 'probe-list');

  const info = await page.evaluate(() => {
    const vis = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const texts = (sel) =>
      Array.from(document.querySelectorAll(sel))
        .filter(vis)
        .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 80);
    return {
      url: location.href,
      buttons: texts('button'),
      inputPlaceholders: Array.from(document.querySelectorAll('input')).filter(vis).map((i) => i.placeholder),
      editLinks: texts('*').filter((t) => t === '修改').length,
      hasUnmodified: document.body.innerText.includes('未修改实际发货数'),
      bodySample: document.body.innerText.replace(/\s+/g, ' ').slice(0, 2000),
    };
  });
  console.log(JSON.stringify(info, null, 2));

  const cands = await collectEditTargets(page);
  log(`可见「修改」按钮：${cands.length} 个`);
  cands.slice(0, 5).forEach((c, i) => log(`  #${i + 1} 单号=${c.order}`));

  fs.mkdirSync(CFG.shotDir, { recursive: true });
  fs.writeFileSync(path.join(CFG.shotDir, 'probe.html'), await page.content(), 'utf8');
  log('页面 HTML 已存到 shots/probe.html');
}

/* ------------------------------- 主流程 ------------------------------- */

async function main() {
  const closeBrowser = hasFlag('close-browser');
  const session = await (closeBrowser ? openTaskBrowser : openBrowser)({ chromium, profileDir: CFG.profileDir, slowMo: CFG.slowMo, cdp: CFG.cdp, ...runtimeOptions(), log });
  const { page } = session;

  try {
    await run(page);
  } finally {
    if (closeBrowser) {
      await session.close();
      log(session.attached ? '已断开用户浏览器连接，窗口保留' : '浏览器已关闭');
    }
  }
}

async function run(page) {
  page.on('dialog', (d) => d.accept().catch(() => {}));
  page.setDefaultTimeout(20000);

  if (CFG.probe) {
    await probe(page);
    return;
  }

  let rounds = 0;
  for (let r = 1; r <= CFG.maxRounds; r++) {
    log(`\n========== 第 ${r} 轮 ==========`);
    await ensureListPage(page);
    await settle(page, 800);

    if (!(await listHasData(page))) {
      log('✅ 列表已无数据，全部处理完成');
      break;
    }
    await shot(page, `round-${r}-list`);

    const modified = await modifyAllRows(page);
    await shot(page, `round-${r}-after-edit`);

    if (modified === 0) {
      const btn = await findCreateButton(page);
      if (!btn || btn.disabled) {
        log('⚠️ 本轮没有改到任何行，且「创建发货单」不可用，停止。请人工看一下页面。');
        await shot(page, 'stuck');
        break;
      }
      log('本轮没有新行可改（可能已全部改好），直接创建');
    }

    const ok = await createShippingOrder(page);
    if (!ok) {
      log('✗ 创建发货单失败，停止并保留现场');
      await shot(page, 'create-abort');
      break;
    }
    rounds++;
    log(`第 ${r} 轮创建完成`);
    await settle(page, 1200);
  }

  log(`\n结束：成功创建 ${rounds} 轮`);
}

if (require.main === module) {
  main()
    .catch(async (e) => {
      console.error('\n❌ 脚本异常：', e && e.message);
      console.error(e && e.stack);
      process.exitCode = 1;
    })
    .finally(() => {
      log(hasFlag('close-browser') ? '脚本结束' : '脚本结束（浏览器窗口保留，可手动检查）');
    });
}

// 供离线验证脚本 require
module.exports = {
  CFG,
  collectEditTargets,
  isInteractable,
  findCreateButton,
  modifyAllRows,
  settle,
  selectAllWarehouses,
  countEmptySelects,
  pickFirstOption,
};
