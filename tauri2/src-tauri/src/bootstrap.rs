//! 零配置启动流水线：环境检查 → 拉取代码 → 安装依赖 → 启动服务 → 健康检查 → 就绪。
//!
//! 应用启动后由 `setup` 自动在后台线程执行，用户不需要点任何按钮：
//!
//! ```text
//! 1. 检查环境   node >= 18、npm 可用（缺失则暂停，UI 显示「安装 Node.js」，装完自动续跑）
//! 2. 准备代码   无 web/server.js ⇒ 下载 BRANCH 的 archive zip → 解压 → 整体移入 business
//! 3. 安装依赖   business 内执行 npm run setup；node_modules 齐全且清单指纹未变时跳过
//! 4. 启动服务   node web/server.js（cwd=business，PORT=<可用端口>）
//! 5. 健康检查   轮询 /api/state 直到 200（30s 超时）
//! 6. 就绪       「运行中」，展示 http://127.0.0.1:<port>
//! ```
//!
//! 每个阶段都向前端推送 `bootstrap-status` 事件（阶段 + 中文进度说明 + 进度百分比）。
//! 失败时记录**失败阶段**，重试从该阶段继续，而不是从头再来。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::config;
use crate::env_check;
use crate::proc_util;
use crate::service;
use crate::updater;

/// 首次初始化的中转目录名前缀（位于应用数据目录下，成功或重试时都会被清理）。
const STAGING_DIR_NAME: &str = ".bootstrap-staging";
/// 依赖清单指纹的落盘文件名（位于应用数据目录下）。
const DEPS_STAMP_FILE: &str = "deps-fingerprint.txt";

/// FNV-1a 64 位偏移量（用于依赖清单指纹，跨进程稳定）。
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
/// FNV-1a 64 位质数。
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// 参与依赖指纹的清单文件（相对业务目录），只有它们变化才需要重装依赖。
const DEP_MANIFESTS: &[&str] = &[
    "package.json",
    "package-lock.json",
    "shipping-auto/package.json",
    "shipping-auto/package-lock.json",
    "packing-auto/package.json",
    "packing-auto/package-lock.json",
];

/// 依赖是否齐全的判定目录（两个业务子包的 node_modules 都必须存在）。
const DEP_MODULE_DIRS: &[&str] = &["shipping-auto/node_modules", "packing-auto/node_modules"];

/// 启动流水线阶段（serde camelCase，与前端 `Stage` 字面量一一对应）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    /// 检查 node / npm 是否可用
    #[default]
    CheckingEnv,
    /// 正在安装 Node.js（用户点击「安装 Node.js」后）
    InstallingNode,
    /// 正在拉取业务代码
    FetchingCode,
    /// 正在安装业务依赖
    InstallingDeps,
    /// 正在启动服务
    Starting,
    /// 服务已就绪
    Ready,
    /// 服务已停止
    Stopped,
    /// 某个阶段失败（可重试）
    Error,
}

impl Stage {
    /// 面向用户的中文阶段名（徽章 + 错误提示用）。
    pub fn label(self) -> &'static str {
        match self {
            Stage::CheckingEnv => "检查环境",
            Stage::InstallingNode => "安装 Node.js",
            Stage::FetchingCode => "准备业务代码",
            Stage::InstallingDeps => "安装依赖",
            Stage::Starting => "启动服务",
            Stage::Ready => "运行中",
            Stage::Stopped => "服务已停止",
            Stage::Error => "初始化失败",
        }
    }

    /// 流水线中的下一个阶段；`None` 表示流水线已到终点。
    ///
    /// 注意 [`Stage::InstallingNode`] 不在主链路上——它是用户手动触发的分支，
    /// 装完后流水线从 [`Stage::CheckingEnv`] 重新续跑。
    fn next_step(self) -> Option<Stage> {
        match self {
            Stage::CheckingEnv => Some(Stage::FetchingCode),
            Stage::FetchingCode => Some(Stage::InstallingDeps),
            Stage::InstallingDeps => Some(Stage::Starting),
            _ => None,
        }
    }
}

/// 发给前端的流水线快照（`bootstrap-status` 事件 / `bootstrap_status` 命令）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapSnapshot {
    /// 当前阶段
    pub stage: Stage,
    /// 人类可读的中文进度说明
    pub detail: String,
    /// 阶段内进度百分比（0–100）；`None` 表示不确定进度
    pub progress: Option<u8>,
    /// 服务端口（就绪后有值）
    pub port: Option<u16>,
    /// 失败原因（仅 `stage == error` 时有值）
    pub error: Option<String>,
}

