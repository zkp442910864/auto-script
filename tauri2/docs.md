# 桌面壳（tauri2）技术文档

`tauri2/` 是业务项目的 Tauri 2 桌面壳：装好后双击启动，自动把业务代码备好、起本地服务、在界面给出访问地址，用户点「在浏览器中打开」进入控制台。业务代码不打进安装包，运行时下载到应用数据目录。
界面**零配置**——仓库地址、分支、端口、业务目录全部写死在 `src-tauri/src/config.rs`，没有设置页、没有配置文件、没有目录选择对话框。

读者分工：只想用的人看根 `README.md`；改业务代码的硬约束看根 `AGENT.md`；要维护或排查壳本身看本文。

## 1. 这是什么

- 壳是「托管器」：不复刻业务界面，只在应用数据目录下准备好业务代码，起 `node web/server.js`；健康检查通过后在界面显示 `http://127.0.0.1:<端口>`，用户点「在浏览器中打开」按钮时才用系统浏览器访问。
- 安装包里**不含**业务代码，也**不含** Node.js。首次启动从 GitHub 下载 `main` 分支的 archive zip 到本地；Node.js 缺失时引导自动安装。
- 壳自己的窗口只有：顶栏（标题 + 阶段徽章 + 「打开业务目录」）、启动进度卡片、错误/更新横幅、操作按钮（在浏览器中打开 / 检查更新 / 重启服务）、运行环境卡片（Node.js / npm 两行）、日志面板（最多 1000 行，可暂停滚动）。业务操作全在浏览器里。

### 用户流程

首次启动：

1. 检查环境：`node --version` 主版本 ≥ 18，且 npm 可用。缺失时流水线暂停，环境卡片里只有「安装 Node.js」一个按钮（顶栏、错误横幅、操作区的其他按钮仍可用），装完自动续跑。
2. 准备业务代码：下载 archive zip → 解压到中转目录 → 校验入口文件 → 整体移入业务目录。
3. 安装依赖：业务目录内执行 `npm run setup`。
4. 启动服务：`node web/server.js`，`cwd=<业务目录>`，环境变量 `PORT=<可用端口>`。
5. 健康检查：轮询 `GET /api/state`，返回 2xx 即就绪，总超时 30 秒。
6. 就绪：状态徽章显示「运行中 http://127.0.0.1:<端口>」，点「在浏览器中打开」进入业务界面。

二次启动：入口文件已存在就跳过下载，依赖指纹未变且两个子包 `node_modules` 都在就跳过安装，直接启动服务。多数情况只需几秒。

| 阶段 | 首次启动 | 二次启动 |
| --- | --- | --- |
| 检查环境 | 执行 `node --version` / `npm --version` | 同左，很快 |
| 准备业务代码 | 下载 zip（带字节进度）+ 解压 + 搬移 | 检测到入口文件，写一行「跳过下载」 |
| 安装依赖 | 执行 `npm run setup` | 指纹与落盘一致时跳过 |
| 启动服务 | spawn node + 健康检查 | 同左 |
| 就绪 | 展示地址 | 展示地址 |

## 2. 目录结构与模块职责

| 路径 | 负责什么 |
| --- | --- |
| `src/main.tsx` | 入口；不使用 `StrictMode`，避免开发模式 effect 双跑导致事件重复订阅 |
| `src/App.tsx` | 状态机与按钮：订阅 6 个事件、挂载时同步快照与历史日志、统一 busy 保护 |
| `src/api.ts` | 9 个命令的封装，命令名必须与 Rust 注册名一致 |
| `src/types.ts` | 与 Rust 结构体一一对应的 TypeScript 类型 |
| `src/components/StatusBadge.tsx` | 顶部阶段徽章 |
| `src/components/EnvCard.tsx` | Node.js / npm 两行 + 「安装 Node.js」按钮 |
| `src/components/LogPanel.tsx` | 日志面板（等宽、自动滚动、可暂停） |
| `src-tauri/src/lib.rs` | 插件注册、9 个命令注册、信号处理、契约测试 |
| `src-tauri/src/config.rs` | 六个固定常量、业务目录解析、远端 URL 拼装、`business_ready` 判据 |
| `src-tauri/src/bootstrap.rs` | 启动流水线：阶段推进、中转目录、搬移、依赖指纹、4 个命令 |
| `src-tauri/src/service.rs` | 服务生命周期：端口选择、spawn、健康检查、优雅停止、崩溃监控、日志环形缓冲 |
| `src-tauri/src/updater.rs` | zip 下载与安全解压、受保护路径、备份回滚、版本比较、2 个命令 |
| `src-tauri/src/env_check.rs` | node / npm 自检、`which`、`npm_command`、三平台 Node.js 补装 |
| `src-tauri/src/path_env.rs` | 子进程 PATH 构造（所有 spawn 必须经过它） |
| `src-tauri/src/proc_util.rs` | 流式输出转发、HTTP 下载、`npm run setup` 封装 |
| `src-tauri/capabilities/default.json` | 主窗口能力：`core:default`、`opener:default`、`opener:allow-open-url`、`process:default` |
| `vite.config.ts` | 前端构建：端口 5199、`strictPort`、输出 `dist/` |
| `src-tauri/tauri.conf.json` | 产品名「发货控制台」、identifier `com.koudouma.autoconsole`、devUrl、窗口尺寸、bundle 目标 |
| `.github/workflows/build.yml` | CI：`tauri2/**` 变更即构建并自动发 Release |

