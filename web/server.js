'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const TASKS = [
  { id: 'shipping', name: '创建发货单', directory: 'shipping-auto', description: '修改实际发货数，按仓库分组创建发货单。' },
  { id: 'packing', name: '装箱发货', directory: 'packing-auto', description: '填写箱数、预约取货时间，逐单确认发货。' },
  { id: 'temu', name: 'Temu 商品采集', directory: 'temu-auto', description: '采集贴纸搜索结果前 200 条，自动加载更多，验证时等待用户。' },
];
const MODES = { probe: '快照', dry: '测试演练', auto: '正式执行', manual: '主动快照', collect: '采集商品' };
const MAX_LOG_CHARS = 600000;

function taskCommand(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求参数必须是对象');
  const task = TASKS.find((item) => item.id === input.task);
  if (!task || !Object.hasOwn(MODES, input.mode)) throw new Error('未知脚本或执行模式');
  const options = input.options ?? {};
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('执行参数格式错误');
  if ((task.id === 'temu') !== (input.mode === 'collect')) throw new Error('Temu 仅支持采集模式，发货流程不支持采集模式');
  if (task.id === 'temu') {
    const limit = options.limit ?? 200;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('limit 必须是 1–200 的整数');
    return { task, args: ['index.js', `--limit=${limit}`], cwd: path.join(ROOT, task.directory) };
  }
  const args = ['index.js'];
  if (task.id === 'shipping') args.push('--close-browser');
  if (input.mode === 'probe') args.push('probe');
  if (input.mode === 'dry') args.push('--dry', '--debug');
  const number = (key, fallback, min, max, flag) => {
    const value = options[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} 必须是 ${min}–${max} 的整数`);
    args.push(`--${flag}=${value}`);
  };
  number('maxRounds', input.mode === 'auto' ? 200 : 1, 1, 10000, 'max-rounds');
  number('slowMo', 120, 0, 10000, 'slowmo');
  if (task.id === 'shipping') number('fill', 99999, 1, 99999999, 'fill');
  if (task.id === 'packing') {
    number('boxes', 1, 1, 100000, 'boxes');
    if (options.reuseShippingProfile === true) args.push(`--profile=${path.join(ROOT, 'shipping-auto', '.pw-profile')}`);
  }
  if (input.mode === 'manual') {
    args.splice(0, args.length, path.join(__dirname, 'manual-snapshot.js'), task.id);
    if (task.id === 'packing' && options.reuseShippingProfile === true) args.push('--reuse');
  }
  return { task, args, cwd: path.join(ROOT, task.directory) };
}

function createApp({ spawnProcess = spawn, runDir = path.join(ROOT, '.web-runs'), profileRoot = ROOT, dataRoot = ROOT } = {}) {
  const clients = new Set();
  const instance = randomUUID();
  let revision = 0;
  let current = null;
  let child = null;
  let closing = false;
  let snapshotPending = null;
  let shuttingDown = null;
  const state = () => ({ instance, revision, tasks: TASKS, modes: MODES, run: current });
  function send(response, event, data) {
    // Slow clients reconnect and receive the bounded current state instead of accumulating output.
    if (!response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) response.destroy();
  }
  function broadcast(event, data) {
    for (const response of clients) send(response, event, data);
  }
  function append(stream, value) {
    if (!current) return;
    const entry = { stream, text: value, at: new Date().toISOString() };
    current.logs.push(entry);
    current.logChars += value.length;
    while (current.logChars > MAX_LOG_CHARS && current.logs.length > 1) {
      current.logChars -= current.logs.shift().text.length;
      current.truncated = true;
    }
    try { fs.appendFileSync(current.logPath, value); } catch (error) {
      current.logError = `日志文件写入失败：${error.message}`;
    }
    broadcast('log', { id: current.id, entry });
  }
  function json(response, code, value) {
    response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  }
  async function screenshots() {
    const groups = await Promise.all(TASKS.map(async (task) => {
      const directory = path.join(ROOT, task.directory, 'shots');
      let files;
      try { files = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { return []; }
      return Promise.all(files.filter((file) => file.isFile() && /\.png$/i.test(file.name)).map(async (file) => {
        try {
          const info = await fs.promises.stat(path.join(directory, file.name));
          return { task: task.id, name: file.name, modified: info.mtime.toISOString(), domUrl: file.name.startsWith('manual-') ? `/api/dom/${task.id}/${encodeURIComponent(file.name.replace(/\.png$/i, '.json'))}` : null, url: `/api/shots/${task.id}/${encodeURIComponent(file.name)}` };
        } catch { return null; }
      }));
    }));
    return groups.flat().filter(Boolean).sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, 60);
  }
  function serveFile(response, file, type) {
    fs.open(file, 'r', (error, fd) => {
      if (error) return json(response, 404, { error: '文件不存在' });
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      const stream = fs.createReadStream(file, { fd });
      stream.on('error', () => response.destroy());
      stream.pipe(response);
    });
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const host = request.headers.host;
      // This console can execute local scripts; accept only same-origin loopback requests.
      const allowedHosts = new Set([`127.0.0.1:${server.address()?.port}`, `localhost:${server.address()?.port}`]);
      if (!allowedHosts.has(host)) return json(response, 403, { error: '仅允许本机访问' });
      if (request.headers.origin && request.headers.origin !== `http://${host}`) return json(response, 403, { error: '不允许跨站请求' });
      const url = new URL(request.url, `http://${host}`);
      if (request.method === 'GET' && url.pathname === '/api/state') return json(response, 200, state());
      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.write('retry: 1500\n\n');
        clients.add(response);
        send(response, 'state', state());
        const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000);
        response.on('close', () => { clearInterval(heartbeat); clients.delete(response); });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/shots') return json(response, 200, { shots: await screenshots() });
      if (request.method === 'GET' && url.pathname.startsWith('/api/data/temu/')) {
        const parts = url.pathname.split('/');
        const filename = decodeURIComponent(parts[4] || '');
        if (parts.length !== 5 || !/^temu-[\d]+-[a-f\d-]+\.(json|csv)$/.test(filename)) return json(response, 404, { error: '结果不存在' });
        const directory = path.join(dataRoot, 'temu-auto', 'data');
        const real = await fs.promises.realpath(path.join(directory, filename)).catch(() => '');
        if (!real || path.dirname(real) !== await fs.promises.realpath(directory)) return json(response, 404, { error: '结果不存在' });
        response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return serveFile(response, real, filename.endsWith('.csv') ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8');
      }
      if (request.method === 'GET' && (url.pathname.startsWith('/api/shots/') || url.pathname.startsWith('/api/dom/'))) {
        const parts = url.pathname.split('/');
        const task = TASKS.find((item) => item.id === parts[3]);
        const filename = decodeURIComponent(parts[4] || '');
        const isDom = parts[2] === 'dom';
        if (!task || parts.length !== 5 || path.basename(filename) !== filename || filename.includes('\\') || !(isDom ? /^manual-[\w.-]+\.json$/i : /^[\w.-]+\.png$/i).test(filename)) return json(response, 404, { error: '快照不存在' });
        const directory = path.join(ROOT, task.directory, 'shots');
        const file = path.join(directory, filename);
        const real = await fs.promises.realpath(file).catch(() => '');
        if (!real || path.dirname(real) !== await fs.promises.realpath(directory)) return json(response, 404, { error: '快照不存在' });
        if (isDom) response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return serveFile(response, file, isDom ? 'application/json; charset=utf-8' : 'image/png');
      }
      if (request.method === 'GET' && url.pathname === '/api/log') {
        if (!current) return json(response, 404, { error: '还没有执行记录' });
        response.setHeader('Content-Disposition', `attachment; filename="${current.id}.log"`);
        return serveFile(response, current.logPath, 'text/plain; charset=utf-8');
      }
      if (request.method === 'POST' && url.pathname === '/api/clear-profile') {
        if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, { error: '请使用 JSON 请求' });
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 8192) return json(response, 413, { error: '请求过大' });
        }
        let profile;
        try { profile = JSON.parse(body).profile; } catch { return json(response, 400, { error: '请求格式错误' }); }
        const task = TASKS.find((item) => item.id === profile);
        if (!task) return json(response, 400, { error: '未知登录配置' });
        if (closing || current?.status === 'running') return json(response, 409, { error: '任务运行中，无法清除登录信息' });
        const directory = path.join(profileRoot, task.directory, '.pw-profile');
        fs.rmSync(directory, { recursive: true, force: true });
        return json(response, 200, { message: `${task.name}的登录信息已清除，下次执行时需要重新登录` });
      }
      if (request.method === 'POST' && url.pathname === '/api/snapshot') {
        if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, { error: '请使用 JSON 请求' });
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 8192) return json(response, 413, { error: '请求过大' });
        }
        let id;
        try { id = JSON.parse(body).id; } catch { return json(response, 400, { error: '请求格式错误' }); }
        if (closing || !child?.connected || current?.id !== id || current.status !== 'running' || current.mode !== 'manual' || !current.snapshotReady || current.stopRequested) return json(response, 409, { error: '主动快照会话尚未就绪或已结束' });
        if (snapshotPending) return json(response, 409, { error: '正在抓取，请稍候' });
        const captureId = randomUUID();
        const result = await new Promise((resolve) => {
          const timer = setTimeout(() => done({ error: '抓取超时，请重试' }), 60000);
          const done = (value) => { clearTimeout(timer); snapshotPending = null; resolve(value); };
          snapshotPending = { id: captureId, done };
          child.send({ type: 'snapshot', id: captureId }, (error) => { if (error && snapshotPending?.id === captureId) done({ error: error.message }); });
        });
        return json(response, result.error ? 500 : 200, result);
      }
      if (request.method === 'POST' && url.pathname === '/api/stop') {
        if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, { error: '请使用 JSON 请求' });
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 8192) return json(response, 413, { error: '请求过大' });
        }
        let id;
        try { id = JSON.parse(body).id; } catch { return json(response, 400, { error: '请求格式错误' }); }
        if (!current || current.id !== id || current.status !== 'running' || !child) return json(response, 409, { error: '任务已结束或已切换，请刷新状态' });
        if (current.stopRequested) return json(response, 202, { status: 'stopping' });
        if (!child.kill('SIGTERM')) return json(response, 409, { error: '进程已退出，正在等待清理' });
        current.stopRequested = true;
        append('system', '\n已请求停止，正在等待脚本和浏览器退出…\n');
        revision++;
        broadcast('state', state());
        return json(response, 202, { status: 'stopping' });
      }
      if (request.method === 'POST' && url.pathname === '/api/resume') {
        if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, { error: '请使用 JSON 请求' });
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 8192) return json(response, 413, { error: '请求过大' });
        }
        let id;
        try { id = JSON.parse(body).id; } catch { return json(response, 400, { error: '请求格式错误' }); }
        if (closing || !child?.connected || current?.id !== id || current.status !== 'running' || current.task !== 'temu' || !current.waitingForUser || current.stopRequested) return json(response, 409, { error: '当前没有等待处理的采集任务' });
        child.send({ type: 'resume' }, (error) => { if (error) append('stderr', `继续采集失败：${error.message}\n`); });
        return json(response, 202, { status: 'resuming' });
      }
      if (request.method === 'POST' && url.pathname === '/api/run') {
        if (closing) return json(response, 503, { error: '服务正在关闭' });
        if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, { error: '请使用 JSON 请求' });
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 8192) return json(response, 413, { error: '请求过大' });
        }
        let command;
        try { command = taskCommand(JSON.parse(body)); } catch (error) { return json(response, 400, { error: error.message }); }
        if (closing) return json(response, 503, { error: '服务正在关闭' });
        if (current?.status === 'running') return json(response, 409, { error: '已有任务执行中，请等待结束' });
        fs.mkdirSync(runDir, { recursive: true });
        const id = `${Date.now()}-${randomUUID()}`;
        const logPath = path.join(runDir, `${id}.log`);
        fs.writeFileSync(logPath, '');
        current = { id, task: command.task.id, taskName: command.task.name, mode: JSON.parse(body).mode, status: 'running', startedAt: new Date().toISOString(), endedAt: null, exitCode: null, logs: [], logChars: 0, logPath, command: `node ${command.args.join(' ')}` };
        revision++;
        broadcast('state', state());
        append('system', `开始执行：${command.task.name} · ${MODES[current.mode]}\n$ ${current.command}\n\n`);
        let finished = false;
        const finish = (code, signal) => {
          if (finished) return;
          finished = true;
          snapshotPending?.done({ error: '快照会话已结束' });
          append('system', `\n进程已结束，退出码：${code ?? '无'}${signal ? `，信号：${signal}` : ''}\n`);
          current.status = current.stopRequested ? 'stopped' : code === 0 ? 'succeeded' : 'failed';
          current.exitCode = code;
          current.endedAt = new Date().toISOString();
          current.waitingForUser = false;
          child = null;
          revision++;
          broadcast('state', state());
        };
        try {
          // Never run a shell or accept a user-supplied executable/argument string.
          child = spawnProcess(process.execPath, command.args, {
            cwd: command.cwd,
            env: { ...process.env, DRY: current.mode === 'dry' ? '1' : '0', DEBUG: current.mode === 'dry' ? '1' : '0', CDP: '', PROFILE: '', FORCE_COLOR: '0', NO_COLOR: '1' },
            stdio: current.mode === 'manual' || current.task === 'temu' ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'], shell: false,
          });
          child.on('message', (message) => {
            if (!message || typeof message !== 'object') return;
            if (message.type === 'snapshot-ready') { current.snapshotReady = true; revision++; broadcast('state', state()); }
            if (message.type === 'snapshot-result' && snapshotPending?.id === message.id) snapshotPending.done(message);
            if (current.task === 'temu' && message.type === 'user-action') {
              current.waitingForUser = message.waiting === true;
              current.waitReason = typeof message.reason === 'string' ? message.reason : '';
              revision++; broadcast('state', state());
            }
            if (current.task === 'temu' && message.type === 'collection-progress') {
              current.collection = { count: message.count, target: message.target, status: message.status, missing: message.missing };
              current.resultFiles = (Array.isArray(message.files) ? message.files : []).filter((name) => typeof name === 'string' && /^temu-[\d]+-[a-f\d-]+\.(json|csv)$/.test(name));
              revision++; broadcast('state', state());
            }
          });
          for (const stream of ['stdout', 'stderr']) {
            child[stream].setEncoding('utf8');
            child[stream].on('data', (value) => append(stream, value));
          }
          child.on('error', (error) => append('stderr', `启动失败：${error.message}\n`));
          // close fires after both output streams drain, unlike exit.
          child.on('close', finish);
        } catch (error) {
          append('stderr', `启动失败：${error.message}\n`);
          finish(1);
        }
        return json(response, 202, { id, status: current.status });
      }
      const staticFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
      if (request.method === 'GET' && Object.hasOwn(staticFiles, url.pathname)) {
        const [file, type] = staticFiles[url.pathname];
        return serveFile(response, path.join(__dirname, 'public', file), type);
      }
      json(response, 404, { error: '接口不存在' });
    } catch (error) {
      if (!response.headersSent) json(response, 500, { error: error.message });
      else response.destroy();
    }
  });
  function shutdown() {
    if (shuttingDown) return shuttingDown;
    closing = true;
    for (const response of clients) response.end();
    const stopped = child ? new Promise((resolve) => {
      child.once('close', resolve);
      child.kill('SIGTERM');
    }) : Promise.resolve();
    const closed = new Promise((resolve) => {
      server.close(resolve);
      server.closeIdleConnections?.();
    });
    shuttingDown = Promise.all([stopped, closed]);
    return shuttingDown;
  }
  return { server, shutdown };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 的端口号');
  const app = createApp();
  app.server.on('error', (error) => { console.error(`控制台启动失败：${error.message}`); process.exitCode = 1; });
  app.server.listen(port, '127.0.0.1', () => console.log(`\n自动化控制台：http://127.0.0.1:${port}\n按 Ctrl+C 关闭服务。\n`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.shutdown());
}

module.exports = { createApp, taskCommand };