/// 流水线全局状态（Tauri managed state）。
#[derive(Default)]
pub struct BootstrapState {
    pub stage: Mutex<Stage>,
    pub detail: Mutex<String>,
    pub progress: Mutex<Option<u8>>,
    pub port: Mutex<Option<u16>>,
    pub error: Mutex<Option<String>>,
    /// 失败/中断的阶段：重试从这里续跑
    pub failed_stage: Mutex<Option<Stage>>,
    /// 流水线是否正在执行（防止并发重跑）
    pub running: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

// ---------------------------------------------------------------------------
// 状态推送
// ---------------------------------------------------------------------------

/// 读取当前快照。
pub fn snapshot(app: &AppHandle) -> BootstrapSnapshot {
    let state = app.state::<BootstrapState>();
    let stage = *lock(&state.stage);
    let detail = lock(&state.detail).clone();
    let progress = *lock(&state.progress);
    let port = *lock(&state.port);
    let error = lock(&state.error).clone();
    BootstrapSnapshot { stage, detail, progress, port, error }
}

/// 读取记录的「失败/中断阶段」：重试时从这里续跑。
fn recorded_stage(app: &AppHandle) -> Option<Stage> {
    let state = app.state::<BootstrapState>();
    let stage = *lock(&state.failed_stage);
    stage
}

/// 把记录的阶段映射为可续跑的起点（未知时从检查环境开始）。
fn resume_from(app: &AppHandle) -> Stage {
    match recorded_stage(app) {
        Some(Stage::FetchingCode) => Stage::FetchingCode,
        Some(Stage::InstallingDeps) => Stage::InstallingDeps,
        Some(Stage::Starting) => Stage::Starting,
        _ => Stage::CheckingEnv,
    }
}

/// 广播 `bootstrap-status` 事件。
fn broadcast(app: &AppHandle) {
    let _ = app.emit("bootstrap-status", snapshot(app));
}

/// 写一行流水线日志：进环形缓冲 + 磁盘日志 + `bootstrap-log` 事件。
fn log(app: &AppHandle, line: &str) {
    service::append_log_line(app, &format!("[init] {line}"));
    let _ = app.emit("bootstrap-log", line.to_string());
}

/// 进入某个阶段（清空上一次的错误）。
pub fn set_stage(app: &AppHandle, stage: Stage, detail: impl Into<String>, progress: Option<u8>) {
    let state = app.state::<BootstrapState>();
    *lock(&state.stage) = stage;
    *lock(&state.detail) = detail.into();
    *lock(&state.progress) = progress;
    *lock(&state.error) = None;
    broadcast(app);
}

/// 标记失败：阶段置为 [`Stage::Error`]，并记录可重试的失败阶段。
pub fn report_error(app: &AppHandle, stage: Stage, message: &str) {
    let state = app.state::<BootstrapState>();
    *lock(&state.stage) = Stage::Error;
    *lock(&state.detail) = format!("{}失败：{message}", stage.label());
    *lock(&state.progress) = None;
    *lock(&state.port) = None;
    *lock(&state.error) = Some(message.to_string());
    *lock(&state.failed_stage) = Some(stage);
    broadcast(app);
    log(app, &format!("{}失败：{message}", stage.label()));
}

/// 服务就绪：阶段置为 [`Stage::Ready`] 并记录端口。
fn mark_ready(app: &AppHandle, port: u16) {
    let state = app.state::<BootstrapState>();
    *lock(&state.stage) = Stage::Ready;
    *lock(&state.detail) = format!("服务已就绪：http://127.0.0.1:{port}");
    *lock(&state.progress) = Some(100);
    *lock(&state.port) = Some(port);
    *lock(&state.error) = None;
    *lock(&state.failed_stage) = None;
    broadcast(app);
}

/// 应用启动时的初始化：建目录 + 推送初始阶段。
pub fn init(app: &AppHandle) {
    match config::ensure_business_dir(app) {
        Ok(dir) => log(app, &format!("业务目录：{}", dir.display())),
        Err(e) => log(app, &format!("创建业务目录失败：{e:#}")),
    }
    set_stage(app, Stage::CheckingEnv, "正在准备启动…", None);
}

/// 服务进程状态变化时同步流水线阶段（由 [`crate::service::set_phase`] 调用）。
///
/// - 意外退出（`Crashed`）→ 错误阶段，可「重试」从启动服务继续；
/// - 正常退出（`Stopped`）→ 已停止阶段。
///
/// `Starting` / `Running` 由流水线自己维护，这里忽略（避免与就绪状态打架）。
pub fn on_service_phase(app: &AppHandle, phase: service::Phase, detail: Option<String>) {
    let state = app.state::<BootstrapState>();
    match phase {
        service::Phase::Crashed => {
            let message = detail.unwrap_or_else(|| "服务意外退出。".to_string());
            *lock(&state.stage) = Stage::Error;
            *lock(&state.detail) = message.clone();
            *lock(&state.progress) = None;
            *lock(&state.port) = None;
            *lock(&state.error) = Some(message);
            *lock(&state.failed_stage) = Some(Stage::Starting);
            broadcast(app);
        }
        service::Phase::Stopped => {
            *lock(&state.stage) = Stage::Stopped;
            *lock(&state.detail) = detail.unwrap_or_else(|| "服务已停止。".to_string());
            *lock(&state.progress) = None;
            *lock(&state.port) = None;
            broadcast(app);
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// 流水线执行
// ---------------------------------------------------------------------------

/// 从 `start` 阶段开始执行流水线（阻塞，必须在后台线程 / spawn_blocking 中调用）。
pub fn run_pipeline_blocking(app: &AppHandle, start: Stage) -> anyhow::Result<()> {
    let state = app.state::<BootstrapState>();
    if state.running.swap(true, Ordering::SeqCst) {
        log(app, "初始化流程已在执行中，忽略本次请求。");
        return Ok(());
    }
    log(app, &format!("开始初始化流程（从「{}」阶段）...", start.label()));
    let result = run_steps(app, start);
    state.running.store(false, Ordering::SeqCst);
    match &result {
        Ok(()) => log(app, "初始化流程结束。"),
        Err(e) => log(app, &format!("初始化流程中断：{e:#}")),
    }
    result
}

/// 依次执行各阶段；任一阶段失败即记录失败原因并结束。
fn run_steps(app: &AppHandle, start: Stage) -> anyhow::Result<()> {
    let state = app.state::<BootstrapState>();
    let mut stage = start;
    loop {
        // 记录「正在执行的阶段」：失败后「重试」从这里续跑，而不是从头开始
        *lock(&state.failed_stage) = Some(stage);
        let outcome = match stage {
            Stage::CheckingEnv => step_check_env(app),
            Stage::FetchingCode => step_fetch_code(app),
            Stage::InstallingDeps => step_install_deps(app),
            Stage::Starting => step_start_service(app),
            // 已就绪 / 已停止：无需再跑
            _ => Ok(()),
        };
        if let Err(e) = outcome {
            report_error(app, stage, &format!("{e:#}"));
            return Err(e);
        }
        match stage.next_step() {
            Some(next) => stage = next,
            None => return Ok(()),
        }
    }
}

/// 阶段一：检查 node / npm。
fn step_check_env(app: &AppHandle) -> anyhow::Result<()> {
    set_stage(app, Stage::CheckingEnv, "正在检查运行环境（Node.js / npm）…", None);
    let statuses = env_check::check_environment_blocking();
    for status in &statuses {
        let text = status
            .detail
            .clone()
            .or_else(|| status.version.clone())
            .unwrap_or_else(|| "可用".to_string());
        log(app, &format!("{}：{text}", status.name));
    }
    if let Some(bad) = statuses.iter().find(|s| !s.ok) {
        let reason = bad
            .detail
            .clone()
            .unwrap_or_else(|| format!("{} 不可用", bad.name));
        anyhow::bail!("运行环境未就绪：{reason}。请点击「安装 Node.js」，装好后会自动继续。");
    }
    log(app, "运行环境检查通过。");
    Ok(())
}

/// 阶段二：确保业务代码就位（仅当缺少入口文件时才下载）。
fn step_fetch_code(app: &AppHandle) -> anyhow::Result<()> {
    let dir = config::ensure_business_dir(app)?;
    if config::business_ready(&dir) {
        log(app, "已存在业务代码，跳过下载。");
        set_stage(app, Stage::FetchingCode, "已检测到本地业务代码，跳过下载。", Some(100));
        return Ok(());
    }
    set_stage(app, Stage::FetchingCode, "正在准备业务代码…", Some(0));
    fetch_code_blocking(app, &dir)
}

/// 生成唯一的中转目录路径。
///
/// 用「前缀 + 时间戳 + pid」而不是固定名字：即使上次残留的中转目录删不掉
/// （某些受限环境会返回 EPERM），本次也不会被旧内容污染。
fn new_staging_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(format!(
        "{STAGING_DIR_NAME}-{}-{}",
        chrono::Local::now().format("%Y%m%d-%H%M%S%.3f"),
        std::process::id()
    ))
}

/// 列出上次初始化残留的中转目录（只认目录，不碰同名文件）。
fn stale_staging_dirs(data_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(data_dir) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(STAGING_DIR_NAME)
        })
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();
    dirs
}

/// 首次初始化：下载 archive zip → 解压到中转目录 → 校验 → 整体移入业务目录。
///
/// 解压必须落在中转目录：半成品一旦落进业务目录，下次启动会被误判为「已有代码」
/// 而跳过初始化，用户会看到永远起不来的服务。
pub fn fetch_code_blocking(app: &AppHandle, dir: &Path) -> anyhow::Result<()> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("无法确定应用数据目录：{e}"))?;
    // 上一次失败可能留下中转目录：尽力清理，清不掉也不影响本次（本次用全新目录）
    for stale in stale_staging_dirs(&data_dir) {
        match fs::remove_dir_all(&stale) {
            Ok(()) => log(app, &format!("已清理上次残留的中转目录：{}", stale.display())),
            Err(e) => log(
                app,
                &format!("清理残留中转目录失败（不影响本次初始化）：{}：{e}", stale.display()),
            ),
        }
    }
    let staging = new_staging_dir(&data_dir);
    fs::create_dir_all(&staging)
        .map_err(|e| anyhow::anyhow!("创建中转目录失败（{}）：{e}", staging.display()))?;

    let url = config::archive_zip_url();
    log(app, &format!("下载业务代码：{url}"));
    let zip_file = tempfile::Builder::new()
        .prefix("auto-console-bootstrap-")
        .suffix(".zip")
        .tempfile()
        .map_err(|e| anyhow::anyhow!("创建临时文件失败：{e}"))?;

    // 下载（带字节进度）
    let last_logged = std::cell::Cell::new(u8::MAX);
    proc_util::download_file(&url, zip_file.path(), &|done, total| {
        let pct = if total > 0 {
            ((done.saturating_mul(100)) / total).min(100) as u8
        } else {
            0
        };
        set_stage(
            app,
            Stage::FetchingCode,
            format!(
                "正在下载业务代码（{} / {}）",
                config::format_size(done),
                config::format_size(total)
            ),
            Some(pct / 2), // 下载占整体进度的前半程
        );
        if pct % 25 == 0 && last_logged.get() != pct {
            last_logged.set(pct);
            log(app, &format!("下载进度 {pct}%"));
        }
    })?;
    log(app, "下载完成。");

    // 解压（复用更新模块的安全解压：路径穿越防护 + 顶层目录剥离）
    set_stage(app, Stage::FetchingCode, "正在解压业务代码…", Some(50));
    updater::extract_archive(zip_file.path(), &staging, &|line| log(app, line))?;

    // 校验：解压结果必须含入口文件，否则视为失败包，绝不落进业务目录
    if !config::business_ready(&staging) {
        anyhow::bail!(
            "下载的业务代码不完整（未找到 {}），已中止初始化，请重试。",
            config::ENTRY_FILE
        );
    }

    // 整体移入业务目录
    set_stage(app, Stage::FetchingCode, "正在安装业务代码…", Some(90));
    move_children(&staging, dir)?;
    if let Err(e) = fs::remove_dir_all(&staging) {
        log(app, &format!("清理中转目录失败（不影响启动）：{e}"));
    }
    // 兜底校验：入口文件必须已经落到业务目录（move_children 把 web/ 放在最后移动，
    // 因此中途失败时业务目录不会含入口文件，下次启动会重新下载而不是把半成品当完整代码）
    if !config::business_ready(dir) {
        anyhow::bail!(
            "业务代码安装不完整（未找到 {}），请点击「重试」重新下载。",
            config::ENTRY_FILE
        );
    }
    log(app, &format!("业务代码已就位：{}", dir.display()));
    set_stage(app, Stage::FetchingCode, "业务代码已就位。", Some(100));
    Ok(())
}

