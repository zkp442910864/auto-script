//! 子进程执行的通用工具：流式输出转发、HTTP 下载、npm 依赖安装。
//!
//! 所有命令的 stdout/stderr 都逐行转发给前端事件，并同步写入应用日志文件。

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::env_check;
use crate::service;

/// 运行一条命令，把 stdout/stderr 逐行通过事件 `event` 发给前端，并写入日志文件。
///
/// `event` 必须是 `'static` 字面量（如 "bootstrap-log"、"env-log"、"update-log"）。
pub fn run_streamed(
    app: &AppHandle,
    event: &'static str,
    mut cmd: Command,
) -> anyhow::Result<()> {
    use std::io::{BufRead, BufReader};

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| anyhow::anyhow!("启动进程失败：{e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let app_out = app.clone();
    let t_out = thread::spawn(move || {
        if let Some(out) = stdout {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                service::append_log_line(&app_out, &format!("[proc] {line}"));
                let _ = app_out.emit(event, line);
            }
        }
    });

    let app_err = app.clone();
    let t_err = thread::spawn(move || {
        if let Some(err) = stderr {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                service::append_log_line(&app_err, &format!("[proc] {line}"));
                let _ = app_err.emit(event, line);
            }
        }
    });

    let status = child
        .wait()
        .map_err(|e| anyhow::anyhow!("等待进程结束失败：{e}"))?;
    let _ = t_out.join();
    let _ = t_err.join();

    if status.success() {
        Ok(())
    } else {
        anyhow::bail!(
            "命令执行失败（退出码：{}）",
            status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "被信号终止".into())
        );
    }
}

/// 下载文件到指定路径。
///
/// `progress(downloaded_bytes, total_bytes)`：`total_bytes` 在服务端未给出长度时为 0，
/// 调用方需自行处理（按不确定进度展示）。同一百分比内不会重复回调。
pub fn download_file(
    url: &str,
    dest: &Path,
    progress: &dyn Fn(u64, u64),
) -> anyhow::Result<()> {
    use std::io::Write;

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| anyhow::anyhow!("创建 HTTP 客户端失败：{e}"))?;
    let mut resp = client
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| anyhow::anyhow!("下载失败：{e}"))?;
    let total = resp.content_length().unwrap_or(0);

    let mut file = std::fs::File::create(dest)
        .map_err(|e| anyhow::anyhow!("创建文件 {} 失败：{e}", dest.display()))?;
    let mut buf = [0u8; 65536];
    let mut downloaded: u64 = 0;
    let mut last_pct: u64 = u64::MAX;
    loop {
        let n = resp
            .read(&mut buf)
            .map_err(|e| anyhow::anyhow!("读取下载数据失败：{e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| anyhow::anyhow!("写入文件失败：{e}"))?;
        downloaded += n as u64;
        if total > 0 {
            let pct = downloaded.saturating_mul(100) / total;
            if pct != last_pct {
                last_pct = pct;
                progress(downloaded, total);
            }
        } else {
            // 长度未知：按 1 MB 粒度回调，避免刷屏
            if downloaded / (1024 * 1024) != last_pct {
                last_pct = downloaded / (1024 * 1024);
                progress(downloaded, 0);
            }
        }
    }
    Ok(())
}

/// 安装业务依赖：在业务目录执行 `npm run setup`（幂等可重跑）。
///
/// 前提是业务目录已有 `package.json`（首次初始化在拉取代码之后才会调用）。
pub fn install_dependencies_blocking(app: &AppHandle, dir: &Path) -> anyhow::Result<()> {
    if !dir.join("package.json").is_file() {
        anyhow::bail!("业务目录缺少 package.json：{}", dir.display());
    }
    let mut cmd = env_check::npm_command(&["run", "setup"])?;
    cmd.current_dir(dir);
    service::append_log_line(app, "[setup] 开始安装业务依赖（npm run setup）...");
    let result = run_streamed(app, "bootstrap-log", cmd);
    match &result {
        Ok(()) => service::append_log_line(app, "[setup] 业务依赖安装完成。"),
        Err(e) => service::append_log_line(app, &format!("[setup] 业务依赖安装失败：{e:#}")),
    }
    result
}
