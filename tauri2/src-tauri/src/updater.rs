//! 在线更新：GitHub zip 下载 → 剥顶层目录 → 排除受保护路径 → 备份 → 覆盖业务目录
//! → 依赖清单有变化则自动重跑依赖安装 → 服务在运行则重启。
//!
//! 首次初始化（[`crate::bootstrap::fetch_code_blocking`]）复用本模块的安全解压
//! [`extract_archive`]：两条路径共用同一套路径穿越防护与顶层目录剥离逻辑。
//!
//! 安全要点：
//! - **路径穿越防护**：zip 条目名必须经过 [`resolve_entry_path`] 校验（拒绝 `..`、
//!   绝对路径、盘符），落盘前再断言目标仍在临时目录内；
//! - **受保护路径**：判定前先经 [`normalize_rel_path`] 归一化（折叠 `//`、`.`、`..`
//!   并做大小写折叠），避免被 `shipping-auto//.pw-profile/...` 之类的写法绕过；
//! - **可回滚**：覆盖前把将被覆盖的现存文件全量备份到 `appData/backups/<timestamp>/`，
//!   中途失败自动回滚；成功后只保留最近一次备份。
//!
//! 受保护数据（绝不覆盖/删除）：
//! - `shipping-auto/.pw-profile/`（浏览器登录态）
//! - `packing-auto/.pw-profile/`（浏览器登录态）
//! - `.web-runs/`（运行日志）
//! - `login-auto/shots/`、`shipping-auto/shots/`、`packing-auto/shots/`（截图）
//! - `.login-state.json`
//! - 任意层级的 `node_modules/` 与 `.git/`

use std::cmp::Ordering;
use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::bootstrap;
use crate::config;
use crate::proc_util;
use crate::service::{self, Phase};

/// 受保护目录前缀（相对业务目录、小写、`/` 分隔、以 `/` 结尾）。
const PROTECTED_PREFIXES: &[&str] = &[
    "shipping-auto/.pw-profile/",
    "shipping-auto/shots/",
    "packing-auto/.pw-profile/",
    "packing-auto/shots/",
    ".web-runs/",
    "login-auto/shots/",
];

/// 受保护文件（小写）。
const PROTECTED_FILES: &[&str] = &[".login-state.json"];

/// 任意层级都排除的目录名。
const EXCLUDED_DIRS: &[&str] = &["node_modules", ".git"];

/// 业务目录已知的顶层条目：顶层与它们同名时不视为压缩包根目录（D6）。
const KNOWN_TOP_LEVEL: &[&str] = &[
    "web",
    "shared",
    "shipping-auto",
    "packing-auto",
    "login-auto",
    ".web-runs",
    ".git",
    "node_modules",
];

/// 更新检查结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub has_update: bool,
    pub local_version: String,
    pub remote_version: Option<String>,
    pub message: Option<String>,
}

/// 覆盖计划项。
struct CopyPlan {
    src: PathBuf,
    rel: String,
    /// 覆盖前的旧文件备份路径；`None` 表示目标是新文件（回滚时删除即可）
    backup: Option<PathBuf>,
}

/// 生成 `dest` 同目录下的临时文件路径（用于「先写临时文件再 rename」的原子替换）。
fn sibling_temp_path(dest: &Path) -> PathBuf {
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temp_name = format!(".{name}.autoupdate.tmp");
    match dest.parent() {
        Some(parent) => parent.join(temp_name),
        None => PathBuf::from(temp_name),
    }
}

/// 向前端发送更新过程日志。
fn emit_log(app: &AppHandle, line: &str) {
    service::append_log_line(app, &format!("[update] {line}"));
    let _ = app.emit("update-log", line.to_string());
}

/// 构造 HTTP 客户端。
fn http_client(timeout: Duration) -> anyhow::Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| anyhow::anyhow!("创建 HTTP 客户端失败：{e}"))
}

/// 同步 GET 文本。
fn fetch_text(url: &str) -> anyhow::Result<String> {
    http_client(Duration::from_secs(30))?
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(|e| anyhow::anyhow!("网络请求失败：{e}"))
}

/// 归一化仓库地址已移入 [`config`]（仓库地址现在是写死的常量）。

