# packing-auto · 发货单列表批量装箱发货

跨境卖货后台（seller.kuajingmaihuo.com）的自动化脚本：在**发货单列表**里逐单执行
「勾选第一行 → 批量装箱发货 → 填箱数 → 设置预约取货时间 → 确认发货」，直到列表没有待处理数据。

> 思路参照同目录下的 `shipping-auto`，但走的是另一套页面：**批量装箱发货抽屉**。

---

## 1. 它到底做了什么

```
打开发货单列表 /main/order-manager/shipping-list
  │
  ├─ 列表无数据？ → 结束
  │
  └─ 【循环】
       1. 清空残留勾选 → 勾选第一行（FH 开头的发货单号）
       2. 点工具栏「批量装箱发货」
          └─ 若弹「同仓库单一起装箱」确认框 → 点确认
       3. 右侧抽屉「装箱发货」打开
          ├─ 填「发货总箱/包数」= 1        （--boxes 可改）
          └─ 等仓库/物流信息加载完
       4. 「预约取货时间」= 最近可选（日期 + 时间）
       5. 点「确认发货」→ 抽屉关闭 = 成功
       6. 回到 1
```

**核心原则：每一步都读页面自身的状态来判定，不靠 `sleep` 猜。**
任何一步没确认成功就停住并截图，**绝不硬点「确认发货」**——宁可少发一单，不发错单。

| 要确认的事 | 判定依据 |
|---|---|
| 行有没有勾上 | 复选框 `data-checked="true"` |
| 抽屉有没有打开 | `[data-testid="beast-core-drawer"]` 可见，且标题为「装箱发货」 |
| 仓库信息加载完没有 | `发货仓库` 有值 **且** 预约取货日期框解除 `disabled` |
| 这单要不要预约取货 | `#deliverMethod` 选中的是不是「在线物流下单」 |
| 提交成功没有 | 抽屉关掉了（关掉后顺带读一下 toast） |

---

## 2. 快速开始

```bash
cd C:/Users/Administrator/Desktop/test/packing-auto

# 依赖：直接复用 shipping-auto 的 node_modules（首次才需要）
cp -r ../shipping-auto/node_modules ./node_modules
```

### 第一次用（推荐顺序）

```bash
# ① 探测：只勾第一行 + 打开抽屉 + 展开日期/时间面板，绝不提交
npm run probe:reuse

# ② 演练：完整走一遍，但到「确认发货」前停下
npm run dry

# ③ 正式跑
npm run auto:reuse
```

所有命令默认复用 `shipping-auto/.pw-profile` 中前置登录保存的 Chrome 状态，
免去重新扫码/登录。`probe:reuse` / `auto:reuse` 保留为兼容命令；CLI 如需其他目录，可显式传 `--profile=<dir>`
（脚本会等你最多 5 分钟）。

### 常用命令

| 命令 | 作用 |
|---|---|
| `npm run probe` | 探测模式，输出 DOM 结构与截图，**绝不提交** |
| `npm run dry` | 演练模式（= `--dry --debug`），到「确认发货」前停下 |
| `npm run auto` | 正式执行 |
| `npm run auto:debug` | 正式执行 + 详细日志 |
| `npm run probe:reuse` | 复用登录态做探测 |
| `npm run auto:reuse` | 复用登录态正式执行 |

---

## 3. 命令行参数

参数写法在 cmd / PowerShell / Git Bash 下一致（也可以走同名环境变量）。

| 参数 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `--boxes=1` | `BOXES` | `1` | 发货总箱/包数 |
| `--max-rounds=200` | `MAX_ROUNDS` | `200` | 最多处理多少单 |
| `--slowmo=120` | `SLOWMO` | `120` | 每步延迟（毫秒），页面卡就调大 |
| `--profile=<dir>` | `PROFILE` | `../shipping-auto/.pw-profile` | Chrome 配置目录，默认与前置登录和创建发货单共用 |
| `--cdp=http://127.0.0.1:9222` | `CDP` | 空 | 复用已开调试端口的 Chrome |
| `--keep-open` | — | 关 | 跑完不关浏览器（默认关掉，好让脚本正常退出） |
| `--dry` | `DRY=1` | 关 | 演练，不点「确认发货」 |
| `--debug` | `DEBUG=1` | 关 | 详细日志（含每次状态轮询的变化） |
| `probe` | — | — | 子命令式开关，进探测模式 |

