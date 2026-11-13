#!/usr/bin/env node
/**
 * 版本号递增工具
 *
 *   node .githooks/bump-version.mjs          # 手动递增 patch（1.0.0 → 1.0.1）
 *   node .githooks/bump-version.mjs minor    # 手动递增 minor（1.0.1 → 1.1.0）
 *   node .githooks/bump-version.mjs major    # 手动递增 major（1.1.0 → 2.0.0）
 *   node .githooks/bump-version.mjs --auto   # pre-commit 调用：工作区版本与 HEAD 一致时才递增
 *
 * 只改根 package.json 的 version，并同步 package-lock.json 的根版本字段
 * （top-level "version" 与 packages[""].version），避免 lockfile 与 package.json 不一致。
 * 不涉及 tauri2/ 的独立版本号。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const KINDS = ['major', 'minor', 'patch'];
const args = process.argv.slice(2);
const AUTO = args.includes('--auto');
const KIND = args.find((a) => KINDS.includes(a)) || 'patch';

const fail = (msg) => {
  console.error(`bump-version: ${msg}`);
  process.exit(1);
};

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

if (!existsSync('package.json')) fail('当前目录没有 package.json');

const pkg = readJson('package.json');
const current = String(pkg.version || '');
const parsed = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
if (!parsed) fail(`package.json 的 version 不是合法的 x.y.z 形式：${JSON.stringify(current)}`);

const headVersion = (() => {
  try {
    return String(JSON.parse(execFileSync('git', ['show', 'HEAD:package.json'], { encoding: 'utf8' })).version || '');
  } catch {
    return null; // 首次提交 / 尚无 HEAD
  }
})();

// --auto：工作区版本已经被手动改过（与 HEAD 不同）就尊重用户，不重复递增
if (AUTO && headVersion !== null && headVersion !== current) {
  console.log(`📦 版本号已手动改为 ${current}，跳过自动递增`);
  process.exit(0);
}

const [major, minor, patch] = parsed.slice(1).map(Number);
const next =
  KIND === 'major'
    ? `${major + 1}.0.0`
    : KIND === 'minor'
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;

// package.json：只替换顶层 version 那一行，保留原有排版（不整文件重排）
const pkgRaw = readFileSync('package.json', 'utf8');
const versionRe = /("version"\s*:\s*")(\d+\.\d+\.\d+(?:[-+][^"]*)?)(")/;
if (!versionRe.test(pkgRaw)) fail('package.json 里找不到顶层的 "version" 字段');
writeFileSync('package.json', pkgRaw.replace(versionRe, `$1${next}$3`));

// package-lock.json：同步根版本，避免 npm ci / npm install 时告警
let lockSynced = false;
if (existsSync('package-lock.json')) {
  const lock = readJson('package-lock.json');
  if (lock.version === current) {
    lock.version = next;
    lockSynced = true;
  }
  if (lock.packages && lock.packages[''] && lock.packages[''].version === current) {
    lock.packages[''].version = next;
    lockSynced = true;
  }
  if (lockSynced) writeFileSync('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);
}

console.log(
  `📦 版本号 ${current} → ${next}${AUTO ? '（main 分支提交自动递增）' : `（手动 ${KIND}）`}` +
    (lockSynced ? '，已同步 package-lock.json' : ''),
);
