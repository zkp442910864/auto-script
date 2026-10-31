'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { CFG, collectRows, processOne, setPickupNearest, waitDrawer, submitDrawer } = require('./index');

// 复现 2026-10-31 快照里的 Beast Modal：没有 role=dialog，类名只有 MDL_*。
// 全部在本地空白页执行，并阻止外部请求；不使用商家登录态或订单。
const entry = (checked) => `<div data-testid="beast-core-modal" class="MDL_outerWrapper_5-111-0">
  <h3>请务必<span>确认包裹和发货数</span></h3><h3>否则批量装箱发货后无法进行调整！</h3>
  <label data-testid="beast-core-checkbox" data-checked="${checked}">
    <input type="checkbox" ${checked ? 'checked' : ''}><span>30天内不再提醒</span>
  </label><button data-tracking-id="F6ythUHr3s9NcYWr">去装箱发货</button><button>取消</button></div>`;
const drawer = `<div data-testid="beast-core-drawer">
  <div class="index-module__title-text___2lZPs">装箱发货</div>
  <div id="expressPackageNum"><input value="1"></div>
  <div id="expectPickUpGoodsDate"><input value="2026-10-31"></div>
  <div id="expectPickUpGoodsTime"><input value="20:00"></div>
  <button data-tracking-id="KJ_BATCH_SHIP_CONFIRM_BTN">确认发货</button></div>`;
const confirmation = `<div data-testid="beast-core-modal" class="MDL_outerWrapper_5-117-0">
  <div class="index-module__dialogWrapper___2R4iS">确认装箱完毕并发货？</div>
  <button data-tracking-id="EI1zxH-2-j_miWD1">确认发货</button><button>取消</button></div>`;
// 该提示仅有用户图片，按可见文案模拟，不假设真实 tracking-id 或专用类名。
const sameAddress = `<div data-testid="beast-core-modal">
  <h3>以下 2 个发货单与已选发货单【发货/收货详细地址】均相同，无需分开多次发货，可一起发货节省运费（PC包裹可以不合并打包）</h3>
  <p>请务必确认包裹和发货数，否则批量装箱发货后无法进行调整！</p>
  <table><tbody><tr><td>FH1234567891</td></tr><tr><td>FH1234567892</td></tr></tbody></table>
  <button>一起发货</button><button>若不使用在线物流下单，则点此继续</button><button>取消发货</button></div>`;

let browser;
let shots;
const original = { dry: CFG.dry, shotDir: CFG.shotDir };
before(async () => {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  shots = await fs.mkdtemp(path.join(os.tmpdir(), 'packing-dialog-tests-'));
  CFG.shotDir = shots;
  CFG.dry = false;
});
after(async () => {
  Object.assign(CFG, original);
  await browser?.close();
  if (shots) await fs.rm(shots, { recursive: true, force: true });
});

async function localPage(t, html = '') {
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.abort());
  await page.setContent(html);
  t.after(() => page.close());
  return page;
}

for (const checked of [false, true]) {
  test(`入口提醒：${checked ? '已勾选不反选' : '延迟出现后自动勾选'}，再进入抽屉`, async (t) => {
    const page = await localPage(t);
    await page.evaluate(({ html, form, delay }) => {
      window.checkboxClicks = 0;
      window.proceeded = 0;
      setTimeout(() => {
        document.body.innerHTML = html;
        const input = document.querySelector('input');
        input.onclick = () => window.checkboxClicks++;
        document.querySelector('button').onclick = () => {
          window.checkedOnProceed = input.checked;
          window.proceeded++;
          document.body.innerHTML = form;
        };
      }, delay);
    }, { html: entry(checked), form: drawer, delay: checked ? 0 : 4000 });
    assert.equal(await waitDrawer(page, 8000), true);
    assert.deepEqual(await page.evaluate(() => [checkedOnProceed, proceeded, checkboxClicks]), [true, 1, checked ? 0 : 1]);
  });
}

test('无提示时直接识别抽屉；旧同仓库提示仍能确认', async (t) => {
  const page = await localPage(t, drawer);
  assert.equal(await waitDrawer(page, 1000), true);
  await page.setContent('<div role="dialog">同仓库单一起装箱<button>确认</button></div>');
  await page.locator('button').evaluate((button, form) => {
    button.onclick = () => { document.body.innerHTML = form; };
  }, drawer);
  assert.equal(await waitDrawer(page, 2000), true);
});

for (const dry of [false, true]) {
  test(`同地址提示在${dry ? '演练' : '正式'}模式点击「一起发货」，连续提醒处理后进入抽屉`, async (t) => {
    const page = await localPage(t, sameAddress);
    CFG.dry = dry;
    t.after(() => { CFG.dry = false; });
    await page.evaluate(({ reminder, form }) => {
      window.entryClicks = [];
      document.querySelectorAll('button').forEach((button) => {
        button.onclick = () => {
          entryClicks.push(button.textContent);
          if (button.textContent !== '一起发货') return;
          document.body.innerHTML = reminder;
          document.querySelector('button').onclick = () => {
            entryClicks.push('去装箱发货');
            window.reminderChecked = document.querySelector('input').checked;
            document.body.innerHTML = form;
          };
        };
      });
    }, { reminder: entry(false), form: drawer });
    assert.equal(await waitDrawer(page, 3000), true);
    assert.deepEqual(await page.evaluate(() => entryClicks), ['一起发货', '去装箱发货']);
    assert.equal(await page.evaluate(() => reminderChecked), true);
    assert.equal(await page.locator('[data-testid="beast-core-drawer"]').isVisible(), true);
  });
}