示例：

```bash
node index.js --profile=../shipping-auto/.pw-profile --boxes=1 --max-rounds=5 --debug
node index.js --keep-open --debug          # 跑完留窗口看现场
```

---

## 4. 页面锚点（2026-10 实测）

beast design + 商家后台，这些选择器比按文案找稳得多：

| 元素 | 选择器 |
|---|---|
| 抽屉容器 | `[data-testid="beast-core-drawer"]`，标题 `.index-module__title-text___2lZPs` = 「装箱发货」 |
| 批量装箱发货 | `button[data-tracking-id="R2Lild75FOBx_5nw"]` |
| 发货总箱/包数 | `#expressPackageNum input` |
| 发货仓库 | `#deliveryAddressId` |
| 物流公司 | `#expressCompanyId`（Select，未加载完时带 `ST_headDisabled`） |
| 预约取货日期 | `#expectPickUpGoodsDate input`（仓库信息回来前是 `disabled`） |
| 预约取货时间 | `#expectPickUpGoodsTime input`（同上） |
| 发货方式 | `#deliverMethod` |
| 确认发货 | `button[data-tracking-id="KJ_BATCH_SHIP_CONFIRM_BTN"]` |
| 行复选框 | `label[data-testid="beast-core-checkbox"][data-checked="true|false"]` |
| 列表数据行 | `tbody tr` 中文本含 `FH\d{8,}` 的行（表头/提示行自然被过滤） |

---

## 5. 实测踩到的坑（都已在代码里绕过）

### 5.1 物流公司的值读不到

`#expressCompanyId` 的 `input.value` 是**空的**——它只是个搜索框，真实选中的值
直接渲染成一段可见文本：`圆通专揽特惠 商家预估承担：1.14-1.2元`。

`fieldState()` 做了三级兜底：`input.value` → `.IPT_mirror` → 字段容器可见文本（去标签、掐掉右侧费用说明）。
早期只读 `input.value`，导致白白死等 60 秒。

### 5.2 预约取货时间是「双列滚轮」

不是下拉列表，格子也不是 `19:00` 这种文本，而是**小时列 + 分钟列，每格只有裸数字**：

```
ul[class*="TPK_ul"]  →  li[class*="cIL_item"]（禁用时带 cIL_disabled）
```

已经过去、或不足 1 小时的时段会被置灰。所以「最近可选」= **每列第一个不带 disabled 的格子**，
实际效果约等于「当前时间 + 1 小时」（实测 18:56 跑 → 自动选出 `19:56`）。

`pickTimeWheel()` 先点小时列、再点分钟列；点完小时列后分钟列的可用集合可能变化，所以每列都重新查一次。

### 5.3 日期面板不能全页找数字

抽屉里还有「已选发货单 1」「序号 1」这类数字。`pickFirstInPanel()` 先把浮层找出来
（`absolute/fixed`、可见、有面积、离触发框最近），只在浮层内部挑 `1~31` 且非禁用的格子，
取「从上到下、从左到右第一个」；面板内凑不够候选才退回全局。

### 5.4 字段定位不能靠「向上找标签」

Beast 表单嵌套十几层，早期从 `input` 往上只找 6 层祖先，完全够不着标签 → 全部字段定位失败。
现在直接用 form-item 的 `id`（见上表）。

### 5.5 别把抽屉标题当成确认框

抽屉标题「装箱发货」会被提示词正则命中，误判出「弹了确认框」。`findConfirmDialog()`
要求容器里有「确认/确定」按钮、且不是抽屉本体；提交后的二层确认气泡还必须带 `？` 才点，
避免把抽屉里的「确认发货」本体再点一遍。

### 5.6 脚本跑完不退出

浏览器不关，node 会一直挂着。现在默认收工关浏览器，要留窗口加 `--keep-open`。

> 副作用：如果上次留了窗口没关，配置目录被占用，下次启动会报
> `browser is already running in a session using this profile`。
> 解决：关掉那个 Chrome 窗口（或杀掉带 `--user-data-dir` 的 chrome 进程），再跑。

---

## 6. 运行产物

所有截图落在 `./shots/`，文件名 `${名字}-${时间戳}.png`：

