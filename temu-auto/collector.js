'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const SEARCH_URL = 'https://www.temu.com/search_result.html?search_key=%E8%B4%B4%E7%BA%B8';

// Runs inside the page. Avoid hashed class names: identify cards by distinct goods IDs.
function readPage() {
  const visible = (el) => Boolean(el?.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const text = (el) => (el?.innerText || '').replace(/[\u200b-\u200f\ufeff]/g, '').trim();
  const idOf = (href) => {
    try {
      const url = new URL(href, location.href);
      if (!/(^|\.)temu\.com$/.test(url.hostname)) return null;
      return url.searchParams.get('goods_id') || url.pathname.match(/-g-(\d+)\.html/)?.[1] || null;
    } catch { return null; }
  };
  const links = Array.from(document.querySelectorAll('a[href]')).filter((a) => idOf(a.href) && visible(a) && !a.closest('header, footer, nav, aside'));
  const cards = [];
  const seen = new Set();
  for (const anchor of links) {
    const goodsId = idOf(anchor.href);
    if (seen.has(goodsId)) continue;
    let card = anchor;
    for (let parent = anchor.parentElement, depth = 0; parent && depth < 8 && !['BODY', 'MAIN'].includes(parent.tagName); parent = parent.parentElement, depth++) {
      const ids = new Set(Array.from(parent.querySelectorAll('a[href]')).map((a) => idOf(a.href)).filter(Boolean));
      if (ids.size > 1) break;
      card = parent;
      if (parent.matches('[data-testid*="goods-card"], [data-testid*="product-card"], [role="listitem"], article')) break;
    }
    const images = Array.from(card.querySelectorAll('img')).filter(visible);
    const image = images.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
    if (!image) continue;
    const attr = (pattern, exclude = /$a/) => Array.from(card.querySelectorAll('[data-testid], [class], [aria-label]')).filter(visible).find((el) => {
      const label = `${el.getAttribute('data-testid') || ''} ${el.className || ''} ${el.getAttribute('aria-label') || ''}`;
      return pattern.test(label) && !exclude.test(label) && !el.closest('del, s');
    });
    // Preserve newlines: a title containing a number is not a price or rating.
    const rawText = text(card);
    const price = attr(/(?:sale|current)[-_]?price/i) || attr(/(?:^|[-_\s])(?:sale[-_])?price(?:[-_\s]|$)/i, /original|list[-_]?price|old[-_]?price|retail|strike|discount|saving/i);
    const rating = attr(/rating|review[-_]?score|star[-_]?score|out of 5|\bstars?\b|颗星/i);
    const sales = attr(/sold|sales[-_]?count|sale[-_]?volume/i);
    const url = new URL(anchor.href);
    url.hash = '';
    cards.push({ goodsId, url: url.href, title: image.alt || anchor.getAttribute('title') || '', mainImage: image.currentSrc || image.getAttribute('data-src') || image.src || '', rawText,
      priceText: text(price), ratingText: [rating?.getAttribute('aria-label'), text(rating)].filter(Boolean).join(' '), salesText: text(sales) });
    seen.add(goodsId);
  }
  const challenge = /验证码|安全验证|请完成验证|验证您是|验证你是|拖动滑块|滑动验证|点击.*验证|verify (?:that )?you(?:'re| are)|security verification|complete (?:the )?(?:captcha|verification)|unusual (?:traffic|activity)|access denied|press and hold|确认您是真人|请确认您/iu;
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="captcha"], [id*="captcha"]')).filter(visible);
  const bodyText = text(document.body);
  const frameChallenge = Array.from(document.querySelectorAll('iframe')).some((el) => visible(el) && /captcha|challenge|verify|verification/i.test(`${el.src} ${el.title}`));
  const login = /\/(?:login|signin|passport)(?:\.html|\/|\?)/i.test(location.href) || dialogs.some((el) => /登录\s*[/／]\s*注册|sign in\s*[/／]\s*register|log in to continue/i.test(text(el)));
  const verification = /captcha|verify|verification|challenge/i.test(location.pathname) || frameChallenge || dialogs.some((el) => challenge.test(text(el))) || (!cards.length && challenge.test(bodyText));
  const end = !login && !verification && /没有更多(?:商品|结果|了)?|已展示全部|暂无(?:商品|结果)|未找到(?:相关)?商品|no more (?:items|products|results)|no results found|we (?:couldn.t|could not) find/i.test(bodyText);
  const more = Array.from(document.querySelectorAll('button, [role="button"], a')).filter(visible).find((el) => /^(?:加载更多|查看更多|显示更多|更多商品|load more|show more|view more|see more)$/i.test(text(el)));
  return { cards, blocked: login ? '请在浏览器中完成 Temu 登录' : verification ? '请在浏览器中完成 Temu 安全验证' : null, end, hasMore: Boolean(more && !more.disabled && more.getAttribute('aria-disabled') !== 'true') };
}

function parseCard(card) {
  const lines = card.rawText.split(/\n/).map((line) => line.trim()).filter(Boolean);
  const money = /(?:US\s*\$|AU\s*\$|CA\s*\$|HK\s*\$|NZ\s*\$|NT\s*\$|R\s*\$|[¥￥$€£₩₹]|(?:USD|CNY|RMB|EUR|GBP|CAD|AUD)\s*)\s*\d[\d.,]*(?:\s*[-–]\s*\d[\d.,]*)?|\d[\d.,]*\s*(?:元|USD|CNY|EUR|GBP)/i;
  const sold = /(?:\d[\d.,]*\s*(?:[kKmMbB万千百]|million|thousand)?\+?\s*(?:件)?\s*(?:sold|销量|已售|售出))|(?:(?:销量|已售|售出|sold)\s*[:：]?\s*\d[\d.,]*\s*[kKmMbB万千百]?\+?\s*(?:件)?)/i;
  const price = card.priceText.replace(/\s*[\r\n]+\s*/g, '').match(money)?.[0] || lines.filter((line) => line !== card.title && !/原价|划线价|original|list price|was\s|save|节省|立减|满减|\boff\b/i.test(line)).map((line) => line.match(money)?.[0]).find(Boolean) || null;
  const rating = card.ratingText.match(/(?:^|[^\d])([0-5](?:[.,]\d{1,2})?)(?=\s*(?:\/\s*5|out of 5|stars?|颗星|分|$))/i)?.[1] || lines.find((line) => /^[0-5][.,]\d{1,2}$/.test(line)) || null;
  return { goodsId: card.goodsId, title: card.title, url: card.url, mainImage: /^https?:\/\//.test(card.mainImage) ? card.mainImage : null, price, rating, sales: (card.salesText || '').match(sold)?.[0] || lines.map((line) => line.match(sold)?.[0]).find(Boolean) || null, rawText: card.rawText };
}

function mergeCards(items, cards, limit) {
  let added = 0;
  for (const raw of cards) {
    const card = parseCard(raw);
    const existing = items.get(card.goodsId);
    if (existing) {
      for (const field of ['mainImage', 'price', 'rating', 'sales', 'title']) if (!existing[field] && card[field]) existing[field] = card[field];
    } else if (items.size < limit) { items.set(card.goodsId, card); added++; }
  }
  return added;
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

async function saveResults(directory, basename, items, metadata) {
  await fs.mkdir(directory, { recursive: true });
  const rows = Array.from(items.values(), (item, index) => ({ rank: index + 1, ...item }));
  const missing = Object.fromEntries(['mainImage', 'price', 'rating', 'sales'].map((field) => [field, rows.filter((row) => !row[field]).length]));
  const payload = { ...metadata, count: rows.length, missing, updatedAt: new Date().toISOString(), items: rows };
  const columns = ['rank', 'goodsId', 'title', 'mainImage', 'price', 'rating', 'sales', 'url'];
  const csv = '\ufeff' + [['序号', '商品ID', '标题', '主图链接', '价格', '评分', '销量', '商品链接'], ...rows.map((row) => columns.map((key) => row[key]))].map((row) => row.map(csvCell).join(',')).join('\r\n');
  for (const [extension, content] of [['json', JSON.stringify(payload, null, 2)], ['csv', csv]]) {
    const file = path.join(directory, `${basename}.${extension}`);
    await fs.writeFile(`${file}.tmp`, content);
    await fs.rename(`${file}.tmp`, file);
  }
  return payload;
}

async function advancePage(page) {
  const more = page.getByRole('button', { name: /^(?:加载更多|查看更多|显示更多|更多商品|load more|show more|view more|see more)$/i }).or(page.getByRole('link', { name: /^(?:加载更多|查看更多|显示更多|更多商品|load more|show more|view more|see more)$/i }));
  for (let i = 0; i < await more.count(); i++) {
    const button = more.nth(i);
    if (await button.isVisible() && await button.isEnabled()) { await button.click({ timeout: 5000 }); return 'more'; }
  }
  // Small increments keep the order of cards even when the page virtualizes its list.
  await page.evaluate(() => {
    const elements = [document.scrollingElement, ...document.querySelectorAll('main, [role="main"], [role="list"], [class*="scroll"]')].filter(Boolean);
    const scroll = elements.filter((el) => el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200).sort((a, b) => b.clientHeight - a.clientHeight)[0];
    if (scroll) scroll.scrollBy(0, Math.max(350, scroll.clientHeight * 0.75));
    else window.scrollBy(0, Math.max(350, innerHeight * 0.75));
  });
  return 'scroll';
}

async function collect({ page, limit = 200, inspect = () => page.evaluate(readPage), advance = () => advancePage(page), pause, checkpoint, log = console.log, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), interval = 1600, stopped = () => false, items = new Map() }) {
  let idle = 0;
  let endSeen = 0;
  while (!stopped()) {
    let state;
    try { state = await inspect(); }
    catch (error) {
      if (stopped()) break;
      if (/Execution context was destroyed|Cannot find context|navigation/i.test(error.message)) { await delay(interval); continue; }
      throw error;
    }
    if (state.blocked) { await pause(state.blocked, true); idle = 0; continue; }
    const added = mergeCards(items, state.cards, limit);
    if (added) { idle = 0; log(`已采集 ${items.size}/${limit} 条（本轮新增 ${added} 条）`); await checkpoint('collecting'); }
    else idle++;
    if (items.size >= limit) return { status: 'complete', reason: '已达到采集数量' };
    // End markers may sit below cards that have not lazy-loaded yet; confirm after another pass.
    endSeen = state.end && !state.hasMore ? endSeen + 1 : 0;
    if (endSeen >= 3 && idle >= 2) return { status: 'partial', reason: `页面已无更多结果，仅采集 ${items.size}/${limit} 条` };
    if (idle >= 15) {
      await checkpoint('waiting');
      await pause(`连续未发现新商品（${items.size}/${limit}）。请检查登录、验证、地区/优惠弹窗或手动加载更多，处理后点击继续采集`, false);
      idle = 0;
    }
    if (stopped()) break;
    try { await advance(); }
    catch (error) {
      if (stopped()) break;
      log(`加载更多暂未完成，将重新检查页面：${error.message}`);
    }
    await delay(interval);
  }
  return { status: 'stopped', reason: '用户停止采集，已保存部分结果' };
}

module.exports = { SEARCH_URL, readPage, parseCard, mergeCards, saveResults, advancePage, collect };