固定常量（`config.rs`）：

| 常量 | 值 |
| --- | --- |
| `REPO_URL` | `https://github.com/zkp442910864/auto-script` |
| `BRANCH` | `main` |
| `DEFAULT_PORT` | `3000` |
| `ENTRY_FILE` | `web/server.js` |
| `BUSINESS_DIR_NAME` | `business` |
| `HEALTH_PATH` | `/api/state` |

## 3. 启动时序

`lib.rs` 的 `setup` 里依次做四件事：初始化日志文件（`<appData>/console.log`）、初始化流水线状态、注册退出信号处理（`#[cfg(unix)] install_signal_handlers`）、在独立线程里跑 `run_pipeline_blocking(handle, Stage::CheckingEnv)`。流水线放在独立线程，`setup` 立即返回，窗口不必等初始化跑完才出现。

阶段是 `bootstrap::Stage`，序列化为 camelCase，与前端 `Stage` 字面量一一对应：

| 阶段值 | 中文标签 | 做什么 | 在主链路上 |
| --- | --- | --- | --- |
| `checkingEnv` | 检查环境 | 检测 node / npm，失败即中断 | 是 |
| `fetchingCode` | 准备业务代码 | 入口文件缺失时下载 + 解压 + 搬移 | 是 |
| `installingDeps` | 安装依赖 | `npm run setup`，可跳过 | 是 |
| `starting` | 启动服务 | 清残留进程 → spawn → 健康检查 | 是 |
| `ready` | 运行中 | 记录端口，进度 100 | 否（终点） |
| `stopped` | 服务已停止 | 服务正常退出后由 `service` 侧同步 | 否 |
| `error` | 初始化失败 | 记录 `failed_stage`，可重试 | 否 |
| `installingNode` | 安装 Node.js | 用户点「安装 Node.js」后的分支，装完从 `checkingEnv` 续跑 | 否 |

上报方式：

- `bootstrap-status` 事件 + `bootstrap_status` 命令：负载是 `BootstrapSnapshot { stage, detail, progress, port, error }`。`detail` 是中文进度说明，`progress` 为 `null` 时前端不画进度条。
- `bootstrap-log` 事件：纯字符串，一行一条。Rust 侧同时写进环形缓冲和磁盘日志，前缀为 `[init]`。
- 失败处理：`report_error` 把阶段置为 `error`、把 `failed_stage` 设为出错阶段，并广播快照。「重试」调用 `retry_pipeline`，从 `resume_from(failed_stage)` 续跑——`fetchingCode` / `installingDeps` / `starting` 原样续跑，其余情况回到 `checkingEnv`，不会从头再来。
- 并发保护：`BootstrapState.running` 是 `AtomicBool`，第二次进入直接返回「初始化流程已在执行中，忽略本次请求」。

首次初始化的搬移细节：

