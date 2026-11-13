/** 与 Rust 侧结构体一一对应的类型定义（serde camelCase 序列化）。 */

/**
 * 启动流水线阶段（Rust bootstrap::Stage）。
 *
 * 用户流程是「打开应用 → 自动准备好 → 去操作网页」，所以界面只需要展示当前阶段，
 * 没有任何可配置项。
 */
export type Stage =
  | 'checkingEnv'
  | 'installingNode'
  | 'fetchingCode'
  | 'installingDeps'
  | 'starting'
  | 'ready'
  | 'stopped'
  | 'error';

/** Rust bootstrap::BootstrapSnapshot（bootstrap-status 事件载荷）。 */
export interface BootstrapSnapshot {
  stage: Stage;
  /** 人类可读的中文进度说明 */
  detail: string;
  /** 阶段内进度百分比（0–100），null 表示不确定进度 */
  progress: number | null;
  /** 服务端口（就绪后有值） */
  port: number | null;
  /** 失败原因（仅 stage === 'error' 时有值） */
  error: string | null;
}

/** 服务进程状态机（Rust service::Phase）。 */
export type ServicePhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopped'
  | 'crashed'
  | 'error';

/** Rust service::StatusSnapshot（service-status 事件载荷）。 */
export interface StatusSnapshot {
  phase: ServicePhase;
  port: number | null;
  detail: string | null;
}

/** Rust env_check::ToolStatus。 */
export interface ToolStatus {
  name: string;
  ok: boolean;
  version: string | null;
  detail: string | null;
}

/** Rust updater::UpdateInfo。 */
export interface UpdateInfo {
  hasUpdate: boolean;
  localVersion: string;
  remoteVersion: string | null;
  message: string | null;
}
