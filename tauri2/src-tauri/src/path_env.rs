//! 统一的子进程 PATH 构造工具。
//!
//! Node.js 补装完成后，当前进程的 PATH 不会自动刷新，这是本应用最容易翻车的点。
//! 因此**所有子进程 spawn 都必须调用 [`prepare_command`]**，把常见 Node 安装路径
//! 显式拼进 PATH（macOS/Linux：`/usr/local/bin`、`/opt/homebrew/bin`、
//! `~/.nvm/versions/node/*/bin` 等；Windows：`C:\Program Files\nodejs` 等）。

use std::collections::HashSet;
use std::env;
use std::path::PathBuf;
use std::process::Command;

/// macOS / Linux 下常见的 Node 可执行目录（前置，优先于现有 PATH）。
const UNIX_EXTRA_DIRS: &[&str] = &[
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

/// Windows 下常见的 Node 安装目录（前置，优先于现有 PATH）。
#[cfg(windows)]
const WINDOWS_EXTRA_DIRS: &[&str] = &[
    r"C:\Program Files\nodejs",
    r"C:\Program Files (x86)\nodejs",
];

/// 解析 nvm 版本目录（如 `v22.3.0`）为可比较的数字序列，用于降序排列。
///
/// 单独抽出便于测试：`v9.1.0 < v16.0.0 < v22.3.0` 必须按数值而不是字典序比较。
fn version_sort_key(bin_dir: &std::path::Path) -> Vec<u64> {
    let name = bin_dir
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    name.trim_start_matches('v')
        .split('.')
        .map(|s| s.parse::<u64>().unwrap_or(0))
        .collect()
}

/// 收集 `~/.nvm/versions/node/*/bin` 下实际存在的目录，按版本号**降序**排列。
///
/// 降序很重要：`which()` 取首个命中，若升序会在 nvm 同时存在 v16/v18/v22 时
/// 选中 v16，误报「版本过低」，且 brew 新装的版本永远无法被选中（nvm 目录恒在前）。
fn nvm_bin_dirs() -> Vec<PathBuf> {
    let mut result = Vec::new();
    if let Some(home) = dirs::home_dir() {
        let versions = home.join(".nvm").join("versions").join("node");
        if let Ok(entries) = std::fs::read_dir(&versions) {
            for entry in entries.flatten() {
                let bin = entry.path().join("bin");
                if bin.is_dir() {
                    result.push(bin);
                }
            }
        }
        result.sort_by(|a, b| version_sort_key(b).cmp(&version_sort_key(a)));
    }
    result
}

/// 构造完整的候选目录列表：常见安装目录（前置）+ 现有 PATH（去重、保序）。
pub fn path_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();

    if cfg!(unix) {
        for d in nvm_bin_dirs() {
            dirs.push(d);
        }
        for d in UNIX_EXTRA_DIRS {
            dirs.push(PathBuf::from(d));
        }
    }

    #[cfg(windows)]
    {
        for d in WINDOWS_EXTRA_DIRS {
            dirs.push(PathBuf::from(d));
        }
        // Windows 下用户级 npm 全局目录
        if let Some(home) = dirs::home_dir() {
            dirs.push(home.join("AppData").join("Roaming").join("npm"));
        }
    }

    if let Some(current) = env::var_os("PATH") {
        for seg in env::split_paths(&current) {
            if !seg.as_os_str().is_empty() {
                dirs.push(seg);
            }
        }
    }

    // 去重，保持顺序
    let mut seen: HashSet<PathBuf> = HashSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    dirs
}

/// 构造增强后的 PATH 字符串。
pub fn enhanced_path() -> String {
    env::join_paths(path_dirs())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// 为子进程命令注入增强版 PATH。
///
/// # 约定
/// 本项目中任何 `Command::new(...)` 在 `spawn()` 之前都必须调用本函数。
pub fn prepare_command(command: &mut Command) {
    command.env("PATH", enhanced_path());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enhanced_path_contains_common_dirs() {
        let path = enhanced_path();
        assert!(path.contains("/usr/bin") || cfg!(windows));
        assert!(!path.is_empty());
    }

    #[test]
    fn prepare_command_sets_path() {
        let mut cmd = Command::new("echo");
        prepare_command(&mut cmd);
        let path = cmd
            .get_envs()
            .find(|(k, _)| *k == std::ffi::OsStr::new("PATH"))
            .map(|(_, v)| v.unwrap().to_string_lossy().into_owned())
            .unwrap_or_default();
        assert!(!path.is_empty());
    }

    /// D3 回归：nvm 版本目录必须按数值降序（v22 > v16 > v9），否则会选中最旧 node。
    #[test]
    fn nvm_version_key_sorts_numerically_descending() {
        let keys = [
            std::path::Path::new("/home/u/.nvm/versions/node/v16.20.2/bin"),
            std::path::Path::new("/home/u/.nvm/versions/node/v22.3.0/bin"),
            std::path::Path::new("/home/u/.nvm/versions/node/v9.11.2/bin"),
        ];
        let mut dirs: Vec<&std::path::Path> = keys.to_vec();
        dirs.sort_by(|a, b| version_sort_key(b).cmp(&version_sort_key(a)));
        let names: Vec<String> = dirs
            .iter()
            .map(|d| d.parent().unwrap().file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["v22.3.0", "v16.20.2", "v9.11.2"]);
        // 字典序会把 v9 排在 v22 前，这里必须按数值比较
        assert!(version_sort_key(keys[1]) > version_sort_key(keys[0]));
        assert!(version_sort_key(keys[0]) > version_sort_key(keys[2]));
    }

    #[test]
    fn path_dirs_have_no_duplicates() {
        let dirs = path_dirs();
        let mut seen = HashSet::new();
        for dir in &dirs {
            assert!(seen.insert(dir.clone()), "path_dirs 出现重复目录：{}", dir.display());
        }
        assert!(!dirs.is_empty());
    }

    /// 增强 PATH 必须仍然包含原始 PATH 的每一段，否则会破坏用户已配置的工具链。
    #[test]
    fn enhanced_path_keeps_original_entries() {
        let original = env::var_os("PATH").unwrap_or_default();
        let enhanced = enhanced_path();
        for seg in env::split_paths(&original) {
            if seg.as_os_str().is_empty() {
                continue;
            }
            let needle = seg.to_string_lossy().into_owned();
            assert!(enhanced.contains(&needle), "增强 PATH 丢失了原始段：{needle}");
        }
    }

    /// Node 常见安装目录必须排在原始 PATH 之前（补装完成后优先命中新版本）。
    #[test]
    fn enhanced_path_puts_known_dirs_first() {
        let dirs = path_dirs();
        if cfg!(windows) {
            assert_eq!(dirs.first().map(|d| d.to_path_buf()), Some(PathBuf::from(r"C:\Program Files\nodejs")));
            return;
        }
        let pos_usr_local = dirs.iter().position(|d| d == std::path::Path::new("/usr/local/bin"));
        let pos_usr_bin = dirs.iter().position(|d| d == std::path::Path::new("/usr/bin"));
        assert!(pos_usr_local.is_some(), "缺少 /usr/local/bin");
        assert!(pos_usr_bin.is_some(), "缺少 /usr/bin");
        assert!(pos_usr_local.unwrap() < pos_usr_bin.unwrap(), "/usr/local/bin 应优先于 /usr/bin");
    }
}