1. 中转目录名 `.bootstrap-staging-<时间戳>-<pid>`，每次全新，旧目录（同前缀的目录）先尽力清理，删不掉也不影响本次。
2. 解压必须落在中转目录：半成品落进业务目录会被 `business_ready` 误判为「已有代码」而永远跳过初始化。
3. 校验中转目录含 `web/server.js`，否则整包作废。
4. `move_children` 把子项移入业务目录，**入口文件所在的顶层目录（`web/`）最后移动**。中途失败时业务目录不含入口文件，下次启动会重新下载，而不是把半成品当完整代码。
5. 同卷走 `rename`，跨卷退化为递归复制 + 删除；同名顶层目录整体替换，不合并残留。

## 4. 前端 ↔ Rust 契约

9 个命令（`lib.rs` 的 `generate_handler!`），前端全部无参调用，`AppHandle` 由 Tauri 注入：

| 命令 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `check_environment` | 无 | `ToolStatus[]` | 环境自检，`ToolStatus { name, ok, version, detail }` |
| `install_node` | 无 | `ToolStatus[]` | 三平台自动补装；成功后自动续跑流水线；失败 reject 字符串 |
| `bootstrap_status` | 无 | `BootstrapSnapshot` | 挂载时同步快照，避免错过启动早期事件 |
| `retry_pipeline` | 无 | `BootstrapSnapshot` | 从失败阶段续跑 |
| `restart_service` | 无 | `BootstrapSnapshot` | 停服务再启动，含健康检查 |
| `open_business_dir` | 无 | `void` | 在系统文件管理器中打开业务目录 |
| `get_logs` | 无 | `string[]` | 日志环形缓冲快照（最多 1000 行） |
| `check_update` | 无 | `UpdateInfo` | 比对本地与远端 `package.json` 的 `version` |
| `perform_update` | 无 | `void` | 下载 → 解压 → 备份 → 覆盖 → 视情况装依赖 → 重启 |

6 个事件：

| 事件 | 负载 | 生产者 |
| --- | --- | --- |
| `bootstrap-status` | `BootstrapSnapshot` | `bootstrap.rs` |
| `bootstrap-log` | `string` | `bootstrap.rs`、`proc_util.rs` |
| `service-status` | `StatusSnapshot { phase, port, detail }` | `service.rs` |
| `service-log` | `string` | `service.rs` |
| `env-log` | `string` | `env_check.rs` |
| `update-log` | `string` | `updater.rs` |

服务进程状态机是另一套枚举 `service::Phase`：`idle` / `starting` / `running` / `stopped` / `crashed` / `error`。它与流水线阶段分开维护，只在两端交界处同步：`crashed` 让流水线进入 `error` 并把 `failed_stage` 设为 `starting`（于是「重试」等价于「重启服务」），`stopped` 让流水线进入 `stopped`；`starting` / `running` 由流水线自己维护，`on_service_phase` 忽略。

前端按钮与启用条件：

| 按钮 | 位置 | 禁用条件 |
| --- | --- | --- |
| 打开业务目录 | 顶栏 | 任意命令执行中 |
| 重试 | 错误横幅 | 仅 `stage === 'error'` 时出现 |
| 执行更新 | 更新横幅 | 仅 `hasUpdate === true` 时出现 |
| 在浏览器中打开 | 操作区 | `stage !== 'ready'` 或没有端口 |
| 检查更新 | 操作区 | 任意命令执行中 |
| 重启服务 | 操作区 | 任意命令执行中，或 `stage === 'fetchingCode'` |
| 安装 Node.js | 环境卡片 | 仅存在不通过的检测项时出现 |

契约由 `lib.rs` 的 5 个契约测试守住：命令名前后端集合必须相等（防漏注册，也防留死命令）、已删除的设置页命令不得复活、前端不得引用设置面板与 dialog 插件、Rust 侧源码里必须出现这 6 个事件名字面量（只做字面量搜索，写在注释里也会通过，不能替代人工确认 `emit` 位置正确）、生产代码不得残留占位仓库地址或 `settings` 模块。

## 5. 下载与更新

首次初始化与在线更新共用同一套解压逻辑（`updater::extract_archive`），来源都是 GitHub archive：

- 源码包：`https://github.com/zkp442910864/auto-script/archive/refs/heads/main.zip`
- 版本探针：`https://raw.githubusercontent.com/zkp442910864/auto-script/main/package.json`

`perform_update` 的顺序：

