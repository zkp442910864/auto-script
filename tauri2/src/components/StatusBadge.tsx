import type { Stage } from '../types';

const LABELS: Record<Stage, string> = {
  checkingEnv: '检查环境…',
  installingNode: '安装 Node.js…',
  fetchingCode: '准备业务代码…',
  installingDeps: '安装依赖…',
  starting: '启动服务中…',
  ready: '运行中',
  stopped: '服务已停止',
  error: '初始化失败',
};

/** 顶部状态徽章：运行中时附带可访问地址。 */
export function StatusBadge({ stage, port }: { stage: Stage; port: number | null }) {
  const label =
    stage === 'ready' && port ? `运行中 http://127.0.0.1:${port}` : LABELS[stage];
  return <span className={`badge badge-${stage}`}>{label}</span>;
}
