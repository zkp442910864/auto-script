# 项目说明

这是本机发货自动化项目。`shipping-auto/index.js` 操作跨境卖货的发货台，修改实际发货数并按仓库创建发货单；`packing-auto/index.js` 操作发货单列表，填写箱数、预约取货并确认发货。详细页面选择器、模式行为和已知限制见各目录 `docs.md`。

## Web 控制台

- 根目录 `npm start` 启动 `web/server.js`，默认地址 `http://127.0.0.1:3000`；`PORT` 可改端口。Web 只用 Node 内置模块，不需要打包。
- `npm run setup` 安装两套自动化脚本的依赖，需要本机 Google Chrome。`npm test` 运行控制台集成测试；`npm run dev` 监视服务文件变化，开发时请勿在业务任务运行中重启。
- 前端在 `web/public/`，使用原生 HTML、CSS、JavaScript。界面为中文，保持桌面和移动端可用。
- `POST /api/run` 接收 `{task: 'shipping'|'packing', mode: 'probe'|'dry'|'auto', options: {...}}`。参数允许数值型 `maxRounds`、`slowMo`、`fill` / `boxes`，以及 `browserMode: auto|profile`、1024–65535 整数 `browserPort`，装箱固定复用 `shipping-auto/.pw-profile`，无需登录配置选项。不得提供任意命令、脚本路径或 shell 执行入口。
- `GET /api/events` 为 SSE，`state` 事件同步当前任务和日志缓冲，`log` 事件推送 stdout / stderr；带心跳和自动重连。`GET /api/state` 提供同一状态。`instance` / `revision` 用于避免旧响应覆盖新状态。
- `GET /api/shots` 枚举允许目录的 PNG，`GET /api/shots/:task/:file` 返回原图；不向浏览器提供可执行的 `probe.html`。`GET /api/log` 下载最新任务完整日志。

## 必须保持的行为

1. 全局最多一个任务运行。先原子占用后端锁，再启动子进程；并发请求返回 409。页面任务执行中仅允许手动停止，禁用其他按钮、输入和导航链接，断线及启动等待期间也禁用。
2. 必须等子进程 `close`（输出流结束）后释放锁，而不是读到“结束”日志就解锁。失败启动、非零退出码和信号终止也必须恢复状态。
3. 只能使用 `process.execPath` 与参数数组、固定任务目录启动脚本，`shell: false`。验证参数范围；保持仅本机访问和同源写入限制。
4. 前端用 `textContent` 展示外部日志、文件名和错误，避免当作 HTML 执行。内存日志有上限，完整输出追加到 `.web-runs/*.log`。
5. 快照映射到 `probe`；测试映射到 `--dry --debug` 且 UI 固定 1 轮；正式执行才允许真实业务提交。注意装箱 probe 会打开抽屉、勾选行，不是完全无交互。
6. Web 发货任务带 `--close-browser`，独立模式确保执行结束释放浏览器和登录目录；连接用户浏览器时仅 `browser.close()` 断开 CDP，禁止关闭用户默认 context；保留原始 CLI 默认留窗行为。装箱默认关闭窗口。服务关闭时向当前子进程发送 SIGTERM。
7. 退出码 0 不等同于业务处理成功。原有脚本遇到保护性中止可能正常退出，页面要提示查看业务日志。

## 修改与验证

优先复用现有脚本，不把业务页面自动化逻辑复制到 Web。修改调度、日志或互斥逻辑时运行 `npm test`。浏览器联调使用模拟子进程或本地静态页面；未经用户明确要求，不为测试运行真实发货任务。不要删除 `.pw-profile/`，里面保存本机登录态；不要将登录目录、业务截图和运行日志提交到版本库。

本目录已有 `AGENT.md`，在默认大小写不敏感的 macOS 文件系统中与 `agent.md` 为同一文件，统一维护本文件。

- `POST /api/stop` 接收当前任务 `id`，发送 SIGTERM；停止期间保持运行锁，等待子进程 close 后标记 stopped。停止不会撤销已提交的业务操作。

- `POST /api/clear-profile` 接受 shipping 或 packing 作为兼容别名，均清除固定的 `shipping-auto/.pw-profile`，任务运行时禁止清除。前端在清除前说明涉及的配置和需要重新登录。