1. 清理上次更新被中断残留的临时文件（同目录下形如 `.<文件名>.autoupdate.tmp`）。
2. 下载 zip 到 `tempfile`（文件名不可预测，drop 时自动删除，超时 300 秒）。
3. 解压到临时目录（路径穿越防护 + 顶层目录剥离，见第 6 节）。
4. 递归收集有效文件；受保护目录直接剪枝，残留临时文件跳过；收集为空则报「更新包内容为空或格式不正确」。
5. 把**将被覆盖的现存文件**全量备份到 `<appData>/backups/<时间戳>/files/`，并写 `manifest.json`（含 `timestamp`、`zipUrl`、`overwrittenFiles`）。
6. 逐个覆盖：先写同目录临时文件再 `rename` 原子替换。任一步失败立刻回滚——已覆盖的按备份恢复，新增的删除——并报「已回滚到更新前状态」。
7. 只保留最近一次备份，更早的备份目录删除。
8. 依赖清单（`package.json` / `package-lock.json`，含子目录）内容有变化才重跑 `npm run setup`；安装失败时报「文件已更新，但依赖安装失败」，文件不回滚。
9. 更新前服务在运行 → 自动重启服务以应用更新。

其他行为：

- 业务代码未初始化完成时不做版本比对，返回 `localVersion: "未初始化"` 与提示语，避免给出错误的「可更新」引导。
- 版本比较只看业务 `package.json` 的 `version`：先归一化（去 `v` 前缀与首尾空白、核心段补零到三段、多余段丢弃），能解析成 semver 就用 `cmp_precedence`（build metadata 不参与排序），解析失败回退到按 `.`/`-`/`+` 切分取数字逐段比较。
- 「本地存在、远端已移除」的文件**不会自动删除**，只在 `update-log` 里列出前 20 条并提示总数。

## 6. 安全底座

zip 条目名的唯一入口是 `resolve_entry_path`，返回值分三种：`Ok(Some(rel))` 写入、`Ok(None)` 跳过（目录条目 / 空路径）、`Err(msg)` → **整个更新包中止**，不落盘任何后续条目。

拒绝规则（命中任一即拒绝）：

| 向量 | 判据 |
| --- | --- |
| `..` | 任一路径段等于 `..`（不做弹栈容忍，直接拒绝） |
| Unix 绝对路径 | 归一化分隔符后以 `/` 开头 |
| Windows 盘符 | 第二字节为 `:` 且第一字节是 ASCII 字母（`C:\...`、`C:/...`） |
| UNC 路径 | `\\server\share\x` 统一分隔符后变成 `//server/...`，命中绝对路径规则 |
| NTFS 备用数据流（ADS） | 仅 Windows：任一路径段含 `:` |

空段与 `.` 不算非法，被折叠丢弃（`./a//b/./c.txt` → `a/b/c.txt`）；`\` 统一成 `/`。所以 `../`、`..`、`/etc/x`、`C:/Windows/x.dll`、`\\server\share\x` 都会被拒。

第二道保险：`dest_root.join(rel)` 之后断言 `dest.starts_with(dest_root)`，越界直接中止。

顶层目录剥离（GitHub archive 形如 `auto-script-main/`）：仅当所有条目共享同一个首段、该首段不在已知业务顶层清单（`web`、`shared`、`shipping-auto`、`packing-auto`、`login-auto`、`.web-runs`、`.git`、`node_modules`）、且首段含 `-` 时才剥离。若同时存在根级文件与「像仓库根」的 `<x>-<y>/` 目录（内部带 `package.json` / `package-lock.json` / `web/server.js`），判定为结构异常并**拒绝整包**——否则会把整目录塞进业务目录，更新看起来成功实则没生效。

已知误杀（判据偏宽，尚未收紧）：只要「包里有根级文件」且「某个目录名含 `-`、其内直接有 `package.json` / `package-lock.json`」，就会判为混合结构并拒绝整包。扁平仓库里的工具目录 `scripts-v2/package.json` 会中招；同样是 `scripts-v2/`，若里面只有 `build.sh`（无仓库标志文件）则不误判。`updater.rs` 里有 tripwire 测试 `qa_mixed_structure_heuristic_currently_flags_scripts_v2` 锁定了当前行为，收紧判据时要把那条断言同步改成 `None`。

受保护路径（更新时一律跳过，判定前先归一化）：

- 目录前缀：`shipping-auto/.pw-profile/`、`shipping-auto/shots/`、`packing-auto/.pw-profile/`、`packing-auto/shots/`、`.web-runs/`、`login-auto/shots/`
- 单个文件：`.login-state.json`
- 任意层级：`node_modules`、`.git`

归一化（`normalize_rel_path`）会统一分隔符、丢弃空段与 `.`、遇 `..` 弹栈、转小写。因此 `shipping-auto//sub/../.pw-profile/Cookies`、`SHIPPING-AUTO/./.PW-PROFILE/cookies`、`packing-auto\.pw-profile\...` 都判为受保护；同时用「整段比较 + 带尾斜杠的前缀」避免过度拦截，`shipping-auto/.pw-profileX/`、`shipping-auto/shots.md`、`.web-runs2/` 这类形似路径仍可正常覆盖。