/// 读取本地业务 package.json 的 version。
pub fn read_local_version(dir: &Path) -> String {
    fs::read_to_string(dir.join("package.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("version").and_then(|x| x.as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| "未知".into())
}

// ---------------------------------------------------------------------------
// 版本比较（D12：semver 解析 + 非标准串容错）
// ---------------------------------------------------------------------------

/// 版本串归一化：去 `v` 前缀与首尾空白、核心段补零到三段、多余段丢弃（视作 build metadata）。
fn normalize_version(v: &str) -> String {
    let trimmed = v.trim();
    let trimmed = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    let (core, suffix) = match trimmed.find(|c: char| c == '-' || c == '+') {
        Some(idx) => trimmed.split_at(idx),
        None => (trimmed, ""),
    };
    let parts: Vec<&str> = core.split('.').collect();
    let mut core_parts: Vec<&str> = parts.iter().take(3).copied().collect();
    while core_parts.len() < 3 {
        core_parts.push("0");
    }
    format!("{}{}", core_parts.join("."), suffix)
}

/// 回退比较：按 `.`/`-`/`+` 切分取数字逐段比较（用于 semver 解析失败的非标准版本串）。
fn compare_numeric(a: &str, b: &str) -> Ordering {
    let parse = |v: &str| -> Vec<u64> {
        v.split(|c: char| c == '.' || c == '-' || c == '+')
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (pa, pb) = (parse(a), parse(b));
    let len = pa.len().max(pb.len());
    for i in 0..len {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        if x != y {
            return x.cmp(&y);
        }
    }
    Ordering::Equal
}

/// 版本比较：优先用 semver 语义（正确处理预发布标签），解析失败时回退到数字比较。
///
/// 容错：忽略 `v` 前缀与首尾空白、`1.0` 自动补零为 `1.0.0`。
///
/// 注意必须用 `cmp_precedence`：`Version` 的 `Ord` 是派生实现，会把 build metadata
/// 也比进去（`1.0.0+build.5 > 1.0.0`），而 semver 规定 build metadata 不参与排序。
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let (na, nb) = (normalize_version(a), normalize_version(b));
    match (semver::Version::parse(&na), semver::Version::parse(&nb)) {
        (Ok(va), Ok(vb)) => va.cmp_precedence(&vb),
        _ => compare_numeric(&na, &nb),
    }
}

// ---------------------------------------------------------------------------
// 受保护路径（D2：分量归一化 + 大小写折叠）
// ---------------------------------------------------------------------------

/// 归一化相对路径：统一分隔符、丢弃空段与 `.`、遇 `..` 弹栈、转小写。
///
/// 文件系统会把 `a//b`、`a/./b`、`a/x/../b` 折叠成同一路径，大小写不敏感文件系统
/// （macOS/Windows）还会折叠大小写；因此受保护判定必须先把路径归一化，否则可被绕过。
pub(crate) fn normalize_rel_path(rel: &str) -> String {
    let unified = rel.replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for seg in unified.split('/') {
        match seg {
            "" | "." => continue,
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/").to_lowercase()
}

/// 判断（相对业务目录的）路径是否受保护：更新时一律跳过。
pub fn is_protected(rel: &str) -> bool {
    let norm = normalize_rel_path(rel);
    if norm.is_empty() {
        return false;
    }
    if PROTECTED_FILES.contains(&norm.as_str()) {
        return true;
    }
    if PROTECTED_PREFIXES.iter().any(|p| norm.starts_with(p)) {
        return true;
    }
    // 任意层级的 node_modules / .git
    norm.split('/').any(|seg| EXCLUDED_DIRS.contains(&seg))
}

// ---------------------------------------------------------------------------
// zip 条目路径解析（D1：路径穿越防护；D6：顶层目录剥离校验）
// ---------------------------------------------------------------------------

/// 校验并归一化 zip 条目名，返回安全的相对路径（**尚未剥离顶层目录**）。
///
/// 返回：
/// - `Ok(Some(rel))`：应写入 `rel`（已统一为 `/` 分隔、已折叠空段与 `.`）；
/// - `Ok(None)`：目录条目 / 空路径，跳过；
/// - `Err(msg)`：非法条目（含 `..`、绝对路径、带盘符、Windows 下的 NTFS ADS 冒号），
///   调用方必须拒绝整个更新包。
///
/// 这是本模块唯一的「entry 名 → 相对路径」入口，回归测试应直接调用它。
pub(crate) fn resolve_entry_path(entry_name: &str) -> Result<Option<String>, String> {
    let unified = entry_name.replace('\\', "/");
    if unified.trim().is_empty() {
        return Ok(None);
    }
    // 绝对路径（Unix）
    if unified.starts_with('/') {
        return Err(format!("拒绝绝对路径条目：{entry_name}"));
    }
    // 盘符（Windows）
    let bytes = unified.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return Err(format!("拒绝带盘符的条目：{entry_name}"));
    }
    // K5：Windows NTFS 备用数据流（`file.txt:stream`）可绕过普通文件语义。
    // 仅 Windows 拒绝：macOS/Linux 上 `:` 是合法文件名字符。
    #[cfg(windows)]
    {
        if unified.split('/').any(|seg| seg.contains(':')) {
            return Err(format!("拒绝包含 NTFS 备用数据流冒号的条目：{entry_name}"));
        }
    }

    let is_dir_entry = unified.ends_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for seg in unified.split('/') {
        match seg {
            "" | "." => continue,
            ".." => return Err(format!("拒绝包含 .. 的条目：{entry_name}")),
            other => parts.push(other),
        }
    }
    if parts.is_empty() || is_dir_entry {
        return Ok(None);
    }
    Ok(Some(parts.join("/")))
}

/// 判断压缩包是否存在统一顶层目录（GitHub archive 形如 `<repo>-<branch>/`）。
///
/// 仅当所有条目共享同一个首段、该首段不是已知业务顶层目录、且形如 `<repo>-<branch>`
/// （至少包含一个 `-`）时才返回该首段；否则返回 `None`（按原结构处理，避免误剥）。
///
/// 绝对路径 / 带盘符的恶意条目会被后续 [`resolve_entry_path`] 拒绝，这里跳过它们，
/// 以免污染「统一顶层目录」的判定。
pub(crate) fn detect_archive_root(names: &[String]) -> Option<String> {
    let mut root: Option<String> = None;
    let mut seen_valid = false;
    for name in names {
        let unified = name.replace('\\', "/");
        if unified.starts_with('/') {
            continue;
        }
        let bytes = unified.as_bytes();
        if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
            continue;
        }
        let Some(first) = unified.split('/').find(|s| !s.is_empty()) else {
            continue;
        };
        seen_valid = true;
        match &root {
            None => root = Some(first.to_string()),
            Some(existing) if existing == first => {}
            Some(_) => return None,
        }
    }
    if !seen_valid {
        return None;
    }
    let root = root?;
    if KNOWN_TOP_LEVEL.iter().any(|k| k.eq_ignore_ascii_case(&root)) {
        return None;
    }
    if !root.contains('-') {
        return None;
    }
    Some(root)
}

/// 剥离前校验（K3）：检测「混合结构包」——根级文件与疑似仓库顶层目录（`<x>-<y>/`）并存。
///
/// 判据：存在根级文件、存在形如 `<x>-<y>` 且不是已知业务顶层目录的目录、
/// 且该目录内本身带 `package.json` / `package-lock.json` / `web/server.js`（像一个仓库根）。
/// 满足则返回该顶层目录名，调用方应**拒绝本次更新**——否则会把 `repo-main/` 整目录
/// 写进业务目录，更新「看起来成功实则没生效」。
///
/// 纯扁平包（无 `x-y/` 目录或该目录下无仓库标志文件）不受影响。
pub(crate) fn detect_mixed_structure(names: &[String]) -> Option<String> {
    let mut has_root_file = false;
    let mut suspicious: Option<String> = None;
    let mut manifest_dirs: BTreeSet<String> = BTreeSet::new();

    for name in names {
        let unified = name.replace('\\', "/");
        if unified.starts_with('/') {
            continue;
        }
        let is_dir_entry = unified.ends_with('/');
        let parts: Vec<&str> = unified
            .split('/')
            .filter(|s| !s.is_empty() && *s != ".")
            .collect();
        if parts.is_empty() {
            continue;
        }
        if parts.len() == 1 {
            if !is_dir_entry {
                has_root_file = true; // 根级文件（如 package.json / README.md）
            }
            continue;
        }
        let first = parts[0];
        // 目录内带仓库标志文件 → 该目录像一个仓库根
        let looks_like_repo_root = (parts.len() == 2
            && (parts[1] == "package.json" || parts[1] == "package-lock.json"))
            || (parts.len() == 3 && parts[1] == "web" && parts[2] == "server.js");
        if looks_like_repo_root {
            manifest_dirs.insert(first.to_string());
        }
        if suspicious.is_none()
            && first.contains('-')
            && !KNOWN_TOP_LEVEL.iter().any(|k| k.eq_ignore_ascii_case(first))
        {
            suspicious = Some(first.to_string());
        }
    }

    if !has_root_file {
        return None;
    }
    let candidate = suspicious?;
    if manifest_dirs.contains(&candidate) {
        Some(candidate)
    } else {
        None
    }
}

/// 剥掉压缩包顶层目录：`repo-main/web/server.js` → `web/server.js`。
///
/// 返回 `None` 表示该条目就是顶层目录本身或不在顶层目录之下（应跳过）。
pub(crate) fn strip_archive_root(rel: &str, root: &str) -> Option<String> {
    if rel == root {
        return None;
    }
    let prefix = format!("{root}/");
    rel.strip_prefix(&prefix).map(|rest| rest.to_string())
}

/// 解压 zip 到 `dest_root`：路径穿越防护、剥顶层目录、跳过受保护路径。
///
/// `log` 用于输出解压过程中的中文提示（在线更新传 update-log，首次初始化传 bootstrap-log），
/// 使首次下载与在线更新共用同一套安全解压逻辑。
pub fn extract_archive(
    zip_path: &Path,
    dest_root: &Path,
    log: &dyn Fn(&str),
) -> anyhow::Result<()> {
    let file = fs::File::open(zip_path).map_err(|e| anyhow::anyhow!("打开下载文件失败：{e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| anyhow::anyhow!("读取 zip 失败（文件可能损坏）：{e}"))?;

    // 第一遍：收集条目名，判断是否需要剥顶层目录
    let mut names: Vec<String> = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| anyhow::anyhow!("读取 zip 条目失败：{e}"))?;
        names.push(entry.name().to_string());
    }
    let root = detect_archive_root(&names);
    match &root {
        Some(r) => log(&format!("检测到压缩包顶层目录 {r}/，已剥离")),
        None => {
            // K3：混合结构（根级文件 + 疑似仓库顶层目录）必须拒绝，否则会把
            // `repo-main/` 整目录写进业务目录，更新看似成功实则未生效。
            if let Some(candidate) = detect_mixed_structure(&names) {
                log(&format!(
                    "更新包结构异常：同时存在根级文件与疑似仓库目录 {candidate}/，已中止更新"
                ));
                anyhow::bail!(
                    "更新包结构异常：未找到统一的顶层目录（同时存在根级文件与 {candidate}/），已中止更新。请检查仓库打包方式。"
                );
            }
            log("压缩包无统一顶层目录，按原结构处理");
        }
    }

    // 第二遍：逐条校验并落盘
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| anyhow::anyhow!("读取 zip 条目失败：{e}"))?;
        let entry_name = entry.name().to_string();
        let rel = match resolve_entry_path(&entry_name) {
            Ok(Some(rel)) => rel,
            Ok(None) => continue, // 目录条目 / 空路径
            Err(msg) => {
                anyhow::bail!("更新包包含非法路径条目，已中止更新（安全保护）：{msg}");
            }
        };
        let rel = match &root {
            Some(r) => match strip_archive_root(&rel, r) {
                Some(inner) => inner,
                None => continue, // 顶层目录条目本身 / 不在顶层目录下的异常条目
            },
            None => rel,
        };
        if rel.is_empty() || is_protected(&rel) {
            continue; // 受保护路径 / node_modules / .git 不解压
        }
        let dest = dest_root.join(&rel);
        // 双重保险：归一化 + join 之后必须仍在目标目录内
        if !dest.starts_with(dest_root) {
            anyhow::bail!("拒绝越界写入目标：{rel}");
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| anyhow::anyhow!("创建目录失败：{e}"))?;
        }
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| anyhow::anyhow!("读取 zip 内容失败：{e}"))?;
        fs::write(&dest, &buf).map_err(|e| anyhow::anyhow!("解压写入失败：{e}"))?;
    }
    Ok(())
}

