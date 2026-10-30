'use strict';

const $ = (selector) => document.querySelector(selector);
const logs = $('#logs');
const emptyLog = logs.firstElementChild.cloneNode(true);
let connected = false;
let pending = false;
let capturing = false;
let run = null;
let runId = null;
let shots = [];
let refreshPending = false;
let instance = null;
let revision = -1;

function controls() {
  const busy = !connected || pending || run?.status === 'running';
  document.body.classList.toggle('busy', busy);
  document.querySelectorAll('button, input').forEach((item) => { item.disabled = busy; });
  $('#download').disabled = busy || !run;
  $('#stop').disabled = !connected || pending || run?.status !== 'running' || Boolean(run?.stopRequested);
  $('#capture').disabled = !connected || capturing || pending || run?.status !== 'running' || run?.mode !== 'manual' || !run?.snapshotReady || Boolean(run?.stopRequested);
  $('#capture').textContent = capturing ? '正在抓取…' : '▣ 抓取当前页面';
  $('#stop').textContent = run?.stopRequested ? '正在停止…' : run?.mode === 'manual' ? '结束快照' : '■ 停止执行';
  document.querySelectorAll('.shot, .brand').forEach((link) => {
    link.setAttribute('aria-disabled', String(busy));
    link.tabIndex = busy ? -1 : 0;
  });
  document.querySelectorAll('.task-card').forEach((card) => card.classList.toggle('active', run?.status === 'running' && card.dataset.task === run.task));
  const notice = $('#notice');
  notice.classList.toggle('running', Boolean(run?.status === 'running'));
  notice.textContent = !connected ? '服务连接已断开，正在自动重连；同步状态后才能继续操作。' : pending ? '正在启动脚本，请稍候…' : run?.status === 'running' ? `正在${run.stopRequested ? '停止' : '执行'}「${run.taskName} · ${modeLabel(run.mode)}」，其他操作已锁定。` : '准备就绪 · 建议先查看快照，再测试演练，最后正式执行。';
  $('#connection-dot').classList.toggle('offline', !connected);
  $('#connection-text').textContent = connected ? '服务已连接' : '正在连接服务';
}
function modeLabel(mode) { return { probe: '快照', dry: '测试演练', auto: '正式执行', manual: '主动快照' }[mode] || mode; }
function clock(value) { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
function updateTime() {
  if (!run) return;
  const duration = Math.max(0, Math.floor((new Date(run.endedAt || Date.now()) - new Date(run.startedAt)) / 1000));
  $('#run-time').textContent = `${clock(run.startedAt)} · ${run.status === 'running' ? '运行中' : '用时'} ${Math.floor(duration / 60)}分${duration % 60}秒`;
}
function append(entry) {
  if (logs.querySelector('.log-placeholder')) logs.replaceChildren();
  const element = document.createElement('span');
  element.className = `log-entry ${entry.stream}`;
  element.textContent = entry.text;
  logs.append(element);
  while (logs.childElementCount > 1200) logs.firstElementChild.remove();
  if ($('#follow').checked) logs.scrollTop = logs.scrollHeight;
}
function applyState(data) {
  if (data.instance === instance && data.revision < revision) return;
  instance = data.instance;
  revision = data.revision;
  const previous = run;
  run = data.run;
  connected = true;
  pending = false;
  if (run) {
    // Rebuild from the server's bounded buffer on every reconnect; no missing or duplicated chunks.
    logs.replaceChildren();
    if (run.truncated) append({ stream: 'system', text: '较早的输出已折叠，下载日志可查看完整记录。\n' });
    for (const entry of run.logs) append(entry);
    if (run.logError) $('#error').textContent = run.logError;
    if (run.logError) $('#error').hidden = false;
    runId = run.id;
    $('#run-title').textContent = `${run.taskName} / ${modeLabel(run.mode)}`;
    $('#run-status').textContent = { running: 'RUNNING', succeeded: 'EXIT 0', stopped: 'STOPPED', failed: `FAILED · ${run.exitCode ?? 'ERROR'}` }[run.status];
    $('#log-count').textContent = run.status === 'running' ? 'stdout / stderr · 实时同步' : '进程结束 · 请核对业务日志';
    updateTime();
  } else {
    runId = null;
    logs.replaceChildren(emptyLog.cloneNode(true));
    $('#run-title').textContent = '等待执行';
    $('#run-status').textContent = 'IDLE';
    $('#run-time').textContent = '尚未执行任务';
    $('#log-count').textContent = 'stdout / stderr · 实时同步';
  }
  controls();
  if (!previous || previous.id !== run?.id || previous.status !== run?.status) refreshShots();
}
async function refreshShots() {
  if (refreshPending) return;
  refreshPending = true;
  try {
    const response = await fetch('/api/shots');
    if (!response.ok) throw new Error('快照加载失败');
    shots = (await response.json()).shots;
    $('#shots').replaceChildren();
    for (const shot of shots.slice(0, 8)) {
      const link = document.createElement('a');
      link.className = 'shot'; link.href = shot.url; link.target = '_blank'; link.rel = 'noopener';
      const img = document.createElement('img'); img.src = shot.url; img.alt = shot.name; img.loading = 'lazy';
      const info = document.createElement('div'); info.className = 'shot-info';
      const title = document.createElement('span'); title.className = 'shot-title'; title.textContent = shot.name; title.title = shot.name;
      const time = document.createElement('span'); time.className = 'shot-time'; time.textContent = `${shot.task === 'shipping' ? '创建发货单' : '装箱发货'} · ${clock(shot.modified)}`;
      info.append(title, time); link.append(img, info); $('#shots').append(link);
      if (shot.domUrl) {
        const dom = document.createElement('a');
        dom.className = 'shot'; dom.href = shot.domUrl; dom.textContent = `↓ 下载 DOM · ${shot.name}`;
        $('#shots').append(dom);
      }
    }
    $('#shot-count').textContent = `最近 ${Math.min(shots.length, 8)} 张`;
    $('#shots-empty').hidden = shots.length > 0;
    controls();
  } catch (error) { $('#shot-count').textContent = error.message; }
  finally { refreshPending = false; }
}
document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', async () => {
  if (!connected || pending || run?.status === 'running') return;
  const card = button.closest('[data-task]');
  const options = {};
  for (const input of card.querySelectorAll('input')) {
    if (!input.reportValidity()) return;
    options[input.name] = input.type === 'checkbox' ? input.checked : Number(input.value);
  }
  // Tests exercise one round, regardless of the limit intended for production.
  if (button.dataset.mode !== 'auto') options.maxRounds = 1;
  pending = true;
  $('#error').hidden = true;
  controls();
  try {
    const response = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: card.dataset.task, mode: button.dataset.mode, options }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '启动失败');
    // SSE is the sole state authority; its ordered events also restore state on reconnect.
  } catch (error) {
    $('#error').textContent = error.message; $('#error').hidden = false;
    pending = false;
    // A failed fetch may still have started the process: reconnect before enabling controls.
    connected = false; events.close(); connect();
  }
  controls();
}));
$('#capture').addEventListener('click', async () => {
  if ($('#capture').disabled) return;
  capturing = true; controls();
  try {
    const response = await fetch('/api/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: run.id }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '抓取失败');
    $('#error').hidden = true;
    await refreshShots();
  } catch (error) { $('#error').textContent = error.message; $('#error').hidden = false; }
  finally { capturing = false; controls(); }
});
document.querySelectorAll('[data-clear]').forEach((button) => button.addEventListener('click', async () => {
  if (!connected || pending || run?.status === 'running') return;
  const reuse = button.dataset.clear === 'packing' && button.closest('[data-task]').querySelector('[name=reuseShippingProfile]').checked;
  const profile = reuse ? 'shipping' : button.dataset.clear;
  const name = profile === 'shipping' ? '创建发货单（共享）' : '装箱发货（独立）';
  if (!window.confirm(`确定清除${name}的浏览器登录信息吗？下次运行需要重新登录。请先关闭使用该配置的 Chrome 窗口。`)) return;
  pending = true; controls();
  try {
    const response = await fetch('/api/clear-profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '清除失败');
    $('#error').hidden = true;
    window.alert(result.message);
  } catch (error) {
    $('#error').textContent = error.message; $('#error').hidden = false;
  } finally { pending = false; controls(); }
}));
$('#stop').addEventListener('click', async () => {
  if (!connected || pending || run?.status !== 'running' || run.stopRequested) return;
  const id = run.id;
  pending = true; controls();
  try {
    const response = await fetch('/api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '停止失败');
    pending = false; controls();
  } catch (error) {
    $('#error').textContent = error.message; $('#error').hidden = false;
    pending = false; connected = false; events.close(); connect(); controls();
  }
});
$('#download').addEventListener('click', () => { window.location.href = '/api/log'; });
document.addEventListener('click', (event) => {
  if (document.body.classList.contains('busy') && event.target.closest('a')) event.preventDefault();
});
let events;
function connect() {
  events = new EventSource('/api/events');
  events.addEventListener('state', (event) => applyState(JSON.parse(event.data)));
  events.addEventListener('log', (event) => {
    const data = JSON.parse(event.data);
    if (data.id === runId) append(data.entry);
  });
  events.onerror = () => { connected = false; controls(); };
}
controls();
connect();
refreshShots();
setInterval(updateTime, 1000);
setInterval(() => { if (connected && run?.status === 'running') refreshShots(); }, 5000);