test('不把其他弹窗的「一起发货」当作同地址提示', async (t) => {
  const page = await localPage(t, '<div role="dialog">其他业务提示<button>一起发货</button></div>');
  await page.evaluate(() => {
    window.clicks = 0;
    document.querySelector('button').onclick = () => window.clicks++;
  });
  assert.equal(await waitDrawer(page, 600), false);
  assert.equal(await page.evaluate(() => clicks), 0);
});

test('提交后等待延迟的二次确认，只点弹窗内按钮一次，等抽屉关闭才成功', async (t) => {
  const page = await localPage(t, drawer);
  await page.evaluate((html) => {
    window.drawerClicks = 0;
    window.modalClicks = 0;
    document.querySelector('button').onclick = () => {
      window.drawerClicks++;
      setTimeout(() => {
        document.body.insertAdjacentHTML('beforeend', html);
        document.querySelector('[data-tracking-id="EI1zxH-2-j_miWD1"]').onclick = () => {
          window.modalClicks++;
          setTimeout(() => { document.body.innerHTML = '发货成功'; }, 1000);
        };
      }, 2500);
    };
  }, confirmation);
  assert.equal(await submitDrawer(page), true);
  assert.deepEqual(await page.evaluate(() => [drawerClicks, modalClicks]), [1, 1]);
});

test('无二次弹窗的提交仍正常完成', async (t) => {
  const page = await localPage(t, drawer);
  await page.locator('button').evaluate((button) => {
    button.onclick = () => { document.body.innerHTML = '发货成功'; };
  });
  assert.equal(await submitDrawer(page), true);
});

test('未知确认框不自动同意、不重复点抽屉按钮，超时按失败处理', { timeout: 30000 }, async (t) => {
  const page = await localPage(t, drawer);
  await page.evaluate(() => {
    window.drawerClicks = 0;
    window.otherClicks = 0;
    document.querySelector('button').onclick = () => {
      window.drawerClicks++;
      document.body.insertAdjacentHTML('beforeend', '<div data-testid="beast-core-modal">是否取消发货？<button>确认发货</button></div>');
      document.querySelector('[data-testid="beast-core-modal"] button').onclick = () => window.otherClicks++;
    };
  });
  assert.equal(await submitDrawer(page), false);
  assert.deepEqual(await page.evaluate(() => [drawerClicks, otherClicks]), [1, 0]);
});

test('演练完整走过入口、箱数和日期时间选择，在最终确认前截图且不提交', async (t) => {
  const page = await localPage(t, `<table><tbody><tr><td>
    <label data-testid="beast-core-checkbox" data-checked="false"><input type="checkbox"></label>
    FH1234567890</td></tr></tbody></table><button data-tracking-id="R2Lild75FOBx_5nw">批量装箱发货</button>`);
  await page.evaluate(({ reminder, form }) => {
    window.steps = [];
    window.submitClicks = 0;
    document.querySelector('input').onchange = (event) => {
      event.target.closest('label').dataset.checked = String(event.target.checked);
    };
    document.querySelector('button').onclick = () => {
      steps.push('batch');
      document.body.innerHTML = reminder;
      document.querySelector('button').onclick = () => {
        steps.push(document.querySelector('input').checked ? 'reminder-checked' : 'reminder-unchecked');
        document.body.innerHTML = form + '<div id="deliveryAddressId"><input value="模拟仓库"></div>' +
          '<div id="expressCompanyId">模拟物流</div>' +
          '<div id="deliverMethod"><label><input type="radio" checked>在线物流下单</label></div>';
        document.querySelector('#expressPackageNum input').value = '9';
        const date = document.querySelector('#expectPickUpGoodsDate input');
        const time = document.querySelector('#expectPickUpGoodsTime input');
        date.value = time.value = '';
        date.onclick = () => {
          const panel = document.createElement('div');
          panel.className = 'calendar-panel';
          const rect = date.getBoundingClientRect();
          panel.style.cssText = 'position:absolute;z-index:20;width:240px;height:120px;left:' + rect.left + 'px;top:' + rect.bottom + 'px;background:white';
          for (let day = 1; day <= 31; day++) {
            const cell = document.createElement('span');
            cell.style.cssText = 'display:inline-block;width:24px;height:24px';
            cell.textContent = String(day);
            cell.onclick = () => {
              steps.push('date');
              date.value = '2026-11-' + String(day).padStart(2, '0');
              panel.remove();
            };
            panel.append(cell);
          }
          document.body.append(panel);
        };
        time.onclick = () => {
          const panel = document.createElement('div');
          panel.innerHTML = '<ul class="TPK_ul"><li class="cIL_item cIL_disabled">19</li><li class="cIL_item">20</li></ul>' +
            '<ul class="TPK_ul"><li class="cIL_item">00</li><li class="cIL_item">30</li></ul>';
          panel.querySelectorAll('.cIL_item:not(.cIL_disabled)').forEach((cell, index) => {
            cell.onclick = () => {
              steps.push(index ? 'minute' : 'hour');
              if (index) { time.value = '20:' + cell.textContent; panel.remove(); }
            };
          });
          document.body.append(panel);
        };
        document.querySelector('button').onclick = () => { submitClicks++; };
      };
    };
  }, { reminder: entry(false), form: drawer });
  CFG.dry = true;
  t.after(() => { CFG.dry = false; });
  const beforeShots = new Set(await fs.readdir(shots));
  const [target] = await collectRows(page);
  assert.equal(await processOne(page, target), true);
  assert.deepEqual(await page.evaluate(() => steps), ['batch', 'reminder-checked', 'date', 'hour', 'minute']);
  assert.equal(await page.locator('#expressPackageNum input').inputValue(), String(CFG.boxCount));
  assert.equal(await page.locator('#expectPickUpGoodsDate input').inputValue(), '2026-11-01');
  assert.equal(await page.locator('#expectPickUpGoodsTime input').inputValue(), '20:00');
  assert.equal(await page.evaluate(() => submitClicks), 0);
  assert.equal(await page.locator('[data-testid="beast-core-drawer"]').isVisible(), true);
  assert.equal(await page.locator('[data-testid="beast-core-modal"]').count(), 0);
  assert.equal((await fs.readdir(shots)).some((name) => name.startsWith('dry-ready-') && !beforeShots.has(name)), true);
});

