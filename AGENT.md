# 项目说明

这是本机发货自动化项目。`shipping-auto/index.js` 操作跨境卖货的发货台，修改实际发货数并按仓库创建发货单；`packing-auto/index.js` 操作发货单列表，填写箱数、预约取货并确认发货。详细页面选择器、模式行为和已知限制见各目录 `docs.md`。

## Web 控制台

- 根目录 `npm start` 启动 `web/server.js`，默认地址 `http://127.0.0.1:3000`；`PORT` 可改端口。Web 只用 Node 内置模块，不需要打包。
- `npm run setup` 安装两套自动化脚本的依赖，需要本机 Google Chrome。`npm test` 运行控制台集成测试；`npm run dev` 监视服务文件变化，开发时请勿在业务任务运行中重启。
- 前端在 `web/public/`，使用原生 HTML、CSS、JavaScript。界面为中文，保持桌面和移动端可用。
- `POST /api/run` 接收 `{task: 'shipping'|'packing', mode: 'probe'|'dry'|'auto', options: {...}}`。参数仅允许数值型 `maxRounds`、`slowMo`、`fill` / `boxes`，装箱支持布尔值 `reuseShippingProfile`。不得提供任意命令、脚本路径或 shell 执行入口。
- `GET /api/events` 为 SSE，`state` 事件同步当前任务和日志缓冲，`log` 事件推送 stdout / stderr；带心跳和自动重连。`GET /api/state` 提供同一状态。`instance` / `revision` 用于避免旧响应覆盖新状态。
- `GET /api/shots` 枚举允许目录的 PNG，`GET /api/shots/:task/:file` 返回原图；不向浏览器提供可执行的 `probe.html`。`GET /api/log` 下载最新任务完整日志。

## 必须保持的行为

1. 全局最多一个任务运行。先原子占用后端锁，再启动子进程；并发请求返回 409。页面任务执行中仅允许手动停止，禁用其他按钮、输入和导航链接，断线及启动等待期间也禁用。
2. 必须等子进程 `close`（输出流结束）后释放锁，而不是读到“结束”日志就解锁。失败启动、非零退出码和信号终止也必须恢复状态。
3. 只能使用 `process.execPath` 与参数数组、固定任务目录启动脚本，`shell: false`。验证参数范围；保持仅本机访问和同源写入限制。
4. 前端用 `textContent` 展示外部日志、文件名和错误，避免当作 HTML 执行。内存日志有上限，完整输出追加到 `.web-runs/*.log`。
5. 快照映射到 `probe`；测试映射到 `--dry --debug` 且 UI 固定 1 轮；正式执行才允许真实业务提交。注意装箱 probe 会打开抽屉、勾选行，不是完全无交互。
6. Web 发货任务带 `--close-browser`，确保执行结束释放浏览器和登录目录；保留原始 CLI 默认留窗行为。装箱默认关闭窗口。服务关闭时向当前子进程发送 SIGTERM。
7. 退出码 0 不等同于业务处理成功。原有脚本遇到保护性中止可能正常退出，页面要提示查看业务日志。

## 修改与验证

优先复用现有脚本，不把业务页面自动化逻辑复制到 Web。修改调度、日志或互斥逻辑时运行 `npm test`。浏览器联调使用模拟子进程或本地静态页面；未经用户明确要求，不为测试运行真实发货任务。不要删除 `.pw-profile/`，里面保存本机登录态；不要将登录目录、业务截图和运行日志提交到版本库。

本目录已有 `AGENT.md`，在默认大小写不敏感的 macOS 文件系统中与 `agent.md` 为同一文件，统一维护本文件。

- `POST /api/stop` 接收当前任务 `id`，发送 SIGTERM；停止期间保持运行锁，等待子进程 close 后标记 stopped。停止不会撤销已提交的业务操作。

- `POST /api/clear-profile` 只接受 shipping 或 packing 对应的固定配置目录，任务运行时禁止清除。前端在清除前说明涉及的配置和需要重新登录。

- 主动快照模式 `manual` 使用固定脚本 `web/manual-snapshot.js`，通过 Node IPC 接收 `/api/snapshot` 的抓取请求。会话保持全局锁，运行期间额外允许「抓取当前页面」；不会自动执行 probe 或业务提交。快照 JSON 仅通过受限 `/api/dom/:task/:file` 附件下载，不作为 HTML 执行。

## Temu 采集

- `temu-auto/index.js` 为固定贴纸搜索 URL 的有头采集器；`collector.js` 管理 DOM 提取、保序去重、滚动/加载更多和 JSON/CSV 增量保存。`notify.js` 用无 shell 的参数数组发送 macOS / Windows 本机通知。
- Web 调用 `{task:'temu', mode:'collect', options:{limit:200}}`，limit 限 1–200，仅此任务允许 collect。保持与发货/装箱共享全局任务锁，通过 IPC 同步 `user-action` / `collection-progress`；`POST /api/resume` 必须校验当前任务 id、等待状态和停止状态。
- 验证必须由用户手动处理；不得自动点击验证码。遇未知页面或加载停滞同样等待用户。通知失败不应终止等待。
- 数据保存在被忽略的 `temu-auto/data/`；结果经固定 `/api/data/temu/:file` 附件接口下载，校验文件名及 realpath。主图保存为链接，未展示字段留空并统计缺失，未采满必须标记 partial，避免以退出码或空数据冒充完整结果。
- 默认 Chrome 使用独立 `.pw-profile/`；CLI `--extension` 使用 Chromium 与 `.pw-profile-chromium/`，需先安装 Playwright Chromium，不得加载个人默认 Chrome 配置。Web 不接受任意扩展/脚本路径。
- `npm test` 包含本地真实浏览器采集夹具（要求已安装 Google Chrome）与模拟子进程控制台测试。真实站点可能要求登录，测试不得代替用户完成验证或把本地夹具描述为已采到真实 200 条。