## 7. 进程与端口

- 端口：从 `DEFAULT_PORT`（3000）起在 `[3000, u16::MAX]` 内逐个 `bind("127.0.0.1", port)` 探测，取第一个能绑定的端口——被占用时逐个 +1 往下试，可能一次跳好几个号（3000、3001 都占着就直接给 3002）。首选端口被占时写一行日志「端口 3000 已被占用，自动改用 3002」。区间耗尽时抛 `PortExhausted`：「从端口 3000 起没有可用端口，请释放一个端口后点击「重试」。」实际端口通过 `PORT` 环境变量传给子进程，界面与「在浏览器中打开」都用实际端口。
- 启动：直接用 `which` 找到的 node 绝对路径 spawn，不经 shell；`cwd` 为业务目录，参数只有一个 `web/server.js`。
- 进程组（Unix）：`cmd.process_group(0)` 让子进程成为独立进程组（pgid == pid），停止时先对 `-<pid>` 整组发信号，再补发单进程，防止 Playwright 派生的浏览器与 node 子进程残留。
- 停止（手动「重启服务」路径）：`SIGTERM` → 每 100ms 检查 → **5 秒**宽限 → 超时 `SIGKILL` → 再等 3 秒 → 仍未退出则报「无法停止服务进程」。
- 退出（关窗 / Cmd+Q / 信号）：走 `shutdown_on_exit`，`SIGTERM` → 等 **3 秒** → 超时 `SIGKILL`。用 `ShutdownGuard` 的一次性认领保证幂等：`RunEvent::Exit` 与信号处理线程都会调用，只有第一次真正执行。
- 信号：Unix 下注册 `SIGTERM` / `SIGINT` / `SIGHUP`。被信号终止不会触发 `RunEvent::Exit`，缺了这段就会留下孤儿 node 占住端口，用户下次启动漂到 3001（看起来像出错）。
- Windows：`taskkill /PID <pid> /T`，强制时追加 `/F`。
- 健康检查：`GET http://127.0.0.1:<port>/api/state`，单请求超时 2 秒，每 500ms 轮询，返回任一 2xx 即通过。总超时 30 秒；进程提前退出则立即报「服务进程在就绪前退出（退出码：N）」。
- 崩溃监控：每个进程有一个自增 `generation`。旧进程的退出监控发现代号已变就只记日志、不写状态，避免「重启时旧进程晚到的退出事件」把新进程覆盖成 stopped。
- 日志：环形缓冲 1000 行 + 追加写 `<appData>/console.log`，每行带 `[HH:MM:SS]` 时间戳；前缀区分来源：`[init]` / `[setup]` / `[proc]` / `[server]` / `[service]` / `[env]` / `[update]` / `[app]`（`[app]` 用于信号退出）。

## 8. 环境检查与 PATH

这是本壳最容易翻车的点：补装 Node.js 之后，**当前进程的 PATH 不会自动刷新**。因此全仓约定——任何 `Command::new(...)` 在 `spawn()` / `output()` 之前必须调用 `path_env::prepare_command`。该函数在 Windows 下还会给子进程加 `CREATE_NO_WINDOW`（0x0800_0000）：release 构建是 GUI 子系统进程、自身没有控制台，不加该标志时每个控制台子进程（node、taskkill、winget……）都会新开一个可见的命令行窗口；stdout/stderr 经 `Stdio::piped()` 读取不受影响。

候选目录顺序（前置优先，去重保序）：

