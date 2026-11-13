//! 发货控制台 Tauri 2 桌面壳 —— 零配置的一体化程序。
//!
//! 用户流程：下载应用 → 安装/启动 → **自动**拉取代码、检查环境、安装依赖、启动网页
//! → 用户直接去操作网页。界面上没有任何设置项：仓库地址、分支、端口、业务目录
//! 全部固化在 [`config`] 里。
//!
//! 模块职责：
//! - [`config`]：固定配置常量（仓库 / 分支 / 端口 / 入口文件）与业务目录解析
//! - [`bootstrap`]：启动流水线（检查环境 → 拉代码 → 装依赖 → 启动 → 健康检查 → 就绪）
//! - [`path_env`]：统一的子进程 PATH 构造（所有 spawn 必须经过它）
//! - [`env_check`]：node / npm 环境自检与自动补装
//! - [`proc_util`]：子进程流式输出转发、HTTP 下载、npm 调用封装
//! - [`service`]：业务服务生命周期（启动 / 健康检查 / 优雅停止 / 崩溃监控 / 日志）
//! - [`updater`]：GitHub zip 下载覆盖式更新（排除受保护路径）

mod bootstrap;
mod config;
mod env_check;
mod path_env;
mod proc_util;
mod service;
mod updater;

use bootstrap::Stage;