/// 阶段三：安装业务依赖（`npm run setup`），清单未变且依赖齐全时跳过。
fn step_install_deps(app: &AppHandle) -> anyhow::Result<()> {
    let dir = config::ensure_business_dir(app)?;
    let fingerprint = deps_fingerprint(&dir);
    let stamp_path = deps_stamp_path(app);
    let saved = fs::read_to_string(&stamp_path)
        .ok()
        .map(|t| t.trim().to_string());
    if deps_present(&dir) && saved.as_deref() == Some(fingerprint.as_str()) {
        log(app, "依赖清单未变化且 node_modules 齐全，跳过依赖安装。");
        set_stage(app, Stage::InstallingDeps, "依赖已就绪，跳过安装。", Some(100));
        return Ok(());
    }
    set_stage(app, Stage::InstallingDeps, "正在安装业务依赖（npm run setup）…", None);
    proc_util::install_dependencies_blocking(app, &dir)?;
    if let Err(e) = fs::write(&stamp_path, fingerprint.as_bytes()) {
        // 指纹写不进去只影响下次是否跳过，不影响本次初始化结果
        log(app, &format!("依赖指纹写入失败（不影响启动）：{e}"));
    }
    log(app, "业务依赖安装完成。");
    set_stage(app, Stage::InstallingDeps, "业务依赖安装完成。", Some(100));
    Ok(())
}

