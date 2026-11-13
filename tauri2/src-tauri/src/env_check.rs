//! 运行环境自检（node / npm）与 Node.js 自动补装。
//!
//! 补装策略：
//! - Windows：`winget install OpenJS.NodeJS.LTS`
//! - macOS：有 Homebrew 则 `brew install node`，否则下载官方 pkg 并请求管理员权限安装
//! - Linux（apt 系）：下载 NodeSource setup 脚本后 `sudo bash` + `sudo apt-get install nodejs`
//!
//! 补装完成后由 [`path_env::prepare_command`] 保证后续子进程能找到新装的 node。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::path_env;
use crate::proc_util;
use crate::service;

/// 要求的最低 Node 主版本。
pub const MIN_NODE_MAJOR: u32 = 18;

/// 单个工具（node / npm）的检测结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub name: String,
    pub ok: bool,
    pub version: Option<String>,
    pub detail: Option<String>,
}

/// 在增强 PATH 的目录列表中查找可执行文件（返回绝对路径）。
pub fn which(program: &str) -> Option<PathBuf> {
    let candidates: Vec<String> = if cfg!(windows) {
        vec![
            format!("{program}.exe"),
            format!("{program}.cmd"),
            format!("{program}.bat"),
            program.to_string(),
        ]
    } else {
        vec![program.to_string()]
    };
    for dir in path_env::path_dirs() {
        for name in &candidates {
            let p = dir.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// 定位 node 可执行文件（绝对路径）。
pub fn find_node() -> Option<PathBuf> {
    which("node")
}

/// 定位 npm-cli.js（Windows 下用 node 直接执行它，规避 .cmd 需要 shell 的问题）。
pub fn find_npm_cli_js() -> Option<PathBuf> {
    let node = find_node()?;
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(bin_dir) = node.parent() {
        candidates.push(bin_dir.join("node_modules/npm/bin/npm-cli.js"));
        candidates.push(bin_dir.join("../lib/node_modules/npm/bin/npm-cli.js"));
    }
    candidates.push(PathBuf::from("/usr/local/lib/node_modules/npm/bin/npm-cli.js"));
    candidates.push(PathBuf::from("/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js"));
    candidates.into_iter().find(|p| p.is_file())
}

/// 构造一条运行 npm 的命令（不经过 shell）。
pub fn npm_command(args: &[&str]) -> anyhow::Result<Command> {
    let mut cmd = if cfg!(windows) {
        let node = find_node().ok_or_else(|| anyhow::anyhow!("未找到 node，无法运行 npm"))?;
        let cli = find_npm_cli_js().ok_or_else(|| anyhow::anyhow!("未找到 npm-cli.js，无法运行 npm"))?;
        let mut c = Command::new(node);
        c.arg(cli);
        c
    } else {
        let npm = which("npm").ok_or_else(|| anyhow::anyhow!("未找到 npm 可执行文件"))?;
        Command::new(npm)
    };
    cmd.args(args);
    path_env::prepare_command(&mut cmd);
    Ok(cmd)
}

/// 运行 `<program> <arg>` 并返回 trimmed stdout。
fn run_version(program: &Path, arg: &str) -> anyhow::Result<String> {
    let mut cmd = Command::new(program);
    cmd.arg(arg);
    path_env::prepare_command(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| anyhow::anyhow!("执行 {} 失败：{e}", program.display()))?;
    if !output.status.success() {
        anyhow::bail!(
            "进程退出码：{}",
            output
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "未知".into())
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// 解析 `v22.3.0` 之类版本串的主版本号。
pub fn parse_major(version: &str) -> Option<u32> {
    version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()?
        .parse()
        .ok()
}

/// 检测 node / npm 是否可用（同步、轻量，应在 spawn_blocking 中调用）。
pub fn check_environment_blocking() -> Vec<ToolStatus> {
    // --- node ---
    let node_status = match find_node() {
        Some(path) => match run_version(&path, "--version") {
            Ok(v) => {
                let ok = parse_major(&v).is_some_and(|m| m >= MIN_NODE_MAJOR);
                let detail = if ok {
                    None
                } else {
                    Some(format!(
                        "Node 版本需 >= {MIN_NODE_MAJOR}（当前 {v}，路径 {}）",
                        path.display()
                    ))
                };
                ToolStatus { name: "Node.js".into(), ok, version: Some(v), detail }
            }
            Err(e) => ToolStatus {
                name: "Node.js".into(),
                ok: false,
                version: None,
                detail: Some(format!("执行 node --version 失败：{e:#}")),
            },
        },
        None => ToolStatus {
            name: "Node.js".into(),
            ok: false,
            version: None,
            detail: Some("未在 PATH 中找到 node".into()),
        },
    };

    // --- npm ---
    let npm_status = match which("npm") {
        Some(path) => match run_version(&path, "--version") {
            Ok(v) => ToolStatus { name: "npm".into(), ok: true, version: Some(v), detail: None },
            Err(e) => ToolStatus {
                name: "npm".into(),
                ok: false,
                version: None,
                detail: Some(format!("npm 存在（{}）但执行失败：{e:#}", path.display())),
            },
        },
        None => {
            // Windows 下 npm 可能只有 npm-cli.js 形式（随 node 安装）
            if cfg!(windows) && find_npm_cli_js().is_some() {
                ToolStatus { name: "npm".into(), ok: true, version: None, detail: None }
            } else {
                ToolStatus {
                    name: "npm".into(),
                    ok: false,
                    version: None,
                    detail: Some("未在 PATH 中找到 npm".into()),
                }
            }
        }
    };

    vec![node_status, npm_status]
}

/// 向前端发送环境安装过程日志。
fn emit_log(app: &AppHandle, line: &str) {
    service::append_log_line(app, &format!("[env] {line}"));
    let _ = app.emit("env-log", line.to_string());
}

/// 同步 GET 文本内容。
#[cfg_attr(target_os = "windows", allow(dead_code))] // Windows 走 winget，不需要拉取文本
fn fetch_text(url: &str) -> anyhow::Result<String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| anyhow::anyhow!("创建 HTTP 客户端失败：{e}"))?;
    client
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(|e| anyhow::anyhow!("网络请求失败：{e}"))
}

/// 运行一条命令并把 stdout/stderr 逐行发到 env-log 事件。
fn run_logged(app: &AppHandle, cmd: Command) -> anyhow::Result<()> {
    proc_util::run_streamed(app, "env-log", cmd)
}

// ---------------------------------------------------------------------------
// 各平台自动补装实现
// ---------------------------------------------------------------------------

/// macOS：优先 Homebrew，否则下载官方 pkg 并请求管理员权限安装。
#[cfg(target_os = "macos")]
fn install_node_impl(app: &AppHandle) -> anyhow::Result<()> {
    if let Some(brew) = which("brew") {
        emit_log(app, &format!("检测到 Homebrew（{}），执行 brew install node ...", brew.display()));
        let mut cmd = Command::new(brew);
        cmd.args(["install", "node"]);
        path_env::prepare_command(&mut cmd);
        return run_logged(app, cmd);
    }

    emit_log(app, "未检测到 Homebrew，改为下载 Node.js 官方 macOS 安装包 ...");
    let index = fetch_text("https://nodejs.org/dist/latest/")?;
    let pkg_name = index
        .split('"')
        .find(|seg| seg.starts_with("node-v") && seg.ends_with(".pkg"))
        .ok_or_else(|| anyhow::anyhow!("未能在 nodejs.org 上找到 macOS 安装包"))?;
    let url = format!("https://nodejs.org/dist/latest/{pkg_name}");
    let tmp = std::env::temp_dir().join(pkg_name);
    emit_log(app, &format!("下载 {url} ..."));
    proc_util::download_file(&url, &tmp, &|done, total| {
        let pct = if total > 0 { done.saturating_mul(100) / total } else { 0 };
        emit_log(app, &format!("下载进度 {pct}%（{done} / {total} 字节）"));
    })?;
    emit_log(app, "下载完成，请求管理员权限安装（如弹出密码框请输入开机密码）...");
    let script = format!(
        "do shell script \"installer -pkg '{}' -target /\" with administrator privileges",
        tmp.display()
    );
    let mut cmd = Command::new("osascript");
    cmd.arg("-e").arg(&script);
    path_env::prepare_command(&mut cmd);
    run_logged(app, cmd)
}

/// Linux（apt 系）：NodeSource 脚本 + apt-get install。
#[cfg(target_os = "linux")]
fn install_node_impl(app: &AppHandle) -> anyhow::Result<()> {
    if which("apt-get").is_none() {
        anyhow::bail!("仅支持基于 apt 的 Debian/Ubuntu 系统自动安装，请手动安装 Node.js >= {MIN_NODE_MAJOR}");
    }
    emit_log(app, "使用 NodeSource 安装 Node.js 20.x（需要 sudo 权限）...");
    let script = fetch_text("https://deb.nodesource.com/setup_20.x")?;
    let path = std::env::temp_dir().join("nodesource_setup_20.sh");
    std::fs::write(&path, script).map_err(|e| anyhow::anyhow!("写入安装脚本失败：{e}"))?;
    let mut cmd = Command::new("sudo");
    cmd.arg("bash").arg(&path);
    path_env::prepare_command(&mut cmd);
    run_logged(app, cmd)?;

    let mut cmd = Command::new("sudo");
    cmd.args(["apt-get", "install", "-y", "nodejs"]);
    path_env::prepare_command(&mut cmd);
    run_logged(app, cmd)
}

/// Windows：winget 安装 LTS。
#[cfg(windows)]
fn install_node_impl(app: &AppHandle) -> anyhow::Result<()> {
    emit_log(app, "使用 winget 安装 Node.js LTS（OpenJS.NodeJS.LTS）...");
    let mut cmd = Command::new("winget");
    cmd.args([
        "install",
        "--id",
        "OpenJS.NodeJS.LTS",
        "--exact",
        "--accept-source-agreements",
        "--accept-package-agreements",
    ]);
    path_env::prepare_command(&mut cmd);
    run_logged(app, cmd)
}

/// 其他平台：不支持自动安装。
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn install_node_impl(_app: &AppHandle) -> anyhow::Result<()> {
    anyhow::bail!("当前平台不支持自动安装 Node.js，请手动安装 Node.js >= {MIN_NODE_MAJOR}");
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

/// 环境自检命令。
#[tauri::command]
pub async fn check_environment() -> Result<Vec<ToolStatus>, String> {
    tauri::async_runtime::spawn_blocking(check_environment_blocking)
        .await
        .map_err(|e| format!("内部错误：{e}"))
}

/// 自动补装 Node.js，返回补装后的环境检测结果。
///
/// 这是流水线唯一的「人工介入点」：环境检查失败时流水线暂停，用户点「安装 Node.js」，
/// 安装成功后**自动续跑**流水线（无需用户再点任何按钮）。
#[tauri::command]
pub async fn install_node(app: AppHandle) -> Result<Vec<ToolStatus>, String> {
    let handle = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        crate::bootstrap::set_stage(
            &handle,
            crate::bootstrap::Stage::InstallingNode,
            "正在安装 Node.js（可能弹出管理员密码框）…",
            None,
        );
        let result = install_node_impl(&handle);
        match &result {
            Ok(()) => emit_log(&handle, "Node.js 安装流程结束，重新检测环境 ..."),
            Err(e) => emit_log(&handle, &format!("Node.js 安装失败：{e:#}")),
        }
        match result {
            Ok(()) => {
                // 装完自动续跑：从「检查环境」重新验证，验证通过后继续拉代码/装依赖/启动
                crate::bootstrap::resume_pipeline_async(&handle);
                Ok(check_environment_blocking())
            }
            Err(e) => {
                let message = format!("{e:#}");
                crate::bootstrap::report_error(
                    &handle,
                    crate::bootstrap::Stage::CheckingEnv,
                    &format!("安装 Node.js 失败：{message}"),
                );
                Err(message)
            }
        }
    })
    .await
    .map_err(|e| format!("内部错误：{e}"))?;
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_major_handles_version_strings() {
        assert_eq!(parse_major("v22.3.0"), Some(22));
        assert_eq!(parse_major("18.19.1"), Some(18));
        assert_eq!(parse_major("18"), Some(18));
        assert_eq!(parse_major("  v18.0.0\n"), Some(18));
        assert_eq!(parse_major("abc"), None);
        assert_eq!(parse_major(""), None);
    }

    /// `>= 18` 的判定阈值：v17 必须判为不达标，v18/v20 达标。
    #[test]
    fn min_node_major_gate() {
        assert!(!parse_major("v17.9.9").is_some_and(|m| m >= MIN_NODE_MAJOR));
        assert!(parse_major("v18.0.0").is_some_and(|m| m >= MIN_NODE_MAJOR));
        assert!(parse_major("v22.22.2").is_some_and(|m| m >= MIN_NODE_MAJOR));
    }

    #[test]
    fn which_returns_none_for_unknown_program() {
        assert!(which("qa-definitely-not-a-real-binary-2026").is_none());
    }

    #[test]
    fn which_returns_existing_paths_for_known_program() {
        // 本机必定存在 sh/bash（PATH 增强后仍能找到）
        let found = which("sh").or_else(|| which("bash"));
        assert!(found.is_some_and(|p| p.is_file()), "未能在增强 PATH 中找到 sh/bash");
    }

    #[test]
    fn tool_status_serializes_as_camel_case_for_frontend() {
        let status = ToolStatus {
            name: "Node.js".into(),
            ok: true,
            version: Some("v22.0.0".into()),
            detail: None,
        };
        let value = serde_json::to_value(&status).expect("序列化 ToolStatus");
        for key in ["name", "ok", "version", "detail"] {
            assert!(value.get(key).is_some(), "缺少前端需要的字段 {key}");
        }
    }
}