/// 判断「目录」是否受保护（用于遍历剪枝：前缀判定对目录本身也生效，
/// 避免为了生成报告而递归整棵 node_modules）。
fn dir_is_protected(rel: &str) -> bool {
    let norm = normalize_rel_path(rel);
    if norm.is_empty() {
        return false;
    }
    if norm.split('/').any(|seg| EXCLUDED_DIRS.contains(&seg)) {
        return true;
    }
    let with_slash = format!("{norm}/");
    PROTECTED_PREFIXES.iter().any(|p| with_slash.starts_with(p))
}

/// 判断是否为原子替换残留的临时文件名（`.<name>.autoupdate.tmp`）。
///
/// 进程在 `copy → rename` 之间被强杀（强退/断电）时会残留这类文件，
/// 它们不是业务文件，既不能收集也不能在「远端已移除」报告里出现。
fn is_stale_temp_name(name: &str) -> bool {
    name.starts_with('.') && name.ends_with(".autoupdate.tmp")
}

/// 递归收集目录下所有文件（绝对路径, 相对路径）。
///
/// 受保护目录（`.pw-profile`、`shots`、`.web-runs`、`node_modules`、`.git` 等）直接剪枝，
/// 既不参与回溯，也不会拖慢大目录遍历；原子替换残留的临时文件同样跳过。
fn collect_files(root: &Path, rel: &str, out: &mut Vec<(PathBuf, String)>) {
    let Ok(entries) = fs::read_dir(root.join(rel)) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let path = root.join(&child_rel);
        if path.is_dir() {
            if dir_is_protected(&child_rel) {
                continue; // 剪枝
            }
            collect_files(root, &child_rel, out);
        } else {
            if is_stale_temp_name(&name) {
                continue; // 残留临时文件不算业务文件
            }
            out.push((path, child_rel));
        }
    }
}

/// 递归收集目录下的残留临时文件（跳过受保护目录），用于更新前清理。
fn collect_stale_temp_files(root: &Path, rel: &str, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root.join(rel)) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let path = root.join(&child_rel);
        if path.is_dir() {
            if dir_is_protected(&child_rel) {
                continue; // 不进 node_modules / 受保护目录
            }
            collect_stale_temp_files(root, &child_rel, out);
        } else if is_stale_temp_name(&name) {
            out.push(path);
        }
    }
}

/// 更新开始前清理上次被中断更新残留的临时文件，并把清理条数写进 update-log。
fn cleanup_stale_temp_files(app: &AppHandle, target: &Path) {
    let mut stale: Vec<PathBuf> = Vec::new();
    collect_stale_temp_files(target, "", &mut stale);
    if stale.is_empty() {
        return;
    }
    let mut removed = 0usize;
    for path in &stale {
        if fs::remove_file(path).is_ok() {
            removed += 1;
        }
    }
    if removed > 0 {
        emit_log(app, &format!("已清理 {removed} 个上次中断残留的临时文件"));
    }
}

/// 是否为依赖清单文件（package.json / package-lock.json，含子目录）。
fn is_dep_manifest(rel: &str) -> bool {
    rel == "package.json"
        || rel == "package-lock.json"
        || rel.ends_with("/package.json")
        || rel.ends_with("/package-lock.json")
}

// ---------------------------------------------------------------------------
// 备份 / 回滚（D5）
// ---------------------------------------------------------------------------

/// 生成覆盖计划，并把将被覆盖的现存文件全量备份到 `appData/backups/<timestamp>/`。
fn prepare_plans(
    app: &AppHandle,
    target: &Path,
    files: &[(PathBuf, String)],
    zip_url: &str,
) -> anyhow::Result<(Vec<CopyPlan>, PathBuf)> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("无法确定应用数据目录：{e}"))?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S%.3f").to_string();
    let backup_dir = data_dir.join("backups").join(&stamp);
    fs::create_dir_all(backup_dir.join("files"))
        .map_err(|e| anyhow::anyhow!("创建备份目录失败：{e}"))?;

    let mut plans: Vec<CopyPlan> = Vec::new();
    let mut backed_up: Vec<String> = Vec::new();
    for (src, rel) in files {
        if is_protected(rel) {
            continue;
        }
        let dest = target.join(rel);
        let backup = if dest.is_file() {
            let bp = backup_dir.join("files").join(rel);
            if let Some(parent) = bp.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| anyhow::anyhow!("创建备份子目录失败：{e}"))?;
            }
            fs::copy(&dest, &bp).map_err(|e| anyhow::anyhow!("备份文件失败（{rel}）：{e}"))?;
            backed_up.push(rel.clone());
            Some(bp)
        } else {
            None
        };
        plans.push(CopyPlan { src: src.clone(), rel: rel.clone(), backup });
    }

    let manifest = serde_json::json!({
        "timestamp": chrono::Local::now().to_rfc3339(),
        "zipUrl": zip_url,
        "overwrittenFiles": backed_up,
    });
    fs::write(
        backup_dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap_or_default(),
    )
    .map_err(|e| anyhow::anyhow!("写入备份清单失败：{e}"))?;

    emit_log(
        app,
        &format!(
            "已备份 {} 个将被覆盖的文件到 {}",
            backed_up.len(),
            backup_dir.display()
        ),
    );
    Ok((plans, backup_dir))
}

/// 用备份把已覆盖的文件恢复到更新前状态（新文件则删除）。
fn rollback(app: &AppHandle, target: &Path, done: &[&CopyPlan]) {
    for plan in done.iter().rev() {
        let dest = target.join(&plan.rel);
        match &plan.backup {
            Some(backup) => {
                if let Err(e) = fs::copy(backup, &dest) {
                    emit_log(app, &format!("回滚失败（{}）：{e}", plan.rel));
                }
            }
            None => {
                let _ = fs::remove_file(&dest);
            }
        }
    }
    emit_log(app, "已回滚到更新前状态。");
}

/// 只保留最近一次备份，清理更早的备份目录。
fn cleanup_old_backups(app: &AppHandle, keep: &Path) {
    let Ok(data_dir) = app.path().app_data_dir() else {
        return;
    };
    let root = data_dir.join("backups");
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path != keep && path.is_dir() {
            let _ = fs::remove_dir_all(&path);
        }
    }
    emit_log(app, &format!("已保留最近一次备份：{}", keep.display()));
}

/// 在更新日志里列出「本地存在、远端已移除」的文件（按策略不自动删除）。
fn report_removed_files(app: &AppHandle, target: &Path, files: &[(PathBuf, String)]) {
    let remote: BTreeSet<String> = files
        .iter()
        .map(|(_, rel)| normalize_rel_path(rel))
        .collect();
    let mut local: Vec<(PathBuf, String)> = Vec::new();
    collect_files(target, "", &mut local);
    let mut removed: Vec<String> = local
        .iter()
        .map(|(_, rel)| rel.clone())
        .filter(|rel| !is_protected(rel))
        .filter(|rel| !remote.contains(&normalize_rel_path(rel)))
        .collect();
    removed.sort();
    if removed.is_empty() {
        emit_log(app, "本地文件与远端一致，无残留提示。");
        return;
    }
    emit_log(
        app,
        &format!(
            "注意：以下 {} 个文件在本地存在、远端已移除（按策略不自动删除，请自行确认）：",
            removed.len()
        ),
    );
    for rel in removed.iter().take(20) {
        emit_log(app, &format!("  - {rel}"));
    }
    if removed.len() > 20 {
        emit_log(app, &format!("  ...（其余 {} 个已省略）", removed.len() - 20));
    }
}

