/**
 * 离线验证「发货仓库」下拉选择：
 * 造一个跟创建页一样的结构——两个下拉（店铺已填 / 仓库空着），
 * 下拉面板 portal 到 body、绝对定位在触发框下方。
 * 验证点：① 只动空着的那个；② 点开面板后选中的是面板第一项；③ 店铺值不变。
 */
const { chromium } = require('playwright-core');
const { selectAllWarehouses, countEmptySelects } = require('./index.js');

const HTML = `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px">
<table><tr>
  <td>发货店铺</td><td><input id="shop" readonly placeholder="请选择" value="Magic Sticker 当前"></td>
  <td>发货仓库</td><td><input id="wh1" readonly placeholder="请选择" value=""></td>
</tr><tr>
  <td></td><td></td>
  <td>发货仓库</td><td><input id="wh2" readonly placeholder="请选择" value=""></td>
</tr></table>
<div id="panel" style="display:none"></div>
<script>
const WH = ['【沙井仓】广东省深圳市宝安区沙井街道建安路21号203','【广州仓】广州市白云区某某路1号'];
let cur = null, panel = document.getElementById('panel');
for (const id of ['shop','wh1','wh2']) {
  const inp = document.getElementById(id);
  inp.addEventListener('click', () => {
    cur = inp;
    const r = inp.getBoundingClientRect();
    panel.style.display = 'block';
    panel.style.position = 'absolute';
    panel.style.left = r.left + 'px';
    panel.style.top = (r.bottom + 4) + 'px';
    panel.style.width = Math.max(r.width, 320) + 'px';
    panel.style.background = '#fff';
    panel.style.border = '1px solid #ddd';
    panel.style.zIndex = 1000;
    const opts = id === 'shop'
      ? ['Magic Sticker 当前', 'Another Store 当前']
      : WH;
    panel.innerHTML = opts.map((t,i) =>
      '<div class="opt" data-i="'+i+'" style="padding:8px">'+t+'</div>').join('');
    panel.querySelectorAll('.opt').forEach(o => o.addEventListener('click', () => {
      cur.value = o.textContent;
      panel.style.display = 'none';
    }));
  });
}
document.addEventListener('click', (e) => {
  if (!panel.contains(e.target) && e.target.tagName !== 'INPUT') panel.style.display = 'none';
});
</script></body></html>`;

(async () => {
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const p = await b.newPage({ viewport: { width: 1200, height: 700 } });
  await p.setContent(HTML);
  await p.waitForTimeout(300);

  const before = await countEmptySelects(p);
  console.log('选择前：', JSON.stringify(before));
  const filled = await selectAllWarehouses(p);
  const after = await countEmptySelects(p);
  const vals = await p.evaluate(() => ({
    shop: document.getElementById('shop').value,
    wh1: document.getElementById('wh1').value,
    wh2: document.getElementById('wh2').value,
  }));
  console.log('选择后：', JSON.stringify(after), 'filled=', filled);
  console.log('各下拉值：', JSON.stringify(vals, null, 2));

  const pass = after.empty === 0 && vals.wh1 === '【沙井仓】广东省深圳市宝安区沙井街道建安路21号203'
    && vals.wh2 === '【沙井仓】广东省深圳市宝安区沙井街道建安路21号203'
    && vals.shop === 'Magic Sticker 当前';
  console.log(pass ? '✓ 通过：仓库都选了第一项，店铺没被动' : '✗ 失败');
  await b.close();
  process.exitCode = pass ? 0 : 1;
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
