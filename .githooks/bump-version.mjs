#!/usr/bin/env node
/**
 * 版本号递增工具
 *
 *   node .githooks/bump-version.mjs          # 手动递增 patch（1.0.0 → 1.0.1）
 *   node .githooks/bump-version.mjs minor    # 手动递增 minor（1.0.1 → 1.1.0）
 *   node .githooks/bump-version.mjs major    # 手动递增 major（1.1.0 → 2.0.0）
 *   node .githooks/bump-version.mjs --auto   # pre-commit 调用：工作区版本与 HEAD 一致时才递增
 *   node .githooks/bump-version.mjs --shell  # 强制连桌面壳（tauri2/）版本一起递增
 *
 * 两套版本号：
 *   1. 根 package.json —— 业务项目版本（每次 main 提交递增），同步 package-lock.json
 *      的根版本字段（top-level "version" 与 packages[""].version）。
 *   2. tauri2/ 桌面壳版本 —— 只在本次提交包含 tauri2/ 改动时递增，四处必须一致：
 *      tauri2/package.json、tauri2/src-tauri/tauri.conf.json、Cargo.toml、Cargo.lock。
 *      Release 标签 shell-v<版本号> 取自 tauri2/package.json，所以这几个文件不能各走各的。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const KINDS = ['major', 'minor', 'patch'];
const args = process.argv.slice(2);
const AUTO = args.includes('--auto');
const FORCE_SHELL = args.includes('--shell');
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
const rootManual = AUTO && headVersion !== null && headVersion !== current;
if (rootManual) console.log(`📦 版本号已手动改为 ${current}，跳过业务版本递增`);

if (!rootManual) {
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
}

// ---------------------------------------------------------------------------
// 桌面壳版本（tauri2/）
// 只有本次提交动到 tauri2/ 才递增——这样 shell-v<版本> 标签与壳的发布一一对应，
// 业务代码提交不会白白消耗壳的版本号。
// ---------------------------------------------------------------------------
const stagedTouchesShell = () => {
  try {
    const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
      encoding: 'utf8',
    });
    return out.split('\n').some((p) => p.trim().startsWith('tauri2/'));
  } catch {
    return false;
  }
};

if (FORCE_SHELL || stagedTouchesShell()) {
  const SHELL_PKG = 'tauri2/package.json';
  if (!existsSync(SHELL_PKG)) fail(`${SHELL_PKG} 不存在，无法递增桌面壳版本`);

  const shellCurrent = String(readJson(SHELL_PKG).version || '');
  if (!/^\d+\.\d+\.\d+/.test(shellCurrent)) {
    fail(`${SHELL_PKG} 的 version 不是合法的 x.y.z 形式：${JSON.stringify(shellCurrent)}`);
  }

  // 手改过壳版本（与 HEAD 不同）时尊重手改值，不再自动递增
  const shellHeadVersion = (() => {
    try {
      const raw = execFileSync('git', ['show', `HEAD:${SHELL_PKG}`], { encoding: 'utf8' });
      return String(JSON.parse(raw).version || '');
    } catch {
      return null;
    }
  })();

  if (shellHeadVersion !== null && shellHeadVersion !== shellCurrent) {
    console.log(`📦 桌面壳版本已手动改为 ${shellCurrent}，跳过自动递增`);
  } else {
    const [sMajor, sMinor, sPatch] = shellCurrent.split(/[.+-]/).slice(0, 3).map(Number);
    const shellNext =
      KIND === 'major'
        ? `${sMajor + 1}.0.0`
        : KIND === 'minor'
          ? `${sMajor}.${sMinor + 1}.0`
          : `${sMajor}.${sMinor}.${sPatch + 1}`;

    const ver = '\\d+\\.\\d+\\.\\d+(?:[-+][^"]*)?';
    // 三个 JSON/TOML 文件都是"只替换版本字面量"，保留原有排版
    const targets = [
      { path: SHELL_PKG, re: new RegExp(`("version"\\s*:\\s*")(${ver})(")`) },
      { path: 'tauri2/src-tauri/tauri.conf.json', re: new RegExp(`("version"\\s*:\\s*")(${ver})(")`) },
      { path: 'tauri2/src-tauri/Cargo.toml', re: new RegExp(`(^version\\s*=\\s*")(${ver})(")`, 'm') },
    ];
    const touched = [];
    for (const { path, re } of targets) {
      if (!existsSync(path)) continue;
      const raw = readFileSync(path, 'utf8');
      if (!re.test(raw)) {
        console.error(`bump-version: 在 ${path} 里找不到版本字段，已跳过`);
        continue;
      }
      writeFileSync(path, raw.replace(re, `$1${shellNext}$3`));
      touched.push(path);
    }

    // Cargo.lock 里本包那一条也要跟着改，否则 cargo build 会重新改写、留下脏工作区
    const LOCK = 'tauri2/src-tauri/Cargo.lock';
    if (existsSync(LOCK)) {
      const lockRaw = readFileSync(LOCK, 'utf8');
      const lockRe = new RegExp(
        `(\\[\\[package\\]\\]\\nname = "auto-console-shell"\\nversion = ")(${ver})(")`,
      );
      if (lockRe.test(lockRaw)) {
        writeFileSync(LOCK, lockRaw.replace(lockRe, `$1${shellNext}$3`));
        touched.push(LOCK);
      }
    }

    console.log(`📦 桌面壳版本 ${shellCurrent} → ${shellNext}（${touched.length} 个文件）`);
  }
}