// ---------------------------------------------------------------------------
// 检查 / 执行更新
// ---------------------------------------------------------------------------

/// 检查更新的阻塞实现。
fn check_update_blocking(app: &AppHandle) -> anyhow::Result<UpdateInfo> {
    let dir = config::business_dir(app)?;
    // 尚未完成首次初始化时不做版本比对，避免给出「可更新」的错误引导
    if !config::business_ready(&dir) {
        return Ok(UpdateInfo {
            has_update: false,
            local_version: "未初始化".to_string(),
            remote_version: None,
            message: Some("业务代码尚未初始化完成，暂时无法检查更新。".to_string()),
        });
    }
    let local = read_local_version(&dir);
    let url = config::raw_package_json_url();
    emit_log(app, &format!("检查更新：{url}"));
    let body = fetch_text(&url)?;
    let remote = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("version").and_then(|x| x.as_str()).map(|s| s.to_string()))
        .ok_or_else(|| anyhow::anyhow!("远端 package.json 缺少 version 字段"))?;
    let has_update = compare_versions(&remote, &local) == Ordering::Greater;
    Ok(UpdateInfo {
        has_update,
        local_version: local,
        remote_version: Some(remote),
        message: None,
    })
}

/// 执行更新的阻塞实现。
fn perform_update_blocking(app: &AppHandle) -> anyhow::Result<()> {
    let dir = config::ensure_business_dir(app)?;
    if !config::business_ready(&dir) {
        anyhow::bail!("业务代码尚未初始化完成，请先等待初始化或点击「重试」。");
    }
    if !dir.join("package.json").is_file() {
        anyhow::bail!("业务目录无效（缺少 package.json）：{}", dir.display());
    }

    // 0. 清理上次更新被中断（copy → rename 之间被杀）残留的临时文件
    cleanup_stale_temp_files(app, &dir);

    // 1. 下载 zip（NamedTempFile：文件名不可预测，drop 时自动清理）
    let zip_url = config::archive_zip_url();
    emit_log(app, &format!("开始下载更新包：{zip_url}"));
    let tmp_zip = tempfile::Builder::new()
        .prefix("auto-console-update-")
        .suffix(".zip")
        .tempfile()
        .map_err(|e| anyhow::anyhow!("创建临时文件失败：{e}"))?;
    proc_util::download_file(&zip_url, tmp_zip.path(), &|done, total| {
        let pct = if total > 0 { done.saturating_mul(100) / total } else { 0 };
        emit_log(app, &format!("下载进度 {pct}%"));
    })?;
    emit_log(app, "下载完成，正在解压 ...");

    // 2. 解压到临时目录（带路径穿越防护与顶层目录剥离）
    let tmp_dir = tempfile::Builder::new()
        .prefix("auto-console-update-")
        .tempdir()
        .map_err(|e| anyhow::anyhow!("创建临时目录失败：{e}"))?;
    extract_archive(tmp_zip.path(), tmp_dir.path(), &|line| emit_log(app, line))?;

    // 3. 收集待覆盖文件
    let mut files: Vec<(PathBuf, String)> = Vec::new();
    collect_files(tmp_dir.path(), "", &mut files);
    if files.is_empty() {
        anyhow::bail!("更新包内容为空或格式不正确");
    }
    emit_log(
        app,
        &format!(
            "更新包共 {} 个有效文件，开始备份并覆盖（自动跳过受保护路径、node_modules、.git）...",
            files.len()
        ),
    );

    // 4. 备份将被覆盖的现存文件 + 生成覆盖计划
    let (plans, backup_dir) = prepare_plans(app, &dir, &files, &zip_url)?;

    // 5. 覆盖前检测依赖清单是否变化
    let mut deps_changed = false;
    for plan in &plans {
        if is_dep_manifest(&plan.rel) {
            let old = fs::read(dir.join(&plan.rel)).unwrap_or_default();
            let new = fs::read(&plan.src).unwrap_or_default();
            if old != new {
                deps_changed = true;
            }
        }
    }

    // 6. 覆盖到业务目录；任一步失败立即回滚
    let was_running = service::current_status(app).phase == Phase::Running;
    let mut copied = 0usize;
    let mut done: Vec<&CopyPlan> = Vec::new();
    for plan in &plans {
        let dest = dir.join(&plan.rel);
        // 先登记再复制：即使写到一半失败，目标文件也必须进入回滚集合
        done.push(plan);
        // 先写同目录临时文件再 rename 原子替换：中途失败（如磁盘满）不会留下截断的目标文件
        let tmp_dest = sibling_temp_path(&dest);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| anyhow::anyhow!("创建目录失败：{e}"))?;
        }
        let result = fs::copy(&plan.src, &tmp_dest).and_then(|_| fs::rename(&tmp_dest, &dest));
        if let Err(e) = result {
            let _ = fs::remove_file(&tmp_dest);
            emit_log(app, &format!("覆盖文件失败（{}）：{e}，开始回滚 ...", plan.rel));
            rollback(app, &dir, &done);
            anyhow::bail!("覆盖文件失败（{}）：{e}，已回滚到更新前状态。", plan.rel);
        }
        copied += 1;
    }
    emit_log(app, &format!("已覆盖 {copied} 个文件。"));

    // 7. 只保留最近一次备份 + 提示远端已移除的残留文件
    cleanup_old_backups(app, &backup_dir);
    report_removed_files(app, &dir, &files);

    // 8. 依赖清单有变化 → 自动重跑依赖安装（失败给出可重试的明确提示）
    if deps_changed {
        emit_log(app, "检测到依赖清单变化，重新安装依赖（npm run setup）...");
        proc_util::install_dependencies_blocking(app, &dir).map_err(|e| {
            anyhow::anyhow!("文件已更新，但依赖安装失败：{e:#}。请点击「重启服务」重试。")
        })?;
    } else {
        emit_log(app, "依赖清单无变化，跳过依赖安装。");
    }

    // 9. 服务之前在运行 → 重启以应用更新
    if was_running {
        emit_log(app, "重启服务以应用更新 ...");
        bootstrap::restart_service_blocking(app)?;
    }
    emit_log(app, "更新完成。");
    Ok(())
}

/// Tauri 命令：检查更新。
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(move || check_update_blocking(&app))
        .await
        .map_err(|e| format!("内部错误：{e}"))?
        .map_err(|e| format!("{e:#}"))
}

