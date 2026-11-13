import { useEffect, useRef, useState } from 'react';

/** 日志面板：等宽字体、自动滚动、可暂停。 */
export function LogPanel({ lines }: { lines: string[] }) {
  const [paused, setPaused] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!paused && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [lines, paused]);

  return (
    <section className="card log-card">
      <div className="log-header">
        <h2>日志</h2>
        <div className="log-actions">
          <button onClick={() => setPaused((p) => !p)}>
            {paused ? '恢复滚动' : '暂停滚动'}
          </button>
        </div>
      </div>
      <div className="log-box" ref={boxRef}>
        {lines.length === 0 && <div className="muted">暂无日志</div>}
        {lines.map((line, i) => (
          <div key={i} className="log-line">
            {line}
          </div>
        ))}
      </div>
    </section>
  );
}
