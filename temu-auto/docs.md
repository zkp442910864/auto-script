# Temu 贴纸采集

从项目根目录运行 `npm run collect:temu`，或启动控制台后点击「Temu 贴纸商品 → 开始采集」。默认 200 条，`--limit=10` 可先采少量。

- 固定 URL：`https://www.temu.com/search_result.html?search_key=%E8%B4%B4%E7%BA%B8`。
- 主图为图片 URL；价格保留币种及展示文本；评分与销量按页面原文提取，不将销量的 K/万等近似展示转换成精确整数。
- 商品 ID 去重，保持首次出现顺序。增量滚动以兼容懒加载/虚拟列表，识别中文或英文加载更多按钮。
- 数据每批原子替换写入 `data/temu-*.json` 和同名 CSV；停止也保留部分结果。JSON `status=complete` 表示达到数量，字段完整性另看 `missing`；页面无更多结果用 `partial`，CLI 退出码 2。
- 验证/登录会触发桌面通知并持续等待，不设自动放弃时间。浏览器保持可操作；处理后自动检测恢复。未知弹窗/加载停滞则需要点击控制台「继续采集」或在 CLI 按回车。
- Ctrl+C、控制台停止或关闭浏览器可结束等待并保存。强制杀进程只保留最近一次写入批次。
- 默认复用本目录 `.pw-profile/`，与商家后台配置独立。macOS 通知需系统允许脚本编辑器/osascript，Windows 10+ 使用 PowerShell WinRT toast，通知被系统屏蔽时仍有控制台提示。

可选解压扩展：安装 `npx playwright-core install chromium` 后，`node index.js --extension="绝对扩展目录"`。该目录须包含 manifest.json。使用独立 `.pw-profile-chromium/`；默认 Chrome 已保留扩展功能，但新版 Chrome 不支持脚本侧载本地扩展。

选择器使用商品链接 `goods_id` / `-g-ID.html` 识别卡片，不依赖易变的散列类名。价格/评分/销量优先使用语义属性，退回到卡片展示文案。JSON 保留 `rawText` 供站点改版时核对；若商品页结构改变，需要登录后检查提取结果。当前真实站点只验证到登录页，完整 200 条及字段质量需登录后验证。