1. Unix：`~/.nvm/versions/node/*/bin`，按版本号**降序**（升序会在 nvm 同时有 v16 / v18 / v22 时选中 v16，误报版本过低，brew 新装的版本也永远轮不到）。
2. Unix 固定目录：`/usr/local/bin`、`/opt/homebrew/bin`、`/usr/bin`、`/bin`、`/usr/sbin`、`/sbin`。
3. Windows 固定目录：`C:\Program Files\nodejs`、`C:\Program Files (x86)\nodejs`、`%USERPROFILE%\AppData\Roaming\npm`。
4. 最后拼上现有 `PATH`。

检测与定位：

- `which` 在候选目录里找文件，Windows 额外尝试 `.exe` / `.cmd` / `.bat` 后缀。
- npm 走两条路：Unix 直接用 `which("npm")`；Windows 用 node 执行 `npm-cli.js`（规避 `.cmd` 需要 shell 的问题），按 `bin/node_modules/...`、`../lib/node_modules/...`、`/usr/local/lib/...`、`/opt/homebrew/lib/...` 依次找。
- 版本门槛：`node --version` 主版本 ≥ 18。npm 只要存在且能执行即通过；Windows 上只有 `npm-cli.js` 也判为通过。

自动补装（`install_node`，唯一的人工介入点）：

| 平台 | 方式 |
| --- | --- |
| Windows | `winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements` |
| macOS | 有 Homebrew 则 `brew install node`；否则从 `nodejs.org/dist/latest/` 找 `.pkg` 下载，经 `osascript` 请求管理员权限安装 |
| Linux | 仅 apt 系：下载 NodeSource `setup_20.x` 脚本，`sudo bash` 后 `sudo apt-get install -y nodejs` |
| 其他 | 直接报「当前平台不支持自动安装」 |

安装过程的输出逐行发到 `env-log`。成功后调用 `resume_pipeline_async`，从 `checkingEnv` 重新验证并继续拉代码 / 装依赖 / 启动；失败则把流水线标为 `检查环境失败`。

## 9. 开发与验证

```bash
cd tauri2
pnpm install
pnpm tauri dev     # 起 Vite（5199）+ 编译 Rust + 打开桌面窗口
```

Vite 端口固定 **5199**，且 `strictPort: true`。原因是默认端口 5173 经常被本机其他项目的 dev server 占用，此时 Tauri 窗口会按 `devUrl` 加载到别人的页面（2026-11-13 实际踩过）。`vite.config.ts` 的 `server.port` 与 `tauri.conf.json` 的 `build.devUrl` 必须一致，改一处就要改另一处。

```bash
pnpm dev           # 只起 Vite（5199），浏览器里调 UI 用
pnpm typecheck     # tsc --noEmit
pnpm build         # tsc --noEmit && vite build → dist/
```

```bash
cd tauri2/src-tauri
cargo test         # 74 个单元测试，不访问外网、不需要本机 Chrome
cargo check        # 快速类型检查
```

测试分布：`bootstrap` 12、`updater` 31、`service` 9、`config` 6、`path_env` 6、`env_check` 5、`lib` 契约测试 5。以 `cargo test --lib -- --list` 输出为准。

- 用例覆盖：阶段序列与序列化名、快照字段名、依赖指纹变化与缺失、搬移语义（入口文件最后移动、同名整体替换）、残留中转目录识别、端口探测与区间耗尽、退出清理幂等、PATH 顺序与 nvm 降序、版本比较（预发布、build metadata、非标准串）、受保护路径的组合绕过与误拦截、真实 zip 的穿越条目必须中止整包。
- 改 `App.tsx` / `api.ts` 后必须重跑 `cargo test`：命令名、事件名、禁用的设置页符号都由契约测试扫描前端源码，改错直接红。
- Windows 上已知失败：`env_check` 的 `which_returns_existing_paths_for_known_program` 断言本机存在 `sh` / `bash`，但没有按 `#[cfg(unix)]` 门控，在 Windows 下 `cargo test` 会挂。这是已知问题，测试未改动；CI 也不跑 `cargo test`，所以不影响发版。
- 前端不要在开发时打开 `StrictMode`：effect 双执行会重复注册事件监听，日志出现重复行。

## 10. 打包与发布

本地打包：

```bash
cd tauri2
pnpm tauri build                                  # 当前平台
pnpm tauri build --target universal-apple-darwin  # macOS 通用包（Intel + Apple Silicon）
pnpm tauri build --bundles nsis                   # Windows 只出 NSIS 安装器
```

