//! 业务服务生命周期管理：启动、健康检查、优雅停止、崩溃监控、日志环形缓冲。
//!
//! 服务进程以独立进程组启动（Unix），退出时先对整组 SIGTERM，超时后 SIGKILL，
//! 防止 Playwright 等子进程与端口残留。
//!
//! 端口策略：固定首选 [`config::DEFAULT_PORT`]（3000），被占用时自动向上找空闲端口，
//! 实际端口通过 `PORT` 环境变量传给子进程，界面与「打开浏览器」都用实际端口。

use std::collections::VecDeque;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::config;
use crate::env_check;
use crate::path_env;

/// 日志环形缓冲容量（最近 1000 条）。
pub const LOG_CAPACITY: usize = 1000;
/// 健康检查总超时（毫秒）。
const HEALTH_TIMEOUT_MS: u64 = 30_000;
/// 优雅停止宽限时长（毫秒）。
const GRACEFUL_STOP_MS: u64 = 5_000;

/// 服务状态机（进程视角，不含初始化流水线的阶段）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    #[default]
    Idle,
    Starting,
    Running,
    Stopped,
    Crashed,
    Error,
}

/// 发给前端的快照（service-status 事件 / 命令返回值）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusSnapshot {
    pub phase: Phase,
    pub port: Option<u16>,
    pub detail: Option<String>,
}

/// 服务错误（thiserror 定义，中文对外信息）。
#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error("从端口 {0} 起没有可用端口，请释放一个端口后点击「重试」。")]
    PortExhausted(u16),
    #[error("服务未在 {0} 秒内就绪，请查看日志排查。")]
    HealthTimeout(u64),
    #[error("服务进程在就绪前退出（退出码：{0}）。")]
    ExitedEarly(String),
    #[error("无法停止服务进程，请手动检查。")]
    StopFailed,
}

/// 退出清理的幂等守卫。
///
/// 正常关窗（`RunEvent::Exit`）与信号退出（SIGTERM / SIGINT / SIGHUP）两条路径
/// 都可能调用 [`shutdown_on_exit`]，用一次性认领保证清理只真正执行一次：
/// 第二次调用直接返回，不重复等待、不报错。
#[derive(Debug, Default)]
pub struct ShutdownGuard {
    claimed: AtomicBool,
}

impl ShutdownGuard {
    /// 认领这次清理：第一次返回 `true`（由本次调用执行清理），之后永远返回 `false`。
    pub fn claim(&self) -> bool {
        !self.claimed.swap(true, Ordering::SeqCst)
    }
}

/// 全局服务状态（Tauri managed state）。
#[derive(Default)]
pub struct ServiceState {
    pub phase: Mutex<Phase>,
    pub pid: AtomicU32,
    /// 进程「代号」：每次 spawn 自增。旧进程的退出监控线程发现代号变了就不再写状态，
    /// 避免「重启时旧进程晚到的退出事件」把新进程的状态覆盖成 stopped。
    pub generation: AtomicU32,
    pub port: Mutex<Option<u16>>,
    pub exit_code: Mutex<Option<i32>>,
    pub logs: Mutex<VecDeque<String>>,
    pub log_file: Mutex<Option<PathBuf>>,
    pub intentional_stop: AtomicBool,
    pub exited: AtomicBool,
    /// 退出清理是否已被认领（保证 [`shutdown_on_exit`] 幂等）
    pub shutdown: ShutdownGuard,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// 在 setup 阶段初始化日志文件路径（appData/console.log）。
pub fn init_log_file(app: &AppHandle) {
    let state = app.state::<ServiceState>();
    if let Ok(dir) = app.path().app_data_dir() {
        if std::fs::create_dir_all(&dir).is_ok() {
            *lock(&state.log_file) = Some(dir.join("console.log"));
        }
    }
}

/// 追加一行日志：进入环形缓冲（容量 [`LOG_CAPACITY`]）并写入磁盘文件。
pub fn append_log_line(app: &AppHandle, line: &str) {
    let state = app.state::<ServiceState>();
    let stamped = format!("[{}] {}", chrono::Local::now().format("%H:%M:%S"), line);
    {
        let mut logs = lock(&state.logs);
        if logs.len() >= LOG_CAPACITY {
            logs.pop_front();
        }
        logs.push_back(stamped.clone());
    }
    let log_file = lock(&state.log_file).clone();
    if let Some(path) = log_file {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{stamped}");
        }
    }
}

