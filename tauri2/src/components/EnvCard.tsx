import type { ToolStatus } from '../types';

/**
 * 运行环境卡片：只展示 Node.js / npm 两行。
 *
 * 零配置产品没有其他环境项——缺 Node 时这里只有「安装 Node.js」一个按钮，
 * 安装成功后 Rust 侧会自动续跑初始化流水线。
 */
export function EnvCard({
  statuses,
  busy,
  onInstall,
}: {
  statuses: ToolStatus[];
  busy: string | null;
  onInstall: () => void;
}) {
  const missing = statuses.some((s) => !s.ok);
  return (
    <section className="card">
      <h2>运行环境</h2>
      {statuses.length === 0 ? (
        <p className="muted">检测中…</p>
      ) : (
        <ul className="env-list">
          {statuses.map((s) => (
            <li key={s.name}>
              <span className={s.ok ? 'ok' : 'bad'}>{s.ok ? '✅' : '❌'}</span>
              <strong>{s.name}</strong>
              {s.version && <code>{s.version}</code>}
              {s.detail && <span className="muted">{s.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      {missing && (
        <div className="env-actions">
          <button className="primary" onClick={onInstall} disabled={busy !== null}>
            安装 Node.js
          </button>
          <span className="muted">
            需要 Node.js 18 及以上；安装完成后会自动继续初始化，无需再点其它按钮。
          </span>
        </div>
      )}
    </section>
  );
}