/// 阶段四：启动服务并等待健康检查通过。
fn step_start_service(app: &AppHandle) -> anyhow::Result<()> {
    set_stage(app, Stage::Starting, "正在启动本地服务并等待健康检查…", None);
    // 上一次失败可能残留进程（例如健康检查超时但进程还活着），先清掉避免双开。
    // 服务正在正常运行时不要动它——start 会直接复用。
    if service::current_status(app).phase != service::Phase::Running {
        let _ = service::stop_service_blocking(app);
    }
    let snap = service::start_service_blocking(app)?;
    let port = snap
        .port
        .ok_or_else(|| anyhow::anyhow!("服务已启动但未上报监听端口"))?;
    mark_ready(app, port);
    log(app, &format!("服务已就绪：http://127.0.0.1:{port}"));
    Ok(())
}

/// 重启服务（供 UI 的「重启服务」按钮与在线更新后应用更新使用）。
pub fn restart_service_blocking(app: &AppHandle) -> anyhow::Result<()> {
    set_stage(app, Stage::Starting, "正在重启本地服务…", None);
    // 未运行时停止会正常返回，不视为错误
    let _ = service::stop_service_blocking(app);
    step_start_service(app).map_err(|e| {
        let message = format!("{e:#}");
        report_error(app, Stage::Starting, &message);
        e
    })
}