/// 读取当前状态快照。
pub fn current_status(app: &AppHandle) -> StatusSnapshot {
    let state = app.state::<ServiceState>();
    let phase = *lock(&state.phase);
    let port = *lock(&state.port);
    let detail = match phase {
        Phase::Crashed => {
            let code = *lock(&state.exit_code);
            Some(match code {
                Some(c) => format!("服务意外退出（退出码：{c}）。"),
                None => "服务意外退出。".to_string(),
            })
        }
        _ => None,
    };
    StatusSnapshot { phase, port, detail }
}

/// 更新状态、广播 service-status 事件，并同步初始化流水线阶段。
fn set_phase(
    app: &AppHandle,
    phase: Phase,
    port: Option<u16>,
    detail: Option<String>,
) -> StatusSnapshot {
    let state = app.state::<ServiceState>();
    *lock(&state.phase) = phase;
    *lock(&state.port) = port;
    let snap = StatusSnapshot { phase, port, detail: detail.clone() };
    let _ = app.emit("service-status", snap.clone());
    // 崩溃 / 正常退出要反映到流水线阶段（决定 UI 是否展示「重试」）
    crate::bootstrap::on_service_phase(app, phase, detail);
    snap
}

/// HTTP 健康检查：GET /api/state 返回 2xx 即视为就绪。
fn check_health(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}{}", config::HEALTH_PATH);
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    client
        .get(url)
        .send()
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// 启动 stdout/stderr 转发线程与退出监控线程（接管 Child 所有权）。
///
/// `generation` 是本进程的代号：退出监控发现当前代号已变（已被新进程取代）时
/// 只记录日志、不写任何状态，避免旧进程事件污染新进程。
fn spawn_pump(app: &AppHandle, mut child: Child, generation: u32) {
    use std::io::{BufRead, BufReader};

    let app_out = app.clone();
    if let Some(out) = child.stdout.take() {
        thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                append_log_line(&app_out, &format!("[server] {line}"));
                let _ = app_out.emit("service-log", line);
            }
        });
    }

    let app_err = app.clone();
    if let Some(err) = child.stderr.take() {
        thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                append_log_line(&app_err, &format!("[server] {line}"));
                let _ = app_err.emit("service-log", line);
            }
        });
    }

    // 退出监控：非预期退出 → Crashed；主动停止 → Stopped
    let app_watch = app.clone();
    thread::spawn(move || {
        let status = child.wait();
        let state = app_watch.state::<ServiceState>();
        let code = status.ok().and_then(|s| s.code());
        if state.generation.load(Ordering::SeqCst) != generation {
            append_log_line(
                &app_watch,
                &format!("[service] 旧进程已退出（退出码：{code:?}），已被新进程取代，忽略本次事件"),
            );
            return;
        }
        state.exited.store(true, Ordering::SeqCst);
        *lock(&state.exit_code) = code;
        state.pid.store(0, Ordering::SeqCst);

        let intentional = state.intentional_stop.load(Ordering::SeqCst);
        let (phase, detail) = match (intentional, code) {
            (true, c) => (
                Phase::Stopped,
                Some(format!(
                    "服务已停止（退出码：{}）。",
                    c.map(|x| x.to_string()).unwrap_or_else(|| "未知".into())
                )),
            ),
            (false, Some(0)) => (Phase::Stopped, Some("服务进程已退出（退出码：0）。".into())),
            (false, c) => (
                Phase::Crashed,
                Some(format!(
                    "服务意外退出（退出码：{}）。",
                    c.map(|x| x.to_string()).unwrap_or_else(|| "未知".into())
                )),
            ),
        };
        let port = *lock(&state.port);
        set_phase(&app_watch, phase, port, detail);
    });
}

