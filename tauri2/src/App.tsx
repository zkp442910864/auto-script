import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { api } from './api';
import type {
  BootstrapSnapshot,
  Stage,
  StatusSnapshot,
  ToolStatus,
  UpdateInfo,
} from './types';
import { StatusBadge } from './components/StatusBadge';
import { EnvCard } from './components/EnvCard';
import { LogPanel } from './components/LogPanel';

/** 前端日志行数上限（与 Rust 环形缓冲一致）。 */
const MAX_LOG_LINES = 1000;

/** 各阶段给用户的操作提示（进度说明之外的一句话指引）。 */
const STAGE_HINTS: Record<Stage, string> = {
  checkingEnv: '正在检查 Node.js 与 npm，通常只需要几秒。',
  installingNode: '正在自动安装 Node.js，如弹出密码框请输入开机密码。',
  fetchingCode: '首次启动需要下载业务代码，请保持网络畅通。',
  installingDeps: '首次启动需要安装业务依赖，耗时取决于网速。',
  starting: '正在启动本地服务并做健康检查。',
  ready: '一切就绪，点击「在浏览器中打开」开始操作。',
  stopped: '服务已停止，可点击「重启服务」重新启动。',
  error: '初始化中断，点击「重试」会从失败的阶段继续，不会从头再来。',
};

export default function App() {
  const [boot, setBoot] = useState<BootstrapSnapshot | null>(null);
  const [svc, setSvc] = useState<StatusSnapshot | null>(null);
  const [env, setEnv] = useState<ToolStatus[]>([]);
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

  const stage: Stage = boot?.stage ?? 'checkingEnv';
  const port = boot?.port ?? svc?.port ?? null;
  /** 崩溃细节来自 service-status；流水线自己的失败原因在 boot.error。 */
  const crashDetail =
    svc && (svc.phase === 'crashed' || svc.phase === 'error') ? svc.detail : null;
  const errorText = error ?? boot?.error ?? crashDetail ?? null;

  /** 追加一行日志（超出上限时裁剪）。 */
  const pushLine = useCallback((line: string) => {
    setLines((prev) => {
      const next = [...prev, line];
      return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
    });
  }, []);

  /** 统一的忙碌保护 + 错误捕获。 */
  const guard = useCallback(
    async (key: string, fn: () => Promise<void>) => {
      if (busy) return;
      setBusy(key);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(typeof e === 'string' ? e : String(e));
      } finally {
        setBusy(null);
      }
    },
    [busy],
  );

  // 订阅 Rust 侧事件：4 个日志流 + 流水线快照 + 服务进程快照
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    void (async () => {
      for (const event of ['bootstrap-log', 'service-log', 'env-log', 'update-log']) {
        unlisteners.push(await listen<string>(event, (e) => pushLine(e.payload)));
      }
      unlisteners.push(
        await listen<BootstrapSnapshot>('bootstrap-status', (e) => setBoot(e.payload)),
      );
      unlisteners.push(
        await listen<StatusSnapshot>('service-status', (e) => setSvc(e.payload)),
      );
    })();
    return () => {
      unlisteners.forEach((fn) => fn());
    };
  }, [pushLine]);

  // 初始化：同步当前阶段（启动早期事件可能已发完）、历史日志、环境清单
  useEffect(() => {
    void (async () => {
      try {
        setBoot(await api.bootstrapStatus());
      } catch {
        /* 同步失败时依赖后续事件 */
      }
      setLines(await api.getLogs().catch(() => [] as string[]));
      try {
        setEnv(await api.checkEnvironment());
      } catch {
        /* 环境检测失败时由流水线错误条提示 */
      }
    })();
  }, []);

  const handleInstallNode = () =>
    void guard('installNode', async () => {
      setEnv(await api.installNode());
    });

  const handleRetry = () =>
    void guard('retry', async () => {
      setBoot(await api.retryPipeline());
    });

  const handleRestart = () =>
    void guard('restart', async () => {
      setBoot(await api.restartService());
    });

  const handleCheckUpdate = () =>
    void guard('checkUpdate', async () => {
      setUpdateInfo(await api.checkUpdate());
    });

  const handlePerformUpdate = () =>
    void guard('update', async () => {
      setUpdateInfo(null);
      await api.performUpdate();
    });

  const handleOpenBusinessDir = () =>
    void guard('openDir', async () => {
      await api.openBusinessDir();
    });

  const handleOpenBrowser = () => {
    if (!port) return;
    void openUrl(`http://127.0.0.1:${port}`).catch((e) =>
      setError(typeof e === 'string' ? e : String(e)),
    );
  };

  const canOpenBrowser = stage === 'ready' && port !== null;
  const showProgress = boot !== null && boot.progress !== null;
  const showProgressBar = showProgress && stage !== 'ready' && stage !== 'stopped';

  return (
    <div className="app">
      <header className="topbar">
        <h1>发货控制台</h1>
        <StatusBadge stage={stage} port={port} />
        <div className="spacer" />
        <button
          className="link"
          onClick={handleOpenBusinessDir}
          disabled={busy !== null}
          title="在文件管理器中打开业务代码目录（排查用）"
        >
          打开业务目录
        </button>
      </header>

      {errorText && (
        <div className="banner error-banner">
          <span className="banner-text">{errorText}</span>
          {stage === 'error' && (
            <button className="primary" onClick={handleRetry} disabled={busy !== null}>
              重试
            </button>
          )}
          <button className="ghost" onClick={() => setError(null)}>
            关闭
          </button>
        </div>
      )}

      <section className="card progress-card">
        <h2>启动进度</h2>
        <p className="progress-detail">{boot?.detail ?? '正在启动…'}</p>
        {showProgressBar && boot && (
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${boot.progress ?? 0}%` }} />
          </div>
        )}
        <p className="muted">{STAGE_HINTS[stage]}</p>
      </section>

      {updateInfo && (
        <div className="banner update-banner">
          <span className="banner-text">
            {updateInfo.message
              ? updateInfo.message
              : updateInfo.hasUpdate
                ? `发现新版本：${updateInfo.localVersion} → ${updateInfo.remoteVersion}`
                : `已是最新版本（${updateInfo.localVersion}）`}
          </span>
          {updateInfo.hasUpdate && (
            <button onClick={handlePerformUpdate} disabled={busy !== null}>
              执行更新
            </button>
          )}
          <button className="ghost" onClick={() => setUpdateInfo(null)}>
            关闭
          </button>
        </div>
      )}

      <div className="actions">
        <button
          className="primary"
          onClick={handleOpenBrowser}
          disabled={!canOpenBrowser}
          title={canOpenBrowser ? `http://127.0.0.1:${port}` : '服务未运行'}
        >
          在浏览器中打开
        </button>
        <button onClick={handleCheckUpdate} disabled={busy !== null}>
          检查更新
        </button>
        <button onClick={handleRestart} disabled={busy !== null || stage === 'fetchingCode'}>
          重启服务
        </button>
      </div>

      <EnvCard statuses={env} busy={busy} onInstall={handleInstallNode} />

      <LogPanel lines={lines} />
    </div>
  );
}