test('演练不会点击任一层确认发货；必填校验失败也不提交', async (t) => {
  const page = await localPage(t, drawer + confirmation);
  CFG.dry = true;
  t.after(() => { CFG.dry = false; });
  await page.evaluate(() => {
    window.clicks = 0;
    document.querySelectorAll('button').forEach((button) => { button.onclick = () => window.clicks++; });
  });
  assert.equal(await submitDrawer(page), true);
  CFG.dry = false;
  await page.locator('#expectPickUpGoodsDate input').fill('');
  assert.equal(await submitDrawer(page), false);
  assert.equal(await page.evaluate(() => clicks), 0);
});

for (const [name, config, expected] of [
  ['优先 20:00，并在切换小时后重读分钟可用状态', {}, '20:00'],
  ['小时 20 禁用时选最近时段', { disabledHour: true }, '18:15'],
  ['20 点的 00 分禁用时重新选择最近小时与分钟', { disabledMinute: true }, '18:15'],
  ['预填其他时间也优先改为 20:00', { initial: '21:30' }, '20:00'],
  ['已经是 20:00 时保持原值', { initial: '20:00' }, '20:00'],
]) {
  test(name, async (t) => {
    const page = await localPage(t, drawer);
    await page.evaluate((config) => {
      window.pickerOpens = 0;
      window.disabledClicks = 0;
      const time = document.querySelector('#expectPickUpGoodsTime input');
      time.value = config.initial || '';
      time.onclick = () => {
        pickerOpens++;
        const panel = document.createElement('div');
        panel.innerHTML = '<ul class="TPK_ul"></ul><ul class="TPK_ul"></ul>';
        const [hours, minutes] = panel.querySelectorAll('ul');
        const renderMinutes = (hour) => {
          minutes.replaceChildren();
          for (const value of ['00', '15', '30']) {
            const cell = document.createElement('li');
            cell.className = 'cIL_item';
            cell.textContent = value;
            const disabled = value === '00' && (hour !== '20' || config.disabledMinute);
            if (disabled) cell.classList.add('cIL_Disabled');
            cell.onclick = () => {
              if (disabled) { disabledClicks++; return; }
              time.value = hour + ':' + value;
              panel.remove();
            };
            minutes.append(cell);
          }
        };
        for (const hour of ['18', '20', '21']) {
          const cell = document.createElement('li');
          cell.className = 'cIL_item';
          cell.textContent = hour;
          if (hour === '20' && config.disabledHour) cell.setAttribute('aria-disabled', 'true');
          cell.onclick = () => {
            if (cell.getAttribute('aria-disabled') === 'true') { disabledClicks++; return; }
            renderMinutes(hour);
          };
          hours.append(cell);
        }
        renderMinutes('18');
        document.body.append(panel);
      };
    }, config);
    assert.equal(await setPickupNearest(page), true);
    assert.equal(await page.locator('#expectPickUpGoodsTime input').inputValue(), expected);
    assert.equal(await page.evaluate(() => disabledClicks), 0);
    assert.equal(await page.evaluate(() => pickerOpens), config.initial === '20:00' ? 0 : 1);
  });
}