/// 启动服务的阻塞实现（必须在 spawn_blocking / 后台线程中调用）。
pub fn start_service_blocking(app: &AppHandle) -> anyhow::Result<StatusSnapshot> {
    let state = app.state::<ServiceState>();
    let (current_phase, current_port, alive) = {
        let phase = lock(&state.phase);
        let port = lock(&state.port);
        (*phase, *port, state.pid.load(Ordering::SeqCst) != 0)
    };
    // 已在运行 / 正在启动：直接返回当前状态。
    // 必须同时确认进程还活着（pid != 0）：重启流程里 stop 刚结束时 phase 可能还是
    // Running，此时直接返回会把「已死进程的端口」当成就绪端口上报。
    if alive && matches!(current_phase, Phase::Running | Phase::Starting) {
        if let Some(port) = current_port {
            return Ok(StatusSnapshot { phase: current_phase, port: Some(port), detail: None });
        }
    }

    let business_dir = config::ensure_business_dir(app)?;
    let server = business_dir.join(config::ENTRY_FILE);
    if !server.is_file() {
        let msg = format!(
            "业务代码尚未就绪：未找到 {}。请点击「重试」重新初始化。",
            server.display()
        );
        set_phase(app, Phase::Error, None, Some(msg.clone()));
        anyhow::bail!("{msg}");
    }
    let Some(node) = env_check::find_node() else {
        let msg = "未找到 Node.js。请先点击「安装 Node.js」，装好后会自动继续。".to_string();
        set_phase(app, Phase::Error, None, Some(msg.clone()));
        anyhow::bail!("{msg}");
    };

    // 端口：固定首选 3000，被占用则自动向上找第一个空闲端口
    let port = match find_free_port_in(config::DEFAULT_PORT, u16::MAX) {
        Ok(p) => p,
        Err(_) => {
            let err = ServiceError::PortExhausted(config::DEFAULT_PORT);
            set_phase(app, Phase::Error, None, Some(err.to_string()));
            return Err(err.into());
        }
    };
    if port != config::DEFAULT_PORT {
        append_log_line(
            app,
            &format!("端口 {} 已被占用，自动改用 {port}", config::DEFAULT_PORT),
        );
    }

    // 直接用检测到的 node 绝对路径 spawn，不经过 shell
    let mut cmd = Command::new(&node);
    cmd.arg(config::ENTRY_FILE)
        .current_dir(&business_dir)
        .env("PORT", port.to_string());
    path_env::prepare_command(&mut cmd);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // 独立进程组，便于整组信号（pgid == pid）
        cmd.process_group(0);
    }
    // 竞态修复：退出标记必须在 spawn **之前**复位。
    // 若放在 spawn 之后，进程瞬间退出时 watcher 写入的 exited=true 会被覆盖，
    // 健康检查将无视已退出的进程空转 30 秒。
    state.exited.store(false, Ordering::SeqCst);
    state.intentional_stop.store(false, Ordering::SeqCst);
    *lock(&state.exit_code) = None;
    // 代号自增：从这一刻起，上一代进程的退出事件一律失效
    let generation = state.generation.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("启动服务进程失败：{e}");
            set_phase(app, Phase::Error, Some(port), Some(msg.clone()));
            anyhow::bail!("{msg}");
        }
    };
    let pid = child.id();
    state.pid.store(pid, Ordering::SeqCst);
    append_log_line(
        app,
        &format!(
            "[service] 服务进程已启动：pid={pid}，端口={port}，node={}，目录={}",
            node.display(),
            business_dir.display()
        ),
    );
    set_phase(app, Phase::Starting, Some(port), None);

    spawn_pump(app, child, generation);

    // 轮询健康检查，就绪后才算启动成功
    let deadline = Instant::now() + Duration::from_millis(HEALTH_TIMEOUT_MS);
    loop {
        if state.exited.load(Ordering::SeqCst) {
            let code = lock(&state.exit_code);
            let code_text = code.map(|c| c.to_string()).unwrap_or_else(|| "未知".into());
            return Err(ServiceError::ExitedEarly(code_text).into());
        }
        if check_health(port) {
            append_log_line(
                app,
                &format!(
                    "[service] 健康检查通过：http://127.0.0.1:{port}{}",
                    config::HEALTH_PATH
                ),
            );
            return Ok(set_phase(app, Phase::Running, Some(port), None));
        }
        if Instant::now() >= deadline {
            set_phase(app, Phase::Error, Some(port), None);
            return Err(ServiceError::HealthTimeout(HEALTH_TIMEOUT_MS / 1000).into());
        }
        thread::sleep(Duration::from_millis(500));
    }
}

/// 向进程（组）发送信号。
#[cfg(unix)]
fn send_signal(pid: u32, sig: &str) {
    // 服务以独立进程组启动（pgid == pid），先对整组发信号，再补发单个进程
    let mut group = Command::new("kill");
    group.arg(sig).arg(format!("-{pid}"));
    path_env::prepare_command(&mut group);
    let _ = group.output();

    let mut single = Command::new("kill");
    single.arg(sig).arg(pid.to_string());
    path_env::prepare_command(&mut single);
    let _ = single.output();
}

#[cfg(unix)]
fn send_sigterm(pid: u32) {
    send_signal(pid, "-TERM");
}

#[cfg(unix)]
fn send_sigkill(pid: u32) {
    send_signal(pid, "-KILL");
}