/// 后台续跑流水线（「安装 Node.js」成功后调用，实现「装完自动续跑」）。
pub fn resume_pipeline_async(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        // 卡在环境检查/安装 Node 时续跑必须从「检查环境」开始（刚装完要重新验证）
        let start = resume_from(&handle);
        if let Err(e) = run_pipeline_blocking(&handle, start) {
            eprintln!("续跑初始化流程失败：{e:#}");
        }
    });
}

// ---------------------------------------------------------------------------
// 文件工具（纯函数，可直接单测）
// ---------------------------------------------------------------------------

/// 依赖指纹落盘路径。
fn deps_stamp_path(app: &AppHandle) -> std::path::PathBuf {
    match app.path().app_data_dir() {
        Ok(dir) => dir.join(DEPS_STAMP_FILE),
        Err(_) => std::env::temp_dir().join(DEPS_STAMP_FILE),
    }
}

/// 两个业务子包的 node_modules 是否都在。
pub fn deps_present(dir: &Path) -> bool {
    DEP_MODULE_DIRS.iter().all(|rel| dir.join(rel).is_dir())
}

/// 计算依赖清单指纹：清单内容变化 ⇒ 需要重装依赖。
///
/// 用 FNV-1a（不用 `DefaultHasher`，其算法未承诺跨版本稳定），缺失的清单以
/// `<missing:rel>` 参与计算，保证「文件被删」也能改变指纹。
pub fn deps_fingerprint(dir: &Path) -> String {
    let mut hash = FNV_OFFSET;
    for rel in DEP_MANIFESTS {
        hash_bytes(&mut hash, rel.as_bytes());
        match fs::read(dir.join(rel)) {
            Ok(bytes) => hash_bytes(&mut hash, &bytes),
            Err(_) => hash_bytes(&mut hash, format!("<missing:{rel}>").as_bytes()),
        }
    }
    format!("{hash:016x}")
}

fn hash_bytes(state: &mut u64, bytes: &[u8]) {
    for byte in bytes {
        *state ^= u64::from(*byte);
        *state = state.wrapping_mul(FNV_PRIME);
    }
}

/// 入口文件所在的顶层目录名（`web/server.js` → `web`）。
///
/// 该目录必须**最后**移动，保证中途失败时业务目录不含入口文件（见 [`move_children`]）。
fn marker_root() -> &'static str {
    config::ENTRY_FILE.split('/').next().unwrap_or_default()
}