| 模式 | 文件名 | 看什么 |
|---|---|---|
| probe | `probe-list-*` | 列表有没有识别到数据行 |
| probe | `probe-drawer-*` | 抽屉有没有打开、字段填了什么 |
| probe | `probe-date-panel-*` / `probe-date-picked-*` | 日期面板结构 / 选中的日期 |
| probe | `probe-time-panel-*` / `probe-time-picked-*` | 时间滚轮结构 / 选中的时间 |
| probe | `probe.html` | 整页 DOM 快照，排查选择器用 |
| 正式 | `round-N-list-*` | 第 N 轮开始时的列表状态 |
| 失败 | `*-fail-*` / `warehouse-timeout-*` / `pre-submit-check-*` / `submit-fail-*` | 卡在哪一步的现场 |

---

## 7. 自动停止条件

脚本不会无限重试，遇到下面任一情况就停：

| 条件 | 日志 |
|---|---|
| 列表无待处理数据 | `✅ 列表已无待装箱数据，全部处理完成` |
| 连续 2 轮失败 | `✗ 连续 2 轮失败，停止，保留现场请人工检查` |
| 同一 `FH` 单号第二次出现在首位 | `⚠️ 这个单号刚才处理过…可能没提交成功，停止` |
| 达到 `--max-rounds` | 正常退出 |

「同一单号二次出现」基本等于上一单没提交成功（列表没刷新掉），此时硬跑就是死循环，所以直接停。

---

## 8. 排错对照表

| 现象 | 大概率原因 | 怎么办 |
|---|---|---|
| 启动即报 profile 被占用 | 上次的 Chrome 窗口没关 | 关掉那个窗口重跑，或换 `--profile=./.pw-profile2` |
| 卡在「未登录」 | 配置目录里没登录态 | 在弹窗里手动扫码登录（脚本会等 5 分钟） |
| `⚠️ 没识别到行` | 列表为空 / tab 选错 / 页面结构变了 | 看 `shots/probe-list-*.png` |
| 抽屉打不开 | 按钮 `data-tracking-id` 变了 | 重跑 `npm run probe` 生成 `probe.html` 核对 |
| `仓库信息没加载全` | 接口慢 / 仓库无可用物流 | 看 `shots/warehouse-timeout-*.png`，多半要人工处理这单 |
| 日期框一直 `disabled` | 发货方式不是「在线物流下单」 | 脚本会自动跳过该字段；若仍禁用则这单需要人工 |
| `✗ 提交前检查未过` | 箱数/日期/时间没落上 | 看 `shots/pre-submit-check-*.png`，属于保护性中止 |
| `✗ 抽屉没关` | 必填校验拦下 / 库存或时效异常 | 看 `shots/submit-fail-*.png` 和 toast |

---

## 9. 已知限制

1. **「确认发货」的成功判据未做实机验证**：链路已实测到「确认发货」前一步
   （勾选 → 批量装箱发货 → 箱数 → 仓库就绪 → 日期 → 时间滚轮 → 物流公司），
   提交本身因为会真实生成发货单 + 取货预约，只在逻辑层实现（抽屉关闭 = 成功）。
   建议先用 `npm run dry` 走一遍，再用 `--max-rounds=1` 跑一单确认。
2. **一次只处理一张单**：会主动清掉其他勾选，避免「同仓库一起装箱」把多张单合并。
3. **物流公司不指定具体公司**：优先等平台自动带出（通常选运费低/时效快的那家），
   等不到才手动选下拉第一项。要固定某家需另加逻辑。
4. **页面改版会失效**：所有锚点都写在 `index.js` 顶部的 `SEL` 常量里，改版后只需改这里。

---

## 10. 文件结构

```
packing-auto/
├── index.js       # 全部逻辑（选择器集中在 SEL，配置集中在 CFG）
├── package.json   # npm scripts
├── docs.md        # 本文档
├── node_modules/  # 复用 shipping-auto
├── .pw-profile/   # 旧独立目录（默认改为使用 ../shipping-auto/.pw-profile）
└── shots/         # 截图与 DOM 快照
```

`index.js` 也可被 require（已 `module.exports` 暴露 `CFG / SEL / collectRows / selectRow /
clickBatchPack / fieldState / fillBoxCount / waitWarehouseReady / setPickupNearest / submitDrawer` 等），
方便在其他脚本里复用这些原子操作。