产物路径：`tauri2/src-tauri/target/release/bundle/`（指定 `--target` 时是 `target/<target>/release/bundle/`）。macOS 产出 `bundle/macos/发货控制台.app`，打 dmg 时另有 `bundle/dmg/*.dmg`；Windows 产出 `bundle/nsis/*-setup.exe` 与 `bundle/msi/*.msi`。`tauri2/dist/`、`src-tauri/target/` 不入库。

需要 `.app.zip` 时自己压一下（macOS，保留 `.app` 目录结构）：

```bash
cd tauri2/src-tauri/target/release/bundle/macos
ditto -c -k --keepParent "发货控制台.app" macos-universal.app.zip
```

CI（`.github/workflows/build.yml`）：

- 触发：推送到 `main` **且改动命中 `tauri2/**`** → 构建 + 自动创建/更新 Release。过滤器是路径前缀，不按扩展名区分：只改业务代码或 `tauri2/` **之外**的文档不触发，但 `tauri2/` 下任何文件（**包括 `tauri2/docs.md`、`tauri2/package.json` 这类文档与配置本身**）都会触发构建并自动发版。也可在 Actions 页面手动触发，`release` 输入默认勾选，`tag` 留空则自动解析。
- 构建矩阵：`macos-latest` 用 `--target universal-apple-darwin`；`windows-latest` 用 `--bundles nsis`，MSI 由单独的 `continue-on-error` 步骤尽力产出（WiX 对非 Latin 字符敏感，失败不阻塞）。工具链为 pnpm 9、Node 20、Rust stable。
- 产物收集只从 `*/release/bundle/*` 取最终安装包，并统一改成 ASCII 文件名——GitHub 会吞掉中文附件名。三个稳定附件：`macos-universal.dmg`、`macos-universal.app.zip`（`.app` 目录用 `ditto` 压成 zip）、`windows-x64-setup.exe`；第四个 `windows-x64.msi` 是 best-effort，可能不存在。artifact 保留 30 天。
- 没有测试门禁：workflow 里既不跑 `cargo test` 也不跑 `pnpm typecheck`，「CI 绿」只代表能编出安装包，不代表 74 个用例通过。发版前请本地自己跑 §9 里的命令。
- 只有 macOS 与 Windows 有安装包，**Linux 没有 Release 产物**（矩阵里没有 linux 任务）；§8 的 Linux Node.js 补装只对「直接跑源码」的场景有意义。
- 标签：`shell-v<tauri2/package.json 的 version>`。若同名标签已指向别的提交（版本号没变却又要发版，例如 `--no-verify` 提交或合并提交跳过了自增），自动改成 `shell-v<version>-<提交短 SHA 7 位>`，避免覆盖上一版附件。
- 权限 `contents: write`；`concurrency` 按 ref 分组并 `cancel-in-progress`。workflow 用 `GITHUB_TOKEN` 创建的标签 / Release 不会再触发工作流，不存在循环。

未签名 / 未公证是既有事实：

- macOS：安装包未做 Apple 公证，首次打开可能提示「已损坏」或「无法验证开发者」。绕过方式：终端执行 `xattr -dr com.apple.quarantine "/Applications/发货控制台.app"`，或右键 →「打开」。
- Windows：未做代码签名，SmartScreen 可能拦截，点「更多信息」→「仍要运行」。

## 11. 版本号规则

两套版本号，互不替代：

| 版本号 | 位置 | 作用 |
| --- | --- | --- |
| 业务版本 | 根 `package.json` 的 `version`（同步 `package-lock.json` 的根版本） | 壳判断「业务代码有没有更新」的**唯一依据** |
| 壳版本 | `tauri2/package.json`、`src-tauri/tauri.conf.json`、`Cargo.toml`、`Cargo.lock` 四处必须一致 | Release 标签 `shell-v<版本>` 的来源，也是安装包的版本 |

`.githooks/pre-commit`（`git config core.hooksPath .githooks` 启用，每个克隆一次）：