/// 把 `from` 目录下的所有子项移入 `to`（目标同名项先删除）。
///
/// 同一文件系统内走 `rename`（原子、瞬时）；跨卷时退化为「递归复制 + 删除」。
///
/// **顺序保证**：入口文件所在的顶层目录（`web/`）最后移动。这样即使中途失败，
/// 业务目录也不会出现「有 web/server.js 但其它目录缺失」的半成品 —— 否则下次启动
/// 会被 [`config::business_ready`] 误判为已有完整代码而跳过下载。
fn move_children(from: &Path, to: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(to).map_err(|e| anyhow::anyhow!("创建目标目录失败：{e}"))?;
    let marker = marker_root();
    let mut entries: Vec<fs::DirEntry> = fs::read_dir(from)
        .map_err(|e| anyhow::anyhow!("读取中转目录失败：{e}"))?
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|e| anyhow::anyhow!("读取中转目录项失败：{e}"))?;
    entries.sort_by_key(|entry| entry.file_name() == std::ffi::OsStr::new(marker));
    for entry in entries {
        let name = entry.file_name();
        let src = entry.path();
        let dest = to.join(&name);
        if dest.is_dir() {
            fs::remove_dir_all(&dest)
                .map_err(|e| anyhow::anyhow!("清理旧目录失败（{}）：{e}", dest.display()))?;
        } else if dest.exists() {
            fs::remove_file(&dest)
                .map_err(|e| anyhow::anyhow!("清理旧文件失败（{}）：{e}", dest.display()))?;
        }
        if fs::rename(&src, &dest).is_err() {
            copy_path(&src, &dest)?;
            let _ = if src.is_dir() {
                fs::remove_dir_all(&src)
            } else {
                fs::remove_file(&src)
            };
        }
    }
    Ok(())
}

/// 递归复制（文件或目录）。
fn copy_path(src: &Path, dest: &Path) -> anyhow::Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dest)
            .map_err(|e| anyhow::anyhow!("创建目录失败（{}）：{e}", dest.display()))?;
        let entries = fs::read_dir(src)
            .map_err(|e| anyhow::anyhow!("读取目录失败（{}）：{e}", src.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| anyhow::anyhow!("读取目录项失败：{e}"))?;
            copy_path(&entry.path(), &dest.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(src, dest)
            .map(|_| ())
            .map_err(|e| anyhow::anyhow!("复制文件失败（{}）：{e}", src.display()))
    }
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

/// Tauri 命令：读取当前流水线快照（前端挂载时同步用，避免错过早期事件）。
#[tauri::command]
pub fn bootstrap_status(app: AppHandle) -> BootstrapSnapshot {
    snapshot(&app)
}

/// Tauri 命令：从失败阶段继续初始化（失败时的「重试」按钮）。
#[tauri::command]
pub async fn retry_pipeline(app: AppHandle) -> Result<BootstrapSnapshot, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let start = resume_from(&handle);
        log(&handle, &format!("重试：从「{}」阶段继续 ...", start.label()));
        run_pipeline_blocking(&handle, start)?;
        Ok(snapshot(&handle))
    })
    .await
    .map_err(|e| format!("内部错误：{e}"))?
    .map_err(|e: anyhow::Error| format!("{e:#}"))
}

/// Tauri 命令：重启业务服务。
#[tauri::command]
pub async fn restart_service(app: AppHandle) -> Result<BootstrapSnapshot, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        restart_service_blocking(&handle)?;
        Ok(snapshot(&handle))
    })
    .await
    .map_err(|e| format!("内部错误：{e}"))?
    .map_err(|e: anyhow::Error| format!("{e:#}"))
}

