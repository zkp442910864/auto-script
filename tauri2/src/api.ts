import { invoke } from '@tauri-apps/api/core';
import type { BootstrapSnapshot, ToolStatus, UpdateInfo } from './types';

/**
 * 后端命令封装：命令名必须与 Rust `#[tauri::command]` 注册名一一对应。
 *
 * 零配置产品没有设置读写命令——仓库地址、分支、端口、业务目录都由 Rust 侧常量决定。
 */
export const api = {
  /** 环境自检（node >= 18 / npm 可用）。 */
  checkEnvironment: () => invoke<ToolStatus[]>('check_environment'),
  /** 自动补装 Node.js；成功后 Rust 侧会自动续跑初始化流水线。 */
  installNode: () => invoke<ToolStatus[]>('install_node'),
  /** 读取当前流水线快照（挂载时同步，避免错过启动早期事件）。 */
  bootstrapStatus: () => invoke<BootstrapSnapshot>('bootstrap_status'),
  /** 从失败阶段继续初始化（不是从头重来）。 */
  retryPipeline: () => invoke<BootstrapSnapshot>('retry_pipeline'),
  /** 重启业务服务。 */
  restartService: () => invoke<BootstrapSnapshot>('restart_service'),
  /** 在系统文件管理器中打开业务目录（排查用）。 */
  openBusinessDir: () => invoke<void>('open_business_dir'),
  /** 拉取日志环形缓冲快照（最近 1000 条）。 */
  getLogs: () => invoke<string[]>('get_logs'),
  /** 检查更新（比对本地与远端 package.json 版本）。 */
  checkUpdate: () => invoke<UpdateInfo>('check_update'),
  /** 执行更新（下载 zip → 过滤 → 覆盖 → 视情况装依赖 → 重启服务）。 */
  performUpdate: () => invoke<void>('perform_update'),
};