- 只在 `main` 生效；合并 / rebase / cherry-pick / revert 过程中不改版本，避免冲突；工作区版本与 HEAD 不同（手动改过）时跳过，尊重手改值。
- 每次提交递增业务 patch（`1.0.6 → 1.0.7`）。
- **提交包含 `tauri2/` 改动时**，额外递增壳版本，并同步四处文件（`Cargo.lock` 里 `name = "auto-console-shell"` 那一条也要改，否则 `cargo build` 会改写它留下脏工作区）。
- 需要 major / minor 时先手动 `node .githooks/bump-version.mjs minor`（或 `major`）再提交；`--shell` 强制连壳版本一起递增。临时跳过用 `git commit --no-verify`（会让标签撞车，见上一节）。

## 12. 常见故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 开发时窗口打开是别的项目页面 | Vite 5173/5174 被其他项目占用，`devUrl` 落到别人的 dev server | 已固定 5199 + `strictPort`；若仍异常，检查 `vite.config.ts` 的 `server.port` 与 `tauri.conf.json` 的 `devUrl` 是否一致 |
| 首次启动卡在「安装依赖」 | npm 网络慢、registry 不可达、`npm run setup` 子包安装失败 | 看日志面板里 `[setup]` 段落；确认 Node.js 18+ 与网络；修好后点「重试」从 `installingDeps` 续跑，不会重新下载代码 |
| 界面显示 3001 而不是 3000 | 3000 已被占用（常见于上次异常退出留下 node 进程） | 这是设计行为，逐个 +1 探测到第一个可绑定端口；日志里有「端口 3000 已被占用，自动改用 3001」；关掉占端口的进程后重启服务即回到 3000 |
| 启动时提示「未找到 Node.js」 | PATH 里没有 node，或版本 < 18 | 点「安装 Node.js」，装完自动续跑 |
| 服务启动失败 | node 进程退出、端口区间耗尽、健康检查超时 | 看日志面板与 `<appData>/console.log`；`[server]` 行是业务进程自己的输出，`[service]` 行是壳的判断 |
| 服务意外退出（退出码 N） | 业务脚本崩溃或被杀 | 界面进入「初始化失败」，点「重试」等价于重启服务；再不行看 `[server]` 日志 |
| macOS 提示「已损坏」/「无法验证开发者」 | 未公证 | `xattr -dr com.apple.quarantine "/Applications/发货控制台.app"`，或右键 →「打开」 |
| Windows SmartScreen 拦截 | 未签名 | 「更多信息」→「仍要运行」 |
| Windows 运行时弹出黑色命令行窗口 | release 构建是 GUI 子系统，控制台子进程各自新开控制台 | 已在 `path_env::prepare_command` 统一加 `CREATE_NO_WINDOW`；若仍有弹窗，说明有绕过 `prepare_command` 的新 spawn（或 node 内部孙进程，需 `windowsHide: true`），逐个补上 |
| 「检查更新」提示「业务代码尚未初始化完成」 | 入口文件不存在 | 先把初始化跑完（或点「重试」） |
| 更新后版本号没变、页面还是旧的 | 业务 `package.json` 的 `version` 没递增（`--no-verify` 提交） | 手动 `node .githooks/bump-version.mjs` 后提交，再检查更新 |
| 更新报「更新包结构异常」 | 仓库打包方式变化，zip 里同时有根级文件和 `x-y/` 目录 | 检查仓库 archive 结构；壳会拒绝整包，业务代码保持更新前状态 |
| 更新报「更新包结构异常」但仓库明明是扁平的 | 判据偏宽：某个目录名含 `-` 且其内有 `package.json`（如 `scripts-v2/`）就会被误判为混合结构 | 已知问题，见 §6。壳拒绝整包、代码保持原样；临时办法是把该目录改成不含 `-` 的名字，根治要收紧 `detect_mixed_structure` 判据（并同步那个 tripwire 测试） |
| 需要看业务代码或日志文件 | — | 点顶栏「打开业务目录」；成功更新后旧文件备份在 `<appData>/backups/<时间戳>/` |

业务目录（`<appData>/business`）在各平台的位置：

| 平台 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/com.koudouma.autoconsole/business` |
| Windows | `%APPDATA%\com.koudouma.autoconsole\business` |
| Linux | `~/.local/share/com.koudouma.autoconsole/business` |

应用数据目录下其他条目：`console.log`（全部日志）、`deps-fingerprint.txt`（依赖清单指纹）、`backups/`（更新备份）、`.bootstrap-staging-*`（初始化中转目录，成功后自动删除）。
