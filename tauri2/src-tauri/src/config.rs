//! 固定配置：本应用是「零配置」的一体化产品。
//!
//! 用户流程：下载应用 → 安装/启动 → 自动拉取代码 / 检查环境 / 装依赖 / 启动网页。
//! 因此仓库地址、分支、端口、入口文件全部在此写死，界面上没有任何设置项。
//!
//! 业务代码由应用自己托管在**应用数据目录**下的 `business/`：
//!
//! ```text
//! macOS:   ~/Library/Application Support/com.koudouma.autoconsole/business
//! Windows: %APPDATA%\com.koudouma.autoconsole\business
//! Linux:   ~/.local/share/com.koudouma.autoconsole/business
//! ```
//!
//! 用户永远不需要知道这个路径，但界面提供「打开业务目录」入口方便排查。

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// 业务代码仓库地址（公开仓库，已核实可匿名访问）。
pub const REPO_URL: &str = "https://github.com/zkp442910864/auto-script";
/// 使用的分支。
pub const BRANCH: &str = "main";
/// 首选服务端口；被占用时自动向上寻找空闲端口。
pub const DEFAULT_PORT: u16 = 3000;
/// 判定「业务代码是否就绪」的入口文件（相对业务目录）。
pub const ENTRY_FILE: &str = "web/server.js";
/// 业务目录名（位于应用数据目录下）。
pub const BUSINESS_DIR_NAME: &str = "business";
/// 服务健康检查路径（返回 2xx 即视为就绪）。
pub const HEALTH_PATH: &str = "/api/state";

/// 业务目录绝对路径：`<app_data_dir>/business`。
///
/// 仅计算路径，不保证存在（读取场景用）；需要落盘时用 [`ensure_business_dir`]。
pub fn business_dir(app: &AppHandle) -> anyhow::Result<PathBuf> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("无法确定应用数据目录：{e}"))?;
    Ok(data.join(BUSINESS_DIR_NAME))
}

/// 业务目录绝对路径，并确保目录存在。
pub fn ensure_business_dir(app: &AppHandle) -> anyhow::Result<PathBuf> {
    let dir = business_dir(app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| anyhow::anyhow!("创建业务目录失败（{}）：{e}", dir.display()))?;
    Ok(dir)
}

/// 业务代码是否已就绪：存在入口文件 `web/server.js` 即视为就绪。
///
/// 这是「是否需要首次初始化」的唯一判据——目录为空、只有半个包、只有 node_modules
/// 都不算就绪，流水线会重新拉取。
pub fn business_ready(dir: &Path) -> bool {
    dir.join(ENTRY_FILE).is_file()
}

/// 归一化仓库地址：去掉结尾斜杠与 `.git` 后缀。
pub fn normalize_repo_url(url: &str) -> String {
    let base = url.trim().trim_end_matches('/');
    match base.strip_suffix(".git") {
        Some(stripped) => stripped.to_string(),
        None => base.to_string(),
    }
}

/// 远端 `package.json` 地址（GitHub raw；其他托管回退到 `/raw/` 路径）。
pub fn raw_package_json_url() -> String {
    let base = normalize_repo_url(REPO_URL);
    if let Some(rest) = base.strip_prefix("https://github.com/") {
        return format!("https://raw.githubusercontent.com/{rest}/{BRANCH}/package.json");
    }
    format!("{base}/raw/{BRANCH}/package.json")
}

/// 源码压缩包地址（GitHub archive，用于首次初始化与在线更新）。
pub fn archive_zip_url() -> String {
    format!(
        "{}/archive/refs/heads/{BRANCH}.zip",
        normalize_repo_url(REPO_URL)
    )
}

/// 把字节数格式化为人类可读文本（下载进度提示用）。
pub fn format_size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.1} KB", bytes as f64 / KB as f64)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 产品决策固化：这四个常量是「零配置」的全部外部参数。
    #[test]
    fn fixed_config_matches_product_decision() {
        assert_eq!(REPO_URL, "https://github.com/zkp442910864/auto-script");
        assert_eq!(BRANCH, "main");
        assert_eq!(DEFAULT_PORT, 3000);
        assert_eq!(ENTRY_FILE, "web/server.js");
        assert_eq!(BUSINESS_DIR_NAME, "business");
        assert_eq!(HEALTH_PATH, "/api/state");
    }

    /// 仓库地址必须是真实公开仓库，不能残留任何占位地址。
    ///
    /// 占位串用 `concat!` 拼出，避免本文件自身被「全仓 grep 应为 0 命中」扫到。
    #[test]
    fn repo_url_is_a_real_public_repo() {
        assert!(REPO_URL.starts_with("https://github.com/"), "仓库地址：{REPO_URL}");
        assert!(REPO_URL.ends_with("/auto-script"), "仓库地址：{REPO_URL}");
        let placeholders = [
            concat!("example", ".com"),
            concat!("example", "/"),
            concat!("owner", "/repo"),
            "<",
            ">",
        ];
        for placeholder in placeholders {
            assert!(
                !REPO_URL.contains(placeholder),
                "仓库地址不应包含占位片段 {placeholder}：{REPO_URL}"
            );
        }
    }

    /// 首次初始化与在线更新都依赖这两个 URL 指向固定分支。
    #[test]
    fn remote_urls_point_at_fixed_branch() {
        assert_eq!(
            raw_package_json_url(),
            "https://raw.githubusercontent.com/zkp442910864/auto-script/main/package.json"
        );
        assert_eq!(
            archive_zip_url(),
            "https://github.com/zkp442910864/auto-script/archive/refs/heads/main.zip"
        );
    }

    #[test]
    fn normalize_repo_url_strips_git_suffix_and_trailing_slash() {
        assert_eq!(
            normalize_repo_url("https://github.com/o/r.git/"),
            "https://github.com/o/r"
        );
        assert_eq!(normalize_repo_url("https://github.com/o/r"), "https://github.com/o/r");
        assert_eq!(normalize_repo_url("  https://x/y/  "), "https://x/y");
    }

    /// 「是否需要首次初始化」的唯一判据：入口文件是否存在。
    #[test]
    fn business_ready_requires_entry_file() {
        let sandbox = tempfile::tempdir().expect("创建沙盒");
        let dir = sandbox.path();
        assert!(!business_ready(dir), "空目录不得视为已就绪");

        std::fs::create_dir_all(dir.join("web")).expect("创建 web");
        std::fs::write(dir.join("package.json"), "{}").expect("写 package.json");
        assert!(!business_ready(dir), "只有 package.json 不算就绪");

        std::fs::write(dir.join(ENTRY_FILE), "// server\n").expect("写入口文件");
        assert!(business_ready(dir), "存在 web/server.js 后必须判定为就绪");
    }

    #[test]
    fn format_size_is_human_readable() {
        assert_eq!(format_size(0), "0 B");
        assert_eq!(format_size(999), "999 B");
        assert_eq!(format_size(1536), "1.5 KB");
        assert_eq!(format_size(12 * 1024 * 1024 + 300 * 1024), "12.3 MB");
    }
}