/// 注册 Unix 信号处理：SIGTERM / SIGINT / SIGHUP 也要优雅关闭业务服务。
///
/// 被信号终止时进程直接退出，**不会**产生 `RunEvent::Exit`，若不额外处理，
/// spawn 出去的 `node web/server.js` 会变成孤儿进程一直占着端口，
/// 用户下次启动就会漂到 3001（看起来像出错）。
///
/// 处理线程里只做「停服务 + 退出」这一件事；等待宽限逻辑在
/// [`service::shutdown_on_exit`] 内部（SIGTERM → 3s → SIGKILL），不会长时间卡住。
#[cfg(unix)]
fn install_signal_handlers(handle: tauri::AppHandle) {
    use signal_hook::consts::signal::{SIGHUP, SIGINT, SIGTERM};
    use signal_hook::iterator::Signals;

    let mut signals = match Signals::new([SIGTERM, SIGINT, SIGHUP]) {
        Ok(signals) => signals,
        Err(e) => {
            // 注册失败不影响正常使用（关窗仍走 RunEvent::Exit）
            eprintln!("注册退出信号处理器失败：{e}");
            return;
        }
    };
    std::thread::spawn(move || {
        if let Some(signal) = signals.forever().next() {
            service::append_log_line(
                &handle,
                &format!("[app] 收到退出信号 {signal}，正在关闭业务服务 ..."),
            );
            service::shutdown_on_exit(&handle);
            std::process::exit(0);
        }
    });
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .manage(service::ServiceState::default())
        .manage(bootstrap::BootstrapState::default())
        .invoke_handler(tauri::generate_handler![
            env_check::check_environment,
            env_check::install_node,
            bootstrap::bootstrap_status,
            bootstrap::retry_pipeline,
            bootstrap::restart_service,
            bootstrap::open_business_dir,
            service::get_logs,
            updater::check_update,
            updater::perform_update,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            service::init_log_file(&handle);
            bootstrap::init(&handle);
            // 信号退出（kill / 终端关闭 / 系统关机）也要清理业务服务，避免孤儿 node 占端口
            #[cfg(unix)]
            install_signal_handlers(handle.clone());
            // 启动即自动跑初始化流水线（无需用户点任何按钮）。
            // 用独立线程而非 spawn_blocking：流水线里包含长时间阻塞的下载与 npm install。
            std::thread::spawn(move || {
                if let Err(e) = bootstrap::run_pipeline_blocking(&handle, Stage::CheckingEnv) {
                    eprintln!("初始化流程中断：{e:#}");
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败");

    app.run(|app_handle, event| {
        // 正常关窗 / Cmd+Q 走这里；与信号处理共用幂等守卫，不会重复清理
        if let tauri::RunEvent::Exit = event {
            service::shutdown_on_exit(app_handle);
        }
    });
}

#[cfg(test)]
mod contract_tests {
    use std::collections::BTreeSet;

    /// 读取仓库内文件（相对 src-tauri）。
    fn read_rel(rel: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("读取 {} 失败：{e}", path.display()))
    }

    /// 前端 `src/api.ts` 中 `invoke('<name>')` 声明的命令名。
    fn frontend_commands() -> BTreeSet<String> {
        let text = read_rel("../src/api.ts");
        let mut names = BTreeSet::new();
        for line in text.lines() {
            let Some(pos) = line.find("invoke<") else { continue };
            let Some(start) = line[pos..].find('\'') else { continue };
            let rest = &line[pos + start + 1..];
            if let Some(end) = rest.find('\'') {
                names.insert(rest[..end].to_string());
            }
        }
        names
    }

    /// `generate_handler![...]` 中注册的命令名（取 `mod::name` 的最后一段）。
    fn backend_commands() -> BTreeSet<String> {
        let text = read_rel("src/lib.rs");
        let start = text.find("generate_handler![").expect("未找到 generate_handler 宏");
        let end = text[start..].find("])").expect("generate_handler 未闭合") + start;
        text[start..end]
            .lines()
            .filter_map(|line| {
                let item = line.trim().trim_end_matches(',').trim();
                if item.is_empty() || item.ends_with("![") {
                    return None;
                }
                item.rsplit("::").next().map(str::to_string)
            })
            .collect()
    }

    /// 前后端命令契约：前端调用的每个命令都必须注册，反之不留死命令。
    #[test]
    fn frontend_and_backend_command_lists_match() {
        let frontend = frontend_commands();
        let backend = backend_commands();
        assert!(!frontend.is_empty(), "未从 ../src/api.ts 解析到任何命令");
        assert!(!backend.is_empty(), "未从 lib.rs 解析到任何注册命令");
        let missing: Vec<_> = frontend.difference(&backend).cloned().collect();
        assert!(missing.is_empty(), "前端调用但后端未注册：{missing:?}；后端已注册：{backend:?}");
        let unused: Vec<_> = backend.difference(&frontend).cloned().collect();
        assert!(unused.is_empty(), "后端注册但前端未调用：{unused:?}");
    }

    /// 零配置重构契约：设置页与「可配置项」相关命令必须彻底消失，
    /// 且流水线命令必须两侧同时存在（防止契约测试因两侧都缺失而「空集相等」误判）。
    ///
    /// 被删除的命令名用 `concat!` 拼出，避免本文件自身被「全仓 grep 应为 0 命中」扫到。
    #[test]
    fn removed_settings_surface_is_gone_and_pipeline_commands_exist() {
        let frontend = frontend_commands();
        let backend = backend_commands();
        let removed = [
            concat!("get", "_settings"),
            concat!("save", "_settings"),
            concat!("business_dir", "_info"),
            concat!("install", "_dependencies"),
            concat!("find_free", "_port"),
            concat!("deps", "_installed"),
            concat!("start", "_service"),
            concat!("stop", "_service"),
        ];
        for name in removed {
            assert!(!frontend.contains(name), "前端 api.ts 仍保留已删除命令 {name}");
            assert!(!backend.contains(name), "lib.rs 仍注册已删除命令 {name}");
        }
        for name in ["bootstrap_status", "retry_pipeline", "open_business_dir", "install_node"] {
            assert!(frontend.contains(name), "前端 api.ts 缺少零配置命令 {name}：{frontend:?}");
            assert!(backend.contains(name), "lib.rs 缺少零配置命令 {name}：{backend:?}");
        }
        assert!(frontend.len() >= 9, "前端命令数异常：{}", frontend.len());
    }

    /// 前端不得再引用设置面板 / 目录选择对话框（零配置：没有设置页）。
    #[test]
    fn frontend_has_no_settings_panel_or_dialog() {
        let app_tsx = read_rel("../src/App.tsx");
        let api_ts = read_rel("../src/api.ts");
        let forbidden = [
            concat!("Settings", "Panel"),
            concat!("get", "Settings"),
            concat!("save", "Settings"),
            concat!("businessDir", "Info"),
            concat!("plugin", "-dialog"),
        ];
        for token in forbidden {
            assert!(!app_tsx.contains(token), "App.tsx 仍引用已删除的 {token}");
            assert!(!api_ts.contains(token), "api.ts 仍引用已删除的 {token}");
        }
    }

    /// 前端 `listen('<event>')` 的事件名必须由 Rust 侧 `emit` 产生（反之亦然）。
    #[test]
    fn frontend_event_names_are_emitted_by_backend() {
        let app_tsx = read_rel("../src/App.tsx");
        let events_line = app_tsx
            .lines()
            .find(|l| l.contains("for (const event of ["))
            .expect("未找到前端事件订阅列表");
        for name in ["bootstrap-log", "service-log", "env-log", "update-log"] {
            assert!(events_line.contains(name), "前端未订阅日志事件 {name}");
        }
        assert!(
            app_tsx.contains("listen<BootstrapSnapshot>('bootstrap-status'"),
            "前端未订阅 bootstrap-status"
        );
        assert!(
            app_tsx.contains("listen<StatusSnapshot>('service-status'"),
            "前端未订阅 service-status"
        );

        let rust_sources = [
            "src/bootstrap.rs",
            "src/service.rs",
            "src/proc_util.rs",
            "src/env_check.rs",
            "src/updater.rs",
        ]
        .iter()
        .map(|p| read_rel(p))
        .collect::<Vec<_>>()
        .join("\n");
        for event in [
            "\"bootstrap-status\"",
            "\"bootstrap-log\"",
            "\"service-status\"",
            "\"service-log\"",
            "\"env-log\"",
            "\"update-log\"",
        ] {
            assert!(rust_sources.contains(event), "Rust 侧未 emit 事件 {event}");
        }
    }

    /// 零配置：Rust 源码里不得残留占位仓库地址或 settings 模块引用。
    ///
    /// 只检查 `#[cfg(test)]` 之前的生产代码（测试里会用占位串做负面断言）。
    #[test]
    fn rust_sources_have_no_placeholder_address_or_settings_module() {
        let sources = ["src/config.rs", "src/updater.rs", "src/service.rs", "src/bootstrap.rs"]
            .iter()
            .map(|p| {
                let text = read_rel(p);
                match text.find("#[cfg(test)]") {
                    Some(idx) => text[..idx].to_string(),
                    None => text,
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        let placeholder = concat!("example", ".com");
        assert!(!sources.contains(placeholder), "仍存在占位仓库地址");
        assert!(!sources.contains("crate::settings"), "仍引用已删除的 settings 模块");
        assert!(!sources.contains("plugin_dialog"), "仍引用已删除的 dialog 插件");
    }
}