- 主动快照模式 `manual` 使用固定脚本 `web/manual-snapshot.js`，通过 Node IPC 接收 `/api/snapshot` 的抓取请求。会话保持全局锁，运行期间额外允许「抓取当前页面」；不会自动执行 probe 或业务提交。快照 JSON 仅通过受限 `/api/dom/:task/:file` 附件下载，不作为 HTML 执行。

- 登录前置使用独立 `login-auto/index.js`，`POST /api/run` 接收 `{task:'login', mode:'login', options:{username?, password?, acceptAgreement?:boolean}}`。首次需成对账号密码，已确认登录时可省略。独立方式与发货/装箱同样使用 `launchPersistentContext` 启动有界面的本机 Chrome，固定共用 `shipping-auto/.pw-profile`；用户浏览器方式通过 CDP 连接用户预先开启调试的 Chrome，不读取或复制日常 Chrome 配置。手机号和邮箱自动切换登录标签；只有用户在控制台明确勾选协议授权，脚本才勾选站点协议并提交。账号密码仅通过 IPC 传递，禁止放入命令行、公开状态或日志，尤其不可输出 Playwright fill 异常的原始消息或堆栈。此模式持续保留浏览器直到用户关窗、点击停止或服务关闭，不因登录成功、超时、导航或表单错误自动结束。准备结束后释放全局锁，用户再手动运行后续流程。
- `/api/state` 和 SSE state 的 `profiles` 仅含共享配置 `shipping.saved`，以登录成功标记判断，不以 Cookie 数据库文件存在作为已登录证据。检测到登录页时清除过期标记。登录脚本复用 `shipping-auto/node_modules/playwright-core`，无需第三份依赖；测试只用本地页面和模拟进程。

- `npm run test:login` 用本机 Chrome 对本地模拟登录页验证自动切换、字段填充、协议授权和只提交一次；`node login-auto/index.js --probe` 用脚本本身启动的共享 Chrome 抓取真实登录页结构，完成后保留窗口。登录截图遮挡 input，字段 JSON 不保存输入值，产物在忽略的 `login-auto/shots/`。

- 用户明确要求在控制台本地缓存账号密码：前端用 `localStorage` 的 `auto-console.login.v1` 保存并恢复输入，不因提交或登录状态变化清空；「清除登录信息」成功后同时移除该缓存并清空表单。不缓存登录协议授权，不向日志、SSE 或命令行暴露凭据。


## 用户浏览器扩展

- 共用 `shared/browser-session.js`；Web 默认优先用户浏览器，CLI/旧 API 未选 `auto` 时继续原方式。Web 仅传固定模式和数字端口，通过环境变量 `AUTO_BROWSER_MODE` / `AUTO_BROWSER_PORT` 交给子进程；继续清空任意外部 `CDP` / `PROFILE`。所有任务通过 IPC 的 `browser-session` 同步实际方式和固定文案回退原因。
- `GET /api/browser-check?port=9222` 仅检测选定的 `127.0.0.1` 端口，限制响应大小、总超时、不跟随重定向，验证 websocket 为同机同端口的 browser endpoint。检测不代表已登录，也不占任务锁。实际运行重新连接；失败仅在任务启动阶段回退，不在业务执行后重跑。
- 连接用户浏览器使用已有默认 context 的新任务标签页，保留用户原标签页；不得在清理时调用该 context.close()。结束或停止只断开 CDP，保留用户窗口和任务标签页。登录准备关闭任务页也应释放会话；主动快照只抓任务页及其 popups，不能抓用户其他页面。
- 用户浏览器的登录不写入/清除共享配置的 `.login-state.json`；清除登录信息只影响项目共享配置与控制台缓存。auto 登录准备允许不传凭据，连接/回退后手动继续；profile 原有首次凭据校验保持。
- Web 展示三系统的 Chrome 启动命令与完整步骤。Chrome 136+ 要求非默认 user-data-dir，明确不能直接接管普通日常窗口。浏览器设置缓存为 `auto-console.browser.v1`，不缓存协议授权。
- `npm test` 运行服务与浏览器适配单测；`npm run test:browser` 使用临时配置、无头本机 Chrome 和模拟业务子进程验证 CDP、登录会话清理及 Web。禁止为验证扩展运行真实发货业务。