#[cfg(windows)]
fn taskkill(pid: u32, force: bool) {
    let mut cmd = Command::new("taskkill");
    cmd.arg("/PID").arg(pid.to_string()).arg("/T");
    if force {
        cmd.arg("/F");
    }
    // 与全仓约定一致：所有子进程都必须经过统一 PATH 构造
    path_env::prepare_command(&mut cmd);
    let _ = cmd.output();
}

#[cfg(windows)]
fn send_sigterm(pid: u32) {
    taskkill(pid, false);
}

#[cfg(windows)]
fn send_sigkill(pid: u32) {
    taskkill(pid, true);
}

/// 停止服务的阻塞实现：SIGTERM → 宽限等待 → 超时 SIGKILL。
pub fn stop_service_blocking(app: &AppHandle) -> anyhow::Result<StatusSnapshot> {
    let state = app.state::<ServiceState>();
    let pid = state.pid.load(Ordering::SeqCst);
    if pid == 0 {
        return Ok(current_status(app));
    }
    state.intentional_stop.store(true, Ordering::SeqCst);
    append_log_line(app, &format!("[service] 正在停止服务进程 pid={pid} ..."));
    send_sigterm(pid);

    let deadline = Instant::now() + Duration::from_millis(GRACEFUL_STOP_MS);
    while state.pid.load(Ordering::SeqCst) != 0 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(100));
    }
    if state.pid.load(Ordering::SeqCst) != 0 {
        append_log_line(app, "[service] 优雅停止超时，强制结束进程 ...");
        send_sigkill(pid);
        let deadline2 = Instant::now() + Duration::from_secs(3);
        while state.pid.load(Ordering::SeqCst) != 0 && Instant::now() < deadline2 {
            thread::sleep(Duration::from_millis(100));
        }
        if state.pid.load(Ordering::SeqCst) != 0 {
            set_phase(
                app,
                Phase::Error,
                None,
                Some("无法停止服务进程，请手动检查。".into()),
            );
            return Err(ServiceError::StopFailed.into());
        }
    }
    Ok(current_status(app))
}

/// 应用退出时的同步优雅关闭（最多阻塞约 3 秒）。
///
/// **幂等**：正常关窗（`RunEvent::Exit`）与信号退出（SIGTERM / SIGINT / SIGHUP）
/// 可能都会调用本函数，只有第一次真正执行，之后直接返回。
pub fn shutdown_on_exit(app: &AppHandle) {
    let state = app.state::<ServiceState>();
    if !state.shutdown.claim() {
        // 已由另一条路径完成清理（或正在清理）
        return;
    }
    let pid = state.pid.load(Ordering::SeqCst);
    if pid != 0 {
        state.intentional_stop.store(true, Ordering::SeqCst);
        append_log_line(app, &format!("[service] 应用退出，停止服务进程 pid={pid} ..."));
        send_sigterm(pid);
        let deadline = Instant::now() + Duration::from_secs(3);
        while state.pid.load(Ordering::SeqCst) != 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        if state.pid.load(Ordering::SeqCst) != 0 {
            append_log_line(app, "[service] 优雅退出超时，强制结束服务进程 ...");
            send_sigkill(pid);
        }
    }
}

/// Tauri 命令：拉取日志环形缓冲快照。
#[tauri::command]
pub fn get_logs(app: AppHandle) -> Vec<String> {
    let state = app.state::<ServiceState>();
    let logs: Vec<String> = lock(&state.logs).iter().cloned().collect();
    logs
}