/// Tauri 命令：执行更新。
#[tauri::command]
pub async fn perform_update(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || perform_update_blocking(&app))
        .await
        .map_err(|e| format!("内部错误：{e}"))?
        .map_err(|e| format!("{e:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_compare_basic() {
        assert_eq!(compare_versions("1.2.3", "1.2.2"), Ordering::Greater);
        assert_eq!(compare_versions("1.0.0", "1.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.0", "1.0.1"), Ordering::Less);
        assert_eq!(compare_versions("v2.0.0", "1.9.9"), Ordering::Greater);
    }

    #[test]
    fn protected_paths() {
        assert!(is_protected("shipping-auto/.pw-profile/Cookies"));
        assert!(is_protected(".web-runs/run-1.log"));
        assert!(is_protected("login-auto/shots/a.png"));
        assert!(is_protected("packing-auto/.pw-profile/x"));
        assert!(is_protected(".login-state.json"));
        assert!(is_protected("shipping-auto/node_modules/pw/index.js"));
        assert!(is_protected("node_modules/x/y"));
        assert!(is_protected(".git/config"));
        assert!(!is_protected("web/server.js"));
        assert!(!is_protected("package.json"));
        assert!(!is_protected("shipping-auto/index.js"));
    }

    /// D8 回归：截图实际落在 shipping-auto/shots 与 packing-auto/shots，必须受保护。
    #[test]
    fn protected_paths_cover_task_screenshot_dirs() {
        assert!(is_protected("shipping-auto/shots/2026/01.png"));
        assert!(is_protected("packing-auto/shots/step-1.png"));
        assert!(is_protected("./packing-auto/shots//a.png"));
    }

    // -----------------------------------------------------------------
    // 版本比对边界（回归自 PRD：必须按数值比较，且远端更旧时不得误更新）
    // -----------------------------------------------------------------

    #[test]
    fn version_compare_is_numeric_not_lexicographic() {
        assert_eq!(compare_versions("1.0.10", "1.0.9"), Ordering::Greater);
        assert_eq!(compare_versions("1.0.9", "1.0.10"), Ordering::Less);
        assert_eq!(compare_versions("1.10.0", "1.2.0"), Ordering::Greater);
        assert_eq!(compare_versions("1.2.0", "1.10.0"), Ordering::Less);
        assert_eq!(compare_versions("10.0.0", "9.9.9"), Ordering::Greater);
    }

    #[test]
    fn version_compare_tolerates_prefix_and_padding() {
        assert_eq!(compare_versions("v1.0.0", "1.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("  v1.0.0  ", "1.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.0", "1.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.0.0.0", "1.0.0"), Ordering::Equal);
    }

    /// D12 回归：预发布标签必须按 semver 语义比较（rc < 正式版，alpha < beta）。
    #[test]
    fn version_compare_handles_prerelease_labels() {
        assert_eq!(compare_versions("1.0.0-rc1", "1.0.0"), Ordering::Less);
        assert_eq!(compare_versions("1.0.0", "1.0.0-rc1"), Ordering::Greater);
        assert_eq!(compare_versions("1.0.0-alpha", "1.0.0-beta"), Ordering::Less);
        assert_eq!(compare_versions("1.0.0-beta", "1.0.0-alpha"), Ordering::Greater);
        assert_eq!(compare_versions("1.0.0-rc.1", "1.0.0-rc.2"), Ordering::Less);
        assert_eq!(compare_versions("1.0.0-rc1", "1.0.0-rc1"), Ordering::Equal);
    }

    #[test]
    fn remote_version_older_or_equal_never_triggers_update() {
        // has_update 的判据是 remote > local，这里锁定「不能 Greater」的三种情形
        assert_ne!(compare_versions("1.0.0", "1.0.0"), Ordering::Greater);
        assert_ne!(compare_versions("1.0.0", "1.0.1"), Ordering::Greater);
        assert_ne!(compare_versions("1.9.9", "1.10.0"), Ordering::Greater);
    }

    // -----------------------------------------------------------------
    // 受保护路径过滤边界
    // -----------------------------------------------------------------

    #[test]
    fn protected_prefix_matches_whole_directory_name_only() {
        // 后缀近似的兄弟目录不能被误判为受保护（否则该更新的文件被静默跳过）
        assert!(!is_protected("shipping-auto/.pw-profile-x/Cookies"));
        assert!(!is_protected("packing-auto/.pw-profile.bak/x"));
        assert!(!is_protected("login-auto/shots-archive/a.png"));
        assert!(!is_protected(".web-runs-old/run.log"));
        assert!(!is_protected("shipping-auto/node_modules.md"));
    }

    #[test]
    fn protected_paths_cover_deep_nodes_and_deep_node_modules() {
        assert!(is_protected("shipping-auto/a/b/node_modules/pkg/index.js"));
        assert!(is_protected("shared/.git/HEAD"));
        assert!(is_protected("node_modules/.bin/x"));
        assert!(is_protected("shipping-auto/.pw-profile/Default/Cookies"));
        assert!(is_protected("packing-auto/.pw-profile/Default/Login Data"));
        assert!(is_protected("login-auto/shots/2026/logins.png"));
        assert!(is_protected(".web-runs/task-1/stdout.log"));
    }

    #[test]
    fn protected_paths_normalize_windows_separators_and_dot_prefix() {
        assert!(is_protected(r"shipping-auto\.pw-profile\Cookies"));
        assert!(is_protected(r"shipping-auto\node_modules\pw\index.js"));
        assert!(is_protected("./.web-runs/run.log"));
        assert!(is_protected("./.login-state.json"));
    }

    /// 缺陷用例 1（已修复）：`is_protected` 未做路径归一化时，`//` 与 `/./` 可绕过保护。
    /// 文件系统会把 `shipping-auto//.pw-profile/Cookies` 折叠成真实的
    /// `shipping-auto/.pw-profile/Cookies`，即登录态仍会被覆盖。
    #[test]
    fn protected_path_cannot_be_bypassed_by_double_slash_or_dot_segment() {
        assert!(is_protected("shipping-auto//.pw-profile/Cookies"));
        assert!(is_protected("shipping-auto/./.pw-profile/Cookies"));
        assert!(is_protected(".web-runs//run-1.log"));
        assert!(is_protected("login-auto/./shots/a.png"));
        // 大小写折叠（macOS/Windows 大小写不敏感文件系统）
        assert!(is_protected("SHIPPING-AUTO/.PW-PROFILE/Cookies"));
        assert!(is_protected("Shipping-Auto/Shots/a.png"));
        // `..` 折叠
        assert!(is_protected("shipping-auto/tmp/../.pw-profile/Cookies"));
    }

    #[test]
    fn normalize_rel_path_collapses_redundant_segments() {
        assert_eq!(
            normalize_rel_path("shipping-auto//.pw-profile/Cookies"),
            "shipping-auto/.pw-profile/cookies"
        );
        assert_eq!(normalize_rel_path("./a/./b/"), "a/b");
        assert_eq!(normalize_rel_path(r"a\b\c"), "a/b/c");
        assert_eq!(normalize_rel_path("a/../b"), "b");
        assert_eq!(normalize_rel_path(""), "");
    }

    // -----------------------------------------------------------------
    // zip 条目路径解析（D1 回归门）
    // -----------------------------------------------------------------

    #[test]
    fn resolve_entry_path_rejects_traversal_and_absolute() {
        assert!(resolve_entry_path("repo-main/../escaped-by-dotdot.txt").is_err());
        assert!(resolve_entry_path("../escaped.txt").is_err());
        assert!(resolve_entry_path("repo-main/web/../../escaped.txt").is_err());
        assert!(resolve_entry_path("/etc/passwd").is_err());
        assert!(resolve_entry_path("C:/Windows/System32/x.dll").is_err());
        assert!(resolve_entry_path(r"repo-main\..\escaped.txt").is_err());
    }

    #[test]
    fn resolve_entry_path_normalizes_and_skips_directories() {
        assert_eq!(
            resolve_entry_path("repo-main/web/server.js").unwrap().as_deref(),
            Some("repo-main/web/server.js")
        );
        assert_eq!(
            resolve_entry_path("./repo-main//web/./server.js").unwrap().as_deref(),
            Some("repo-main/web/server.js")
        );
        assert_eq!(
            resolve_entry_path(r"repo-main\web\server.js").unwrap().as_deref(),
            Some("repo-main/web/server.js")
        );
        assert_eq!(resolve_entry_path("repo-main/").unwrap(), None);
        assert_eq!(resolve_entry_path("").unwrap(), None);
        assert_eq!(resolve_entry_path("./").unwrap(), None);
    }

    #[test]
    fn archive_root_detected_and_stripped() {
        let names = vec![
            "repo-main/".to_string(),
            "repo-main/package.json".to_string(),
            "repo-main/web/server.js".to_string(),
        ];
        assert_eq!(detect_archive_root(&names).as_deref(), Some("repo-main"));
        assert_eq!(
            strip_archive_root("repo-main/web/server.js", "repo-main").as_deref(),
            Some("web/server.js")
        );
        assert_eq!(strip_archive_root("repo-main", "repo-main"), None);
    }

    /// D6 回归：无顶层目录的 zip 不能被吃掉首段（否则 web/server.js 会变成 server.js）。
    #[test]
    fn archive_root_not_detected_for_flat_or_business_named_zips() {
        let flat = vec!["package.json".to_string(), "web/server.js".to_string()];
        assert_eq!(detect_archive_root(&flat), None);

        let business_named = vec![
            "web/server.js".to_string(),
            "web/public/app.js".to_string(),
        ];
        assert_eq!(detect_archive_root(&business_named), None);

        let shipping = vec![
            "shipping-auto/index.js".to_string(),
            "shipping-auto/package.json".to_string(),
        ];
        assert_eq!(detect_archive_root(&shipping), None);
    }

    /// K3 回归：根级文件与疑似仓库顶层目录并存 → 判定混合结构（调用方据此拒包）。
    #[test]
    fn mixed_structure_detected_for_root_files_plus_repo_dir() {
        let mixed = vec![
            "package.json".to_string(),
            "repo-main/package.json".to_string(),
            "repo-main/web/server.js".to_string(),
        ];
        assert_eq!(detect_mixed_structure(&mixed).as_deref(), Some("repo-main"));

        // 纯扁平包：没有 `<x>-<y>/` 目录 → 不判混合
        let flat = vec![
            "package.json".to_string(),
            "web/server.js".to_string(),
            "shared/a.js".to_string(),
        ];
        assert_eq!(detect_mixed_structure(&flat), None);

        // 已知业务目录（shipping-auto 含 '-'）不参与判定
        let with_business = vec![
            "package.json".to_string(),
            "shipping-auto/package.json".to_string(),
        ];
        assert_eq!(detect_mixed_structure(&with_business), None);

        // 标准 GitHub archive（全部条目都在统一顶层目录下）不应误判
        let archive = vec![
            "repo-main/package.json".to_string(),
            "repo-main/web/server.js".to_string(),
        ];
        assert_eq!(detect_mixed_structure(&archive), None);
    }

    /// K5 回归（仅 Windows）：NTFS 备用数据流冒号必须被拒绝。
    #[cfg(windows)]
    #[test]
    fn resolve_entry_path_rejects_ntfs_ads_on_windows() {
        assert!(resolve_entry_path("repo-main/web/server.js:hidden").is_err());
        assert!(resolve_entry_path("repo-main/foo.txt::$DATA").is_err());
        assert!(resolve_entry_path("repo-main/sub:2/file.js").is_err());
    }

    /// K5 说明：macOS/Linux 上 `:` 是合法文件名字符，不应被拒。
    #[cfg(not(windows))]
    #[test]
    fn resolve_entry_path_allows_colon_on_unix() {
        assert_eq!(
            resolve_entry_path("repo-main/web/a:b.js").unwrap().as_deref(),
            Some("repo-main/web/a:b.js")
        );
    }

    /// K2 回归：原子替换用的临时文件必须与目标同目录（rename 才能原子完成）。
    #[test]
    fn sibling_temp_path_stays_in_same_directory() {
        let dest = Path::new("/tmp/biz/web/server.js");
        let tmp = sibling_temp_path(dest);
        assert_eq!(tmp.parent(), dest.parent());
        assert!(
            tmp.file_name()
                .map(|n| n.to_string_lossy().contains("autoupdate.tmp"))
                .unwrap_or(false),
            "临时文件名应可识别：{}",
            tmp.display()
        );
    }

    /// K6 回归：残留的 `.<name>.autoupdate.tmp` 不得被当成业务文件收集，
    /// 否则会被误报为「本地存在、远端已移除」；正常文件一个都不能少。
    #[test]
    fn collect_files_skips_stale_autoupdate_temp_files() {
        let sandbox = tempfile::tempdir().expect("创建沙盒");
        let root = sandbox.path();
        fs::create_dir_all(root.join("web")).expect("创建 web");
        fs::create_dir_all(root.join("shipping-auto/node_modules/pkg")).expect("创建 node_modules");
        fs::write(root.join("web/server.js"), "// ok\n").expect("写正常文件");
        fs::write(root.join("package.json"), "{}\n").expect("写 package.json");
        // 中断残留的临时文件（根级 + 子目录各一个）
        fs::write(root.join("web/.server.js.autoupdate.tmp"), "partial").expect("写残留 1");
        fs::write(root.join(".package.json.autoupdate.tmp"), "partial").expect("写残留 2");
        // 受保护目录内的文件一律不收集
        fs::write(root.join("shipping-auto/node_modules/pkg/index.js"), "x").expect("写依赖");

        let mut files: Vec<(PathBuf, String)> = Vec::new();
        collect_files(root, "", &mut files);
        let mut rels: Vec<String> = files.into_iter().map(|(_, rel)| rel).collect();
        rels.sort();
        assert_eq!(
            rels,
            vec!["package.json".to_string(), "web/server.js".to_string()],
            "残留临时文件不得被收集，正常文件不得遗漏"
        );

        // 清理器应能定位到两个残留文件（且不进入 node_modules）
        let mut stale: Vec<PathBuf> = Vec::new();
        collect_stale_temp_files(root, "", &mut stale);
        assert_eq!(stale.len(), 2, "残留临时文件定位不准：{stale:?}");
        for path in &stale {
            assert!(is_stale_temp_name(&path.file_name().unwrap().to_string_lossy()));
        }
    }

    /// D1 回归门（由原 `#[ignore]` 复现用例转正）：
    /// 用真实 zip 走「安全解压路径」，穿越条目必须被 `resolve_entry_path` 拒绝，
    /// 合法条目正常落盘，任何文件都不得写到临时目录之外。
    #[test]
    fn zip_entry_traversal_is_rejected_by_resolve_entry_path() {
        use std::io::Write as _;

        let sandbox = tempfile::tempdir().expect("创建沙盒目录");
        let inner = sandbox.path().join("inner");
        std::fs::create_dir_all(&inner).expect("创建内层目录");

        // 构造一个真实的、含穿越条目的 zip（GitHub archive 顶层目录 + 恶意条目）
        let zip_path = sandbox.path().join("payload.zip");
        {
            let file = std::fs::File::create(&zip_path).expect("创建 zip");
            let mut writer = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();
            for (name, body) in [
                ("repo-main/web/server.js", "// legit\n"),
                ("repo-main/../escaped-by-dotdot.txt", "pwned\n"),
                ("/absolute-escape.txt", "pwned\n"),
            ] {
                writer.start_file(name, opts).expect("写入 zip 条目");
                writer.write_all(body.as_bytes()).expect("写入 zip 内容");
            }
            writer.finish().expect("关闭 zip");
        }

        // ---- 走与 extract_archive 相同的安全解压流程 ----
        let archive_file = std::fs::File::open(&zip_path).expect("打开 zip");
        let mut archive = zip::ZipArchive::new(archive_file).expect("解析 zip");
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).expect("读取条目").name().to_string())
            .collect();
        let root = detect_archive_root(&names);
        assert_eq!(root.as_deref(), Some("repo-main"));

        let mut rejected = 0usize;
        let mut extracted: Vec<String> = Vec::new();
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).expect("读取条目");
            match resolve_entry_path(entry.name()) {
                Ok(Some(rel)) => {
                    let rel = root
                        .as_deref()
                        .and_then(|r| strip_archive_root(&rel, r))
                        .unwrap_or(rel);
                    if is_protected(&rel) {
                        continue;
                    }
                    let dest = inner.join(&rel);
                    assert!(dest.starts_with(&inner), "落盘目标越界：{}", dest.display());
                    if let Some(parent) = dest.parent() {
                        std::fs::create_dir_all(parent).expect("创建父目录");
                    }
                    let mut buf = Vec::new();
                    entry.read_to_end(&mut buf).expect("读取内容");
                    std::fs::write(&dest, &buf).expect("写出文件");
                    extracted.push(rel);
                }
                Ok(None) => {}
                Err(_) => rejected += 1,
            }
        }

        assert_eq!(rejected, 2, "两个非法条目（.. 与绝对路径）必须被拒绝");
        assert_eq!(extracted, vec!["web/server.js".to_string()]);
        assert!(
            !sandbox.path().join("escaped-by-dotdot.txt").exists(),
            "安全缺陷：zip 条目 `repo-main/../escaped-by-dotdot.txt` 被解压到临时目录之外"
        );
        assert!(!sandbox.path().join("absolute-escape.txt").exists(), "绝对路径条目不得落盘");
        assert!(inner.join("web/server.js").is_file(), "合法条目应正常解压");
    }

    // =================================================================
    // QA 第二轮独立复核用例（严过关自写，不复用工程师用例）
    // =================================================================

    /// QA-R2-D1-a：自造真实 zip，覆盖三类恶意条目 + UNC/盘符向量，
    /// 并**复刻 `extract_archive` 的中止语义**（遇 Err 立即中止整包，不再落盘）。
    ///
    /// 关键点：恶意条目排在首位，因此中止后 `extracted` 必须为空——
    /// 若实现退化成「跳过该条继续」，后续合法条目会被写入，断言即失败。
    #[test]
    fn qa_real_zip_traversal_must_abort_whole_package() {
        use std::io::Write as _;

        let sandbox = tempfile::tempdir().expect("创建沙盒");
        let inner = sandbox.path().join("dest");
        std::fs::create_dir_all(&inner).expect("创建目标目录");

        let zip_path = sandbox.path().join("qa-payload.zip");
        {
            let file = std::fs::File::create(&zip_path).expect("创建 zip");
            let mut writer = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();
            for (name, body) in [
                // 1) 多层穿越：repo-main/../../escape.txt
                ("repo-main/../../qa-escape-1.txt", "pwned\n"),
                // 2) Unix 绝对路径
                ("/etc/qa-evil.txt", "pwned\n"),
                // 3) 中段穿越：repo-main/sub/../../../x.txt
                ("repo-main/sub/../../../qa-escape-3.txt", "pwned\n"),
                // 4) Windows 盘符（反斜杠形式）
                (r"C:\Windows\Temp\qa-evil.dll", "pwned\n"),
                // 5) UNC 路径
                (r"\\server\share\qa-evil.txt", "pwned\n"),
                // 6) 合法条目（必须因为前面的条目被中止而不落盘）
                ("repo-main/web/server.js", "// legit\n"),
            ] {
                writer.start_file(name, opts).expect("写入条目");
                writer.write_all(body.as_bytes()).expect("写入内容");
            }
            writer.finish().expect("关闭 zip");
        }

        // ---- 复刻 extract_archive（:344-380）的决策链：Err ⇒ 整包中止 ----
        let file = std::fs::File::open(&zip_path).expect("打开 zip");
        let mut archive = zip::ZipArchive::new(file).expect("解析 zip");
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).expect("读条目").name().to_string())
            .collect();
        let root = detect_archive_root(&names);

        let mut aborted: Option<String> = None;
        let mut extracted: Vec<String> = Vec::new();
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).expect("读条目");
            let entry_name = entry.name().to_string();
            let rel = match resolve_entry_path(&entry_name) {
                Ok(Some(rel)) => rel,
                Ok(None) => continue,
                Err(msg) => {
                    aborted = Some(msg);
                    break; // 等价于 anyhow::bail!：整包中止
                }
            };
            let rel = match &root {
                Some(r) => match strip_archive_root(&rel, r) {
                    Some(inner_rel) => inner_rel,
                    None => continue,
                },
                None => rel,
            };
            if rel.is_empty() || is_protected(&rel) {
                continue;
            }
            let dest = inner.join(&rel);
            assert!(dest.starts_with(&inner), "落盘目标越界：{}", dest.display());
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).expect("创建父目录");
            }
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).expect("读取内容");
            std::fs::write(&dest, &buf).expect("写出");
            extracted.push(rel);
        }

        assert!(aborted.is_some(), "含穿越条目的更新包必须整体中止，实际未被拒绝");
        assert!(
            extracted.is_empty(),
            "中止后不应有任何文件落盘（说明实现可能退化为『跳过该条继续』）：{extracted:?}"
        );
        // 沙盒内外均不得出现逃逸产物
        for escaped in [
            "qa-escape-1.txt",
            "qa-escape-3.txt",
            "qa-evil.txt",
            "qa-evil.dll",
        ] {
            assert!(!sandbox.path().join(escaped).exists(), "出现逃逸文件：{escaped}");
            assert!(!inner.join(escaped).exists(), "目标目录出现逃逸文件：{escaped}");
        }
        assert!(!inner.join("web/server.js").exists(), "中止后合法条目也不应落盘");
        assert!(!std::path::Path::new("/etc/qa-evil.txt").exists(), "绝对路径条目不得写入 /etc");
    }

    /// QA-R2-D1-b：绝对路径 / 盘符 / UNC / 中段穿越必须逐个被拒（含 Ok(None) 只给目录条目）。
    #[test]
    fn qa_resolve_entry_path_rejects_all_escape_vectors() {
        let must_reject = [
            "repo-main/../../qa.txt",
            "repo-main/sub/../../../qa.txt",
            "repo-main/./../../qa.txt",
            "../../../qa.txt",
            "/etc/qa-evil.txt",
            "/tmp/qa-evil",
            r"C:\Windows\qa.dll",
            r"\\server\share\qa.txt",
            "C:/Windows/qa.dll",
            "../",
            "..",
        ];
        for name in must_reject {
            assert!(
                matches!(resolve_entry_path(name), Err(_)),
                "应拒绝但未拒绝：{name:?} → {:?}",
                resolve_entry_path(name)
            );
        }

        // Ok(None) 只能用于目录条目 / 空路径，不能用来「静默吞掉」文件
        for name in ["repo-main/", "repo-main/web/", "", "./", "."] {
            assert_eq!(resolve_entry_path(name), Ok(None), "应判为目录/空条目：{name:?}");
        }
        // 合法文件必须返回 Some
        for name in ["repo-main/web/server.js", "./a//b/./c.txt", r"a\b\c.txt"] {
            assert!(
                matches!(resolve_entry_path(name), Ok(Some(_))),
                "合法条目不应被拒：{name:?}"
            );
        }
    }

    /// QA-R2-D2-a：组合绕过尝试必须判为受保护（分隔符混用 + `..` + 大小写）。
    #[test]
    fn qa_protected_combo_bypass_attempts_are_blocked() {
        let must_protect = [
            "./shipping-auto//sub/../.pw-profile/Cookies",
            "SHIPPING-AUTO/./.PW-PROFILE/cookies",
            r"packing-auto\.pw-profile\x\..\.pw-profile\Login Data",
            "shipping-auto//shots//a.png",
            "./.WEB-RUNS/run.log",
            "login-auto/./shots/2026/a.png",
            // 中段 `..` 回退后仍落在受保护目录内（真实路径为 packing-auto/.pw-profile/x）
            "packing-auto/a/b/../../.pw-profile/x",
            r"SHIPPING-AUTO\SHOTS\x.png",
        ];        for rel in must_protect {
            assert!(is_protected(rel), "受保护路径被绕过：{rel:?} → {:?}", normalize_rel_path(rel));
        }
    }

    /// QA-R2-D2-b：归一化不得过度拦截（这些是普通业务文件，必须允许覆盖）。
    #[test]
    fn qa_protected_does_not_over_block_lookalikes() {
        let must_not_protect = [
            "shipping-auto/.pw-profileX/Cookies",
            "shipping-auto/.pw-profile.bak/x",
            "shipping-auto/shots.md",
            "shipping-auto/shots2/a.png",
            "packing-auto/shots_old/a.png",
            "login-auto/shots-archive/a.png",
            ".web-runs2/run.log",
            ".web-runs.md",
            "shipping-auto/node_modules.md",
            "web/server.js",
            "package.json",
            "shipping-auto/index.js",
            "shared/browser-session.js",
        ];
        for rel in must_not_protect {
            assert!(!is_protected(rel), "误拦截（会静默跳过正常更新文件）：{rel:?}");
        }
    }

    /// QA-R2-D12：semver 引入后的行为复核（build metadata 不参与比较）。
    #[test]
    fn qa_semver_build_metadata_and_edges() {
        // build metadata 按 semver 语义不参与排序
        assert_eq!(compare_versions("1.0.0+build.5", "1.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.0.0+build.5", "1.0.0+build.6"), Ordering::Equal);
        assert_eq!(compare_versions("1.0.0+build", "v1.0.0"), Ordering::Equal);
        // 两段版本自动补零
        assert_eq!(compare_versions("1.0", "1.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.0", "1.0.1"), Ordering::Less);
        // 预发布 < 正式版；数值段按数值比较
        assert_eq!(compare_versions("1.0.0-rc.2", "1.0.0"), Ordering::Less);
        assert_eq!(compare_versions("1.0.0-rc.2", "1.0.0-rc.10"), Ordering::Less);
        // 主版本跨越时预发布仍应更小
        assert_eq!(compare_versions("2.0.0-beta", "1.9.9"), Ordering::Greater);
        // 非法串回退数字比较，不应 panic
        assert_eq!(compare_versions("abc", "abc"), Ordering::Equal);
        assert_eq!(compare_versions("abc", "1.0.0"), Ordering::Less);
    }

    /// QA-R2-K4-a：新增的遍历剪枝 `dir_is_protected` 必须「只剪真正受保护的目录」。
    #[test]
    fn qa_dir_is_protected_prunes_only_protected_dirs() {
        // 必须剪枝（保护目录本身，含无尾斜杠写法）
        for rel in [
            "shipping-auto/.pw-profile",
            "packing-auto/.pw-profile",
            "shipping-auto/shots",
            "packing-auto/shots",
            "login-auto/shots",
            ".web-runs",
            "node_modules",
            "shared/node_modules",
            ".git",
            "shipping-auto/a/b/node_modules",
            "./shipping-auto//.pw-profile",
            r"packing-auto\.pw-profile",
            "SHIPPING-AUTO/SHOTS",
        ] {
            assert!(dir_is_protected(rel), "应剪枝的目录被判为普通目录：{rel:?}");
        }

        // 不得剪枝（否则正常更新文件会被静默跳过）
        for rel in [
            "web",
            "shared",
            "shipping-auto",
            "shots",              // 根级 shots 不在保护清单内
            "shipping-auto/.pw-profileX",
            "packing-auto/shots2",
            "login-auto/shots-archive",
            ".web-runs2",
            "node_modules.md",
            "web/public",
        ] {
            assert!(!dir_is_protected(rel), "普通目录被误剪枝：{rel:?}");
        }
    }

    /// QA-R2-K4-b：剪枝同时必须保证「非保护文件一个都不少」。
    ///
    /// 用真实目录树验证 `collect_files`：受保护目录不递归，普通文件全部收集。
    #[test]
    fn qa_collect_files_prunes_protected_but_keeps_normal_files() {
        let sandbox = tempfile::tempdir().expect("创建沙盒");
        let root = sandbox.path();
        let write = |rel: &str| {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().expect("父目录")).expect("建目录");
            std::fs::write(&p, b"x").expect("写文件");
        };
        for rel in [
            "web/server.js",
            "package.json",
            "shots/root-level.png",              // 根级 shots：必须收集
            "web/public/app.js",
            "packing-auto/index.js",
            "node_modules/some-pkg/index.js",     // 剪枝
            "shared/node_modules/x/y.js",         // 剪枝
            ".git/HEAD",                          // 剪枝
            "shipping-auto/.pw-profile/Cookies",  // 剪枝
            "packing-auto/shots/step.png",        // 剪枝
            "login-auto/shots/login.png",         // 剪枝
            ".web-runs/run.log",                  // 剪枝
            "shipping-auto/.pw-profileX/keep.js", // 不剪（近似名）：必须收集
        ] {
            write(rel);
        }

        let mut files: Vec<(PathBuf, String)> = Vec::new();
        collect_files(root, "", &mut files);
        let mut rels: Vec<String> = files.into_iter().map(|(_, rel)| rel).collect();
        rels.sort();

        let mut expected = vec![
            "package.json",
            "web/server.js",
            "web/public/app.js",
            "shots/root-level.png",
            "packing-auto/index.js",
            "shipping-auto/.pw-profileX/keep.js",
        ]
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
        expected.sort();

        assert_eq!(rels, expected, "剪枝后收集到的文件集合不符合预期");
    }

    /// QA-R2-K3：混合结构包（根级文件 + 疑似仓库顶层目录）必须被 `detect_mixed_structure`
    /// 识别出来 —— 调用方据此 `bail!` 中止，而不是静默把 `repo-main/` 写进业务目录。
    #[test]
    fn qa_mixed_structure_archive_not_stripped_and_flagged() {
        // 混合结构：顶层既有 `repo-main/`（内含 package.json，像仓库根）又有根级 `README.md`
        let mixed = vec![
            "repo-main/package.json".to_string(),
            "repo-main/web/server.js".to_string(),
            "README.md".to_string(),
        ];
        assert_eq!(detect_archive_root(&mixed), None, "混合结构不得判定统一顶层目录");
        assert_eq!(
            detect_mixed_structure(&mixed).as_deref(),
            Some("repo-main"),
            "混合结构必须被识别，调用方据此拒包（否则更新看似成功实则未生效）"
        );

        // 只有 `repo-main/` 没有根级文件 → 正常 GitHub archive，不判混合
        let archive = vec![
            "repo-main/package.json".to_string(),
            "repo-main/web/server.js".to_string(),
        ];
        assert_eq!(detect_mixed_structure(&archive), None, "标准 GitHub archive 不得误判");

        // 普通扁平包：没有 `<x>-<y>/` 目录 → 不判混合（不误杀扁平仓库）
        let flat = vec![
            "package.json".to_string(),
            "web/server.js".to_string(),
            "README.md".to_string(),
        ];
        assert_eq!(detect_mixed_structure(&flat), None, "普通扁平包不应产生混合结构误判");
    }

    /// QA-R2-K7（**行程开关**）：混合结构判据目前偏宽 —— 只要「根级文件 +
    /// 某个含 `-` 的非业务目录里有 package.json」就会判为混合并拒包。
    /// 于是 `scripts-v2/package.json` 这种真实扁平仓库会被误杀（正是工程师当初
    /// 担心的场景）。收紧判据（例如要求候选目录内必须有 `web/server.js`）后，
    /// 本断言应改为 `None`。
    #[test]
    fn qa_mixed_structure_heuristic_currently_flags_scripts_v2() {
        let flat_repo_with_tooling_dir = vec![
            "package.json".to_string(),
            "README.md".to_string(),
            "web/server.js".to_string(),
            "scripts-v2/package.json".to_string(),
        ];
        assert_eq!(
            detect_mixed_structure(&flat_repo_with_tooling_dir).as_deref(),
            Some("scripts-v2"),
            "K7：当前判据会把含 package.json 的 scripts-v2/ 误判为混合结构并拒绝更新"
        );

        // 若该目录内没有仓库标志文件，则不误判（现有保护）
        let no_manifest = vec![
            "package.json".to_string(),
            "README.md".to_string(),
            "scripts-v2/build.sh".to_string(),
        ];
        assert_eq!(detect_mixed_structure(&no_manifest), None, "无标志文件时不得误判");
    }

    #[test]
    fn url_helpers_point_at_fixed_branch() {
        // URL 构造已收敛到 config（零配置常量），这里只锁定「与常量一致」
        assert!(config::raw_package_json_url().ends_with("/main/package.json"));
        assert!(config::archive_zip_url().ends_with("/main.zip"));
    }
}