/// Tauri 命令：在系统文件管理器中打开业务目录（排查用）。
#[tauri::command]
pub fn open_business_dir(app: AppHandle) -> Result<(), String> {
    let dir = config::ensure_business_dir(&app).map_err(|e| format!("{e:#}"))?;
    tauri_plugin_opener::open_path(dir, None::<&str>)
        .map_err(|e| format!("打开业务目录失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 前端 `Stage` 字面量与 Rust 序列化必须一一对应。
    #[test]
    fn stage_serializes_to_frontend_literal_names() {
        let cases = [
            (Stage::CheckingEnv, "checkingEnv"),
            (Stage::InstallingNode, "installingNode"),
            (Stage::FetchingCode, "fetchingCode"),
            (Stage::InstallingDeps, "installingDeps"),
            (Stage::Starting, "starting"),
            (Stage::Ready, "ready"),
            (Stage::Stopped, "stopped"),
            (Stage::Error, "error"),
        ];
        for (stage, expected) in cases {
            let json = serde_json::to_string(&stage).expect("序列化 Stage");
            assert_eq!(json, format!("\"{expected}\""));
        }
    }

    /// 主链路的阶段推进顺序固定：检查环境 → 拉代码 → 装依赖 → 启动服务 → 结束。
    #[test]
    fn stage_next_step_walks_the_pipeline() {
        assert_eq!(Stage::CheckingEnv.next_step(), Some(Stage::FetchingCode));
        assert_eq!(Stage::FetchingCode.next_step(), Some(Stage::InstallingDeps));
        assert_eq!(Stage::InstallingDeps.next_step(), Some(Stage::Starting));
        assert_eq!(Stage::Starting.next_step(), None);
        // 不在主链路上的阶段不得推进
        assert_eq!(Stage::InstallingNode.next_step(), None);
        assert_eq!(Stage::Ready.next_step(), None);
        assert_eq!(Stage::Error.next_step(), None);
    }

    #[test]
    fn stage_labels_are_not_empty() {
        for stage in [
            Stage::CheckingEnv,
            Stage::InstallingNode,
            Stage::FetchingCode,
            Stage::InstallingDeps,
            Stage::Starting,
            Stage::Ready,
            Stage::Stopped,
            Stage::Error,
        ] {
            assert!(!stage.label().is_empty(), "阶段 {stage:?} 缺少中文说明");
        }
    }

    /// 快照字段名必须与前端 `BootstrapSnapshot` 一致（camelCase）。
    #[test]
    fn bootstrap_snapshot_matches_frontend_contract() {
        let snap = BootstrapSnapshot {
            stage: Stage::Ready,
            detail: "服务已就绪".into(),
            progress: Some(100),
            port: Some(3000),
            error: None,
        };
        let value: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&snap).expect("序列化快照"))
                .expect("解析快照");
        assert_eq!(value["stage"], "ready");
        assert_eq!(value["detail"], "服务已就绪");
        assert_eq!(value["progress"], 100);
        assert_eq!(value["port"], 3000);
        assert!(value["error"].is_null(), "error 为 None 时应序列化为 null");
    }

    /// 首次初始化：清单内容变化必须改变指纹（否则依赖永远不会重装）。
    #[test]
    fn deps_fingerprint_detects_manifest_changes() {
        let sandbox = tempfile::tempdir().expect("创建沙盒");
        let dir = sandbox.path();
        std::fs::write(dir.join("package.json"), r#"{"name":"a","version":"1.0.0"}"#)
            .expect("写 package.json");
        let before = deps_fingerprint(dir);
        assert_eq!(deps_fingerprint(dir), before, "内容不变时指纹必须稳定");

        std::fs::create_dir_all(dir.join("shipping-auto")).expect("创建 shipping-auto");
        std::fs::write(
            dir.join("shipping-auto/package.json"),
            r#"{"name":"shipping","dependencies":{"playwright":"1.0.0"}}"#,
        )
        .expect("写子包 package.json");
        let after = deps_fingerprint(dir);
        assert_ne!(after, before, "子包清单变化必须改变指纹");

        std::fs::write(
            dir.join("shipping-auto/package.json"),
            r#"{"name":"shipping","dependencies":{"playwright":"2.0.0"}}"#,
        )
        .expect("改子包 package.json");
        assert_ne!(deps_fingerprint(dir), after, "依赖版本变化必须改变指纹");
    }

    /// 清单缺失也要参与指纹计算（文件被删时不能沿用旧指纹而跳过安装）。
    #[test]
    fn deps_fingerprint_handles_missing_manifests() {
        let sandbox = tempfile::tempdir().expect("创建沙盒");
        let dir = sandbox.path();
        let empty = deps_fingerprint(dir);
        assert_eq!(deps_fingerprint(dir), empty, "空目录指纹必须稳定");

        std::fs::write(dir.join("package-lock.json"), "{}").expect("写 lock");
        assert_ne!(deps_fingerprint(dir), empty, "新增清单必须改变指纹");

        std::fs::remove_file(dir.join("package-lock.json")).expect("删 lock");
        assert_eq!(deps_fingerprint(dir), empty, "删掉清单必须回到空目录指纹");
    }

    /// 依赖齐全判定：两个子包的 node_modules 缺一不可。
    #[test]
    fn deps_present_requires_both_node_modules() {
        let sandbox = tempfile::tempdir().expect("创建沙盒");
        let dir = sandbox.path();
        assert!(!deps_present(dir), "全空时不得判定依赖齐全");

        std::fs::create_dir_all(dir.join("shipping-auto/node_modules")).expect("建 node_modules");
        assert!(!deps_present(dir), "只有一个子包时不得判定齐全");

        std::fs::create_dir_all(dir.join("packing-auto/node_modules")).expect("建 node_modules");
        assert!(deps_present(dir), "两个子包 node_modules 都在时应判定齐全");
    }

    /// 首次初始化落盘：中转目录内容必须整体移入业务目录。
    #[test]
    fn move_children_installs_code_into_business_dir() {
        let sandbox = tempfile::tempdir().expect("创建沙盒");
        let staging = sandbox.path().join("staging");
        let business = sandbox.path().join("business");
        std::fs::create_dir_all(staging.join("web")).expect("建 web");
        std::fs::write(staging.join("web/server.js"), "// server\n").expect("写入口");
        std::fs::write(staging.join("package.json"), "{}\n").expect("写清单");

        move_children(&staging, &business).expect("移入业务目录");

        assert!(business.join("web/server.js").is_file(), "入口文件必须落在业务目录");
        assert!(business.join("package.json").is_file(), "清单必须落在业务目录");
        assert!(config::business_ready(&business), "移动后必须判定为就绪");
        let leftovers: Vec<_> = std::fs::read_dir(&staging)
            .expect("读中转目录")
            .flatten()
            .collect();
        assert!(leftovers.is_empty(), "中转目录必须被清空：{leftovers:?}");
    }

    /// 入口文件所在的顶层目录必须是最后移动的那一个（决定「半成品」判定是否安全）。
    #[test]
    fn marker_root_is_entry_file_top_dir() {
        assert_eq!(marker_root(), "web");
        assert!(
            config::ENTRY_FILE.starts_with(&format!("{}/", marker_root())),
            "marker_root 必须取自 ENTRY_FILE：{}",
            config::ENTRY_FILE
        );
        // 排序键：marker 目录排最后，其余目录在前
        let mut names = vec!["package.json", "web", "shipping-auto", "shared"];
        names.sort_by_key(|name| *name == marker_root());
        assert_eq!(names.last(), Some(&"web"), "web/ 必须排在最后：{names:?}");
    }

    /// 残留中转目录的清理目标：只认 `stale_staging_dirs` 返回的目录，
    /// 且每次初始化都用全新目录名（旧目录删不掉也不会污染本次）。
    #[test]
    fn stale_staging_dirs_only_matches_leftover_dirs() {
        let sandbox = tempfile::tempdir().expect("创建沙盒");
        let data_dir = sandbox.path();
        std::fs::create_dir_all(data_dir.join(format!("{STAGING_DIR_NAME}-20260101-000000.000-1")))
            .expect("建残留目录 1");
        std::fs::create_dir_all(data_dir.join(format!("{STAGING_DIR_NAME}-20260102-000000.000-2")))
            .expect("建残留目录 2");
        std::fs::write(data_dir.join(STAGING_DIR_NAME), b"not a dir").expect("写同名文件");
        std::fs::create_dir_all(data_dir.join("business")).expect("建业务目录");

        let stale = stale_staging_dirs(data_dir);
        assert_eq!(stale.len(), 2, "应只识别残留的中转目录：{stale:?}");
        for path in &stale {
            assert!(
                path.file_name()
                    .map(|n| n.to_string_lossy().starts_with(STAGING_DIR_NAME))
                    .unwrap_or(false),
                "误识别：{}",
                path.display()
            );
            assert!(path.is_dir(), "只应返回目录：{}", path.display());
        }
        assert_eq!(
            stale,
            {
                let mut sorted = stale.clone();
                sorted.sort();
                sorted
            },
            "结果必须稳定有序，便于日志阅读"
        );
    }

    /// 中转目录名必须唯一（同一次运行内重复调用也不能相同）。
    #[test]
    fn new_staging_dir_is_unique_and_inside_data_dir() {
        let sandbox = tempfile::tempdir().expect("创建沙盒");
        let data_dir = sandbox.path();
        let first = new_staging_dir(data_dir);
        std::thread::sleep(std::time::Duration::from_millis(2));
        let second = new_staging_dir(data_dir);
        assert_ne!(first, second, "中转目录名必须唯一：{}", first.display());
        assert_eq!(first.parent(), Some(data_dir), "中转目录必须位于应用数据目录下");
        assert!(
            first
                .file_name()
                .map(|n| n.to_string_lossy().starts_with(STAGING_DIR_NAME))
                .unwrap_or(false),
            "中转目录名必须带固定前缀（便于下次清理）：{}",
            first.display()
        );
    }

    /// 重试场景：业务目录里已有上次的半成品，必须被新代码**整体替换**（不合并残留）。
    #[test]
    fn move_children_replaces_stale_targets() {
        let sandbox = tempfile::tempdir().expect("创建沙盒");
        let staging = sandbox.path().join("staging");
        let business = sandbox.path().join("business");
        std::fs::create_dir_all(staging.join("web")).expect("建 staging/web");
        std::fs::write(staging.join("web/server.js"), "// new\n").expect("写新入口");
        std::fs::create_dir_all(business.join("web")).expect("建 business/web");
        std::fs::write(business.join("web/server.js"), "// stale\n").expect("写旧入口");
        std::fs::write(business.join("web/old.js"), "// old\n").expect("写旧文件");

        move_children(&staging, &business).expect("移入业务目录");

        let content =
            std::fs::read_to_string(business.join("web/server.js")).expect("读入口文件");
        assert_eq!(content, "// new\n", "同名文件必须被新内容替换");
        assert!(
            !business.join("web/old.js").exists(),
            "同名顶层目录应被整体替换，避免半成品残留"
        );
    }
}