/// 在 `[preferred, max]` 区间内查找第一个可绑定端口。
///
/// 抽出为独立函数，便于测试「区间耗尽」这一分支（命令层用 `u16::MAX` 无法真实耗尽）。
fn find_free_port_in(preferred: u16, max: u16) -> Result<u16, String> {
    for port in preferred..=max {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    Err(format!("从端口 {preferred} 起至 {max} 均无空闲端口，请释放一个端口后重试"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_port_returns_bindable_port() {
        let port = find_free_port_in(45000, u16::MAX).expect("45000 起应能找到空闲端口");
        assert!(TcpListener::bind(("127.0.0.1", port)).is_ok());
    }

    #[test]
    fn find_free_port_skips_port_already_in_use() {
        let busy = TcpListener::bind(("127.0.0.1", 0)).expect("绑定临时端口");
        let busy_port = busy.local_addr().expect("读取端口").port();
        let found = find_free_port_in(busy_port, u16::MAX).expect("应能找到空闲端口");
        assert_ne!(found, busy_port, "占用中的端口不能作为空闲端口返回");
        assert!(found > busy_port, "应从 preferred 起向后查找，实际 {found}");
        assert!(
            TcpListener::bind(("127.0.0.1", found)).is_ok(),
            "返回的端口 {found} 必须可绑定"
        );
    }

    /// D9 回归：端口查找不得返回占用中的端口。
    #[test]
    fn find_free_port_never_returns_busy_port() {
        // 65535 若空闲则只能返回 65535；若被占用则必须报错（两种情况都不允许返回占用端口）
        let holder = TcpListener::bind(("127.0.0.1", 0)).expect("绑定临时端口");
        let busy_port = holder.local_addr().expect("读取端口").port();
        match find_free_port_in(busy_port, u16::MAX) {
            Ok(p) => assert_ne!(p, busy_port, "不得返回占用端口"),
            Err(msg) => assert!(msg.contains("无空闲端口"), "错误信息应说明端口耗尽：{msg}"),
        }
    }

    /// D9 回归：区间耗尽必须返回错误（用单端口区间真实触发 Err 分支）。
    #[test]
    fn find_free_port_in_reports_error_when_range_exhausted() {
        let holder = TcpListener::bind(("127.0.0.1", 0)).expect("绑定临时端口");
        let busy_port = holder.local_addr().expect("读取端口").port();
        let err =
            find_free_port_in(busy_port, busy_port).expect_err("单端口区间且被占用时必须报错");
        assert!(err.contains("无空闲端口"), "错误信息应说明端口耗尽：{err}");
    }

    /// 端口回退：首选端口被占用时自动向上找空闲端口，空闲时原样使用（不跳号）。
    #[test]
    fn port_falls_back_upward_from_preferred() {
        let holder = TcpListener::bind(("127.0.0.1", 0)).expect("绑定临时端口");
        let busy_port = holder.local_addr().expect("读取端口").port();
        let picked = find_free_port_in(busy_port, u16::MAX).expect("应回退到相邻空闲端口");
        assert!(picked > busy_port, "回退必须向上查找：busy={busy_port} picked={picked}");

        let probe = TcpListener::bind(("127.0.0.1", 0)).expect("绑定探针端口");
        let free_port = probe.local_addr().expect("读取端口").port();
        drop(probe);
        assert_eq!(
            find_free_port_in(free_port, u16::MAX).ok(),
            Some(free_port),
            "首选端口空闲时必须直接使用，不得跳号"
        );
    }

    /// 前端 `types.ts` 的 ServicePhase 字面量与 Rust Phase 的序列化必须一一对应。
    #[test]
    fn phase_serializes_to_frontend_literal_names() {
        let cases = [
            (Phase::Idle, "idle"),
            (Phase::Starting, "starting"),
            (Phase::Running, "running"),
            (Phase::Stopped, "stopped"),
            (Phase::Crashed, "crashed"),
            (Phase::Error, "error"),
        ];
        for (phase, expected) in cases {
            let json = serde_json::to_string(&phase).expect("序列化 Phase");
            assert_eq!(json, format!("\"{expected}\""));
        }
    }

    #[test]
    fn status_snapshot_matches_frontend_contract() {
        let snap = StatusSnapshot { phase: Phase::Running, port: Some(3000), detail: None };
        let value: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&snap).expect("序列化快照"))
                .expect("解析快照");
        assert_eq!(value["phase"], "running");
        assert_eq!(value["port"], 3000);
        assert!(value["detail"].is_null(), "detail 为 None 时应序列化为 null");
    }

    /// 退出清理幂等：`RunEvent::Exit`（关窗）与信号处理（kill / 关机）可能都调用
    /// `shutdown_on_exit`，重复调用必须直接返回、不 panic、不重复等待。
    #[test]
    fn shutdown_guard_claims_only_once() {
        let guard = ShutdownGuard::default();
        assert!(guard.claim(), "第一次调用必须由本次执行清理");
        assert!(!guard.claim(), "第二次调用必须直接返回，不重复清理");
        assert!(!guard.claim(), "任意次重复调用都只生效一次");
    }

    /// 新建状态时清理尚未被认领（应用刚启动，退出时仍需执行清理）。
    #[test]
    fn shutdown_guard_starts_unclaimed() {
        let state = ServiceState::default();
        assert!(!state.shutdown.claimed.load(Ordering::SeqCst), "初始状态不得是已认领");
        assert!(state.shutdown.claim(), "首次退出必须执行清理");
        assert!(!state.shutdown.claim(), "再次退出不得重复执行");
    }
}
