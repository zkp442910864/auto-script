const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
(async () => {
  const img = path.resolve(process.argv[2]);
  const x = +process.argv[3], y = +process.argv[4], w = +process.argv[5], h = +process.argv[6];
  const scale = +(process.argv[7] || 4);
  const out = path.resolve(process.argv[8] || 'shots/crop.png');
  const html = `<html><body style="margin:0;overflow:hidden;background:#fff">
  <img src="file:///${img.replace(/\\/g, '/')}" style="position:absolute;left:${-x * scale}px;top:${-y * scale}px;transform-origin:0 0;transform:scale(${scale})">
  </body></html>`;
  const tmp = path.resolve('shots/_crop.html');
  fs.writeFileSync(tmp, html, 'utf8');
  const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--allow-file-access-from-files'] });
  const p = await b.newPage({ viewport: { width: Math.round(w * scale), height: Math.round(h * scale) } });
  await p.goto('file:///' + tmp.replace(/\\/g, '/'));
  await p.waitForTimeout(800);
  const ok = await p.evaluate(() => { const i = document.querySelector('img'); return i.complete && i.naturalWidth; });
  console.log('img loaded width:', ok);
  await p.screenshot({ path: out });
  await b.close();
  console.log('saved', out);
})();
