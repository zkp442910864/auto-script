#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const readline = require('node:readline');
const { SEARCH_URL, readPage, collect, saveResults } = require('./collector');
const { notify } = require('./notify');

async function main() {
  const args = process.argv.slice(2);
  const value = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const limit = Number(value('limit', 200));
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('--limit 必须是 1–200 的整数');
  let chromium;
  try { ({ chromium } = require('playwright-core')); }
  catch { ({ chromium } = require('../shipping-auto/node_modules/playwright-core')); }
  const extension = value('extension', '');
  if (extension) await fs.access(path.join(path.resolve(extension), 'manifest.json'));
  const launchArgs = ['--start-maximized'];
  if (extension) launchArgs.push(`--disable-extensions-except=${path.resolve(extension)}`, `--load-extension=${path.resolve(extension)}`);
  const context = await chromium.launchPersistentContext(path.join(__dirname, extension ? '.pw-profile-chromium' : '.pw-profile'), {
    channel: extension ? 'chromium' : 'chrome', headless: false, viewport: null, args: launchArgs,
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  const page = context.pages()[0] || await context.newPage();
  const basename = `temu-${Date.now()}-${randomUUID()}`;
  const outputDir = path.join(__dirname, 'data');
  const items = new Map();
  const startedAt = new Date().toISOString();
  let stopped = false;
  let waiting = false;
  let resumeRequested = false;
  let result = { status: 'partial', reason: '采集尚未完成' };
  const inspect = async () => {
    let state = await page.evaluate(readPage);
    if (!state.blocked) {
      const current = new URL(page.url());
      const source = new URL(SEARCH_URL);
      if (current.hostname !== source.hostname || current.pathname !== source.pathname || current.searchParams.get('search_key') !== source.searchParams.get('search_key')) {
        console.log('返回指定的贴纸搜索页继续采集。');
        await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        state = await page.evaluate(readPage);
      }
    }
    return state;
  };
  const send = (message) => { if (process.connected) process.send(message, () => {}); };
  const checkpoint = async (status, reason = result.reason) => {
    const payload = await saveResults(outputDir, basename, items, { sourceUrl: SEARCH_URL, target: limit, startedAt, status, reason });
    send({ type: 'collection-progress', count: items.size, target: limit, status, missing: payload.missing, files: [`${basename}.json`, `${basename}.csv`] });
    return payload;
  };
  const stop = () => { stopped = true; context.close().catch(() => {}); };
  const onMessage = (message) => { if (message?.type === 'resume' && waiting) resumeRequested = true; };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.once('disconnect', stop);
  process.on('message', onMessage);
  context.on('close', () => { stopped = true; });
  const terminal = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  terminal?.on('line', () => { if (waiting) resumeRequested = true; });
  const pause = async (reason, autoResume) => {
    waiting = true;
    resumeRequested = false;
    console.log(`\n等待用户处理：${reason}。浏览器保持打开；处理后${autoResume ? '会自动检测继续，也可' : ''}${process.connected ? '点击控制台「继续采集」' : '在终端按回车'}。`);
    send({ type: 'user-action', waiting: true, reason });
    await checkpoint('waiting', reason);
    await fs.mkdir(path.join(__dirname, 'shots'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, 'shots', `waiting-${Date.now()}.png`), timeout: 5000 }).catch(() => {});
    await notify('Temu 采集需要你处理', reason);
    let clearPasses = 0;
    try {
      while (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (stopped) break;
        const state = await page.evaluate(readPage).catch(() => null);
        clearPasses = state && !state.blocked && state.cards.length ? clearPasses + 1 : 0;
        if ((autoResume && clearPasses >= 2) || (resumeRequested && state && !state.blocked)) break;
        if (resumeRequested) { console.log('仍检测到登录或安全验证，请处理后再继续。'); resumeRequested = false; }
      }
    } finally {
      waiting = false;
      send({ type: 'user-action', waiting: false });
    }
    if (!stopped) console.log('用户处理完成，继续采集。');
  };
  try {
    console.log(`打开 Temu 搜索页，采集前 ${limit} 条：${SEARCH_URL}`);
    console.log(`结果持续保存到：${outputDir}/${basename}.{json,csv}（主图保存为原图链接）`);
    await checkpoint('collecting');
    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(async (error) => {
      if (!stopped) await pause(`页面打开异常：${error.message}。请在浏览器中重试打开搜索页`, false);
    });
    if (!stopped) result = await collect({ page, limit, items, inspect, pause, checkpoint, stopped: () => stopped });
  } catch (error) {
    result = { status: stopped ? 'stopped' : 'failed', reason: stopped ? '用户关闭浏览器或停止采集' : error.message };
    if (!stopped) console.error(error);
  } finally {
    if (stopped) result = { status: 'stopped', reason: '用户停止采集，已保存部分结果' };
    try {
      const payload = await checkpoint(result.status);
      console.log(`${result.reason}；保存 ${items.size}/${limit} 条。字段缺失：${JSON.stringify(payload.missing)}。`);
    } finally {
      terminal?.close();
      await context.close().catch(() => {});
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      process.removeListener('disconnect', stop);
      process.removeListener('message', onMessage);
      if (process.connected) process.disconnect();
    }
    if (result.status !== 'complete' && result.status !== 'stopped') process.exitCode = 2;
  }
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; if (process.connected) process.disconnect(); });
module.exports = { main };
