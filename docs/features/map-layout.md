# 线路地图布局：一屏固定 + 左侧线路栏（Map Layout，ML）

状态：**Done**（Product Owner 2026-11-12 批准并授权实现 ML-T1..T3；三项已实现并通过 Claude review；Product Owner 2026-11-12 预览签字并批准提交）

设计稿：https://claude.ai/artifact/GmZW6EahydTfie5mjbDte6 画布第三排「线路地图 · 新布局（基于 D）」（可点击；地图色块只是示意）。

## 1. 目标

Product Owner 2026-11-12：喜欢方案 D（地图 + 列表分屏）的效果；先只改**线路地图** tab（`/map`），线路档案页不动。

核心问题：现在 `/map` 页面整体会滚动。地图高 78vh，上面还有标题、筛选栏和若干提示行，右侧栏（线路列表、当前邮编、线路概览、覆盖率、冲突、缺少边界的邮编）一层层往下堆，所以页面会比一屏高。在地图附近滚动时页面被带着滚，地图跑出屏幕。

要求：

- **整页高度 = 浏览器窗口，页面本身不滚动。**
- 鼠标在地图上滚动 = 缩放地图，地图始终在原位、完整可见。
- **只有线路列表可以上下滚动。**

这是 MVR 第 7 节中“布局：地图改为左侧栏 + 全屏地图”一项，现在由 Product Owner 决定。

## 2. 范围与不变项

只改前端布局和呈现：

- **不变：** `/api/route-map*`、数据、选择 / 淡化 / 聚焦 / 过滤的判定逻辑、着色模式和颜色分配（MVR / MVR-P2）、搜索规则、仓库层与仓库管理、按日期查看（DV）、数据状态 / 更新记录、tooltip 内容、线路编号标签规则、价格明细弹窗。
- 沿用 MVR 的约束：**不新增 web 文件、不新增 import 路径**（静态文件白名单），不新增依赖。
- 现有元素 id 尽量保留（JS 按 id 查找）；移动 DOM 位置可以，改 id 时同步改 JS 和测试。
- 底图（Protomaps light + MVR-P2 D1 滤镜）**不变**。设计稿中的深色地图只是占位，是否换深色底图另议（ML-Q2）。
- 线路档案页（`/`）不变。

## 3. 布局规格（宽度 ≥ 751px）

### ML-A 页面骨架

- `.map-page` 改为一屏应用骨架：高度 `100dvh`（回退 `100vh`），`overflow: hidden`，纵向 flex：顶栏 + 主体。`body` 在地图页不出现纵向和横向滚动条。
- 去掉地图页 `main` 的外边距和 max-width 限制（已是 `max-width: none`），地图贴边铺满。

### ML-B 顶栏（一行）

- 高度约 56–64px，从左到右：品牌 / 标题、页面切换（线路档案 / 线路地图）、筛选（片区、站点、DSP、日期——日期字段仍按 DV 规则显示或隐藏）、右侧：DMS 快照时间（`#map-updated`）、`#map-data-actions`（更新记录等）、`管理仓库`。
- 宽度不够时：先缩小筛选框的最小宽度（`min-width` 从 160px 降到约 110px），再允许顶栏换成两行；**不允许出现横向滚动**。顶栏换行后主体高度自动减少，仍然一屏。
- 原来独立的 `.map-toolbar` 卡片合并进顶栏；页面切换使用分段按钮样式（设计稿），颜色沿用现有深色主题变量。

### ML-C 主体：左侧线路栏 + 地图

- 主体为横向 flex，占满剩余高度（`flex: 1; min-height: 0`）。
- **左侧线路栏**（`aside.map-sidebar`，从右侧移到左侧）：宽度约 360–380px，纵向 flex：
  1. 固定头部：搜索框（`#map-search`）、搜索提示 / 消息（`#map-search-hint`、`#map-search-message`）、一行“N 条线路”。
  2. **滚动区：`#map-routes`**，`flex: 1; min-height: 0; overflow-y: auto`。去掉现在的 `max-height: 360px`。这是整页唯一的滚动区。
  3. `#map-no-match` 显示在滚动区内。
- **地图**（`#route-map`）：`flex: 1; min-width: 0`，高度 100%，去掉 `78vh` / `min-height: 480px`。
- 地图容器尺寸变化时（窗口缩放、顶栏换行）调用 `map.invalidateSize()`，避免出现灰色未渲染区域。可用 `ResizeObserver` 或现有 resize 处理；不新增文件。

### ML-D 线路列表行内容

每行仍是现有的 `button.map-route`（`aria-pressed`、点击选中、选中后 `scrollIntoView({block:'nearest'})` 不变），改为两行信息：

- 左：当前模式色块（`map-swatch`，竖条样式，颜色规则不变）
- 中：第 1 行线路名（片区总览搜索时仍显示“站点 · 线路名”）；第 2 行 `DSP · N ZIP`
- 右：第 1 行 PPH（2 位小数）；第 2 行领件量（整数，千分位）。值为空显示 `—`。
- 最右：难度徽章（S/A/B/C/D/未知，颜色用 `difficulty.js`），**所有模式都显示**（现在只有难易度模式显示等级）。
- 数据来自路由数据中已有的 `dsp_name`、`zip_count`、`pph`、`pickup_volume`、`route_difficulty`，不改 API。
- **首公里距离不显示**：地图 API 的线路数据里没有该字段（ML-Q1）。
- 分组规则不变：片区总览的站点组头、按 DSP 模式的公司代码组头（MVR-P2 P2-3）保留，组头在滚动区内随列表滚动。

### ML-E 地图上的浮层

所有浮层都在地图容器内绝对定位，不改变页面高度：

| 位置 | 内容 |
|---|---|
| 左上 | Leaflet 缩放、定位 / 显示全部线路（现有控件，不变） |
| 右上 | 着色模式按钮 + 图例（MVR-E / P2-3 的面板，**从右下移到右上**） |
| 顶部居中 | 提示横幅栈（ML-F） |
| 右下 | 选中详情卡片（ML-G），位于 Leaflet 署名上方，不遮挡署名 |
| 左下 | 仓库图例（现有）+「地图覆盖率 · 缺少边界的邮编」按钮（ML-H） |

浮层之间不能互相遮挡；地图高度较小（例如 1366×768 窗口）时，详情卡片内部可以滚动（`max-height` 约为地图高度的 60%），图例按 MVR-E 的规则内部滚动。

### ML-F 提示与状态信息

- `#map-message`（加载中 / 错误）、`#map-retry`、`#map-basemap-message`、`#map-warehouse-message`、`#map-warehouse-notice`、`#map-date-notice`（DV）、`#data-status` 的文字部分，统一放进地图顶部居中的横幅栈（半透明深色底，最大宽度约 640px，可逐条换行）。
- 空的提示不占位（沿用 `:empty` 隐藏规则）。
- 加载中 / 加载失败时，横幅显示在地图上方，重试按钮可用。
- `data-status.js` 是线路档案页和地图页共用的；只通过 `/map` 页面上的 DOM 位置和 `.map-page` 范围内的 CSS 调整，不改它在线路档案页的表现。

### ML-G 选中详情卡片（右下）

- `#map-summary-panel`（线路概览）和 `#map-zip-panel`（当前邮编）从侧栏移到地图右下的浮动卡片容器，内容、字段、价格明细按钮、清除选择按钮（`#map-clear`）和显示 / 隐藏规则**全部不变**。两者同时存在时，邮编在上、线路在下，容器内部可滚动。
- 卡片宽度约 340–360px，样式参考设计稿（深色半透明、圆角 12px）。
- 没有选择时卡片不显示。

### ML-H 覆盖率与数据质量

- 侧栏中的「地图覆盖率」面板、`#map-conflicts-details`、`#map-missing-details`、ZCTA 说明（`boundaryNote`）收进一个面板，由地图左下角按钮打开（按钮文案：“地图覆盖率 · 缺少边界的邮编”，可显示覆盖率数值，例如“覆盖率 96%”，数值取现有 `#map-coverage` 的结果）。
- 面板为浮动层（从左下向上展开），内部可滚动，内容和 id 不变；可用 `<details>` 或按钮 + `aria-expanded` 实现，键盘可操作，Esc 关闭。
- 有冲突时，按钮上显示一个小提示点（沿用 `.map-warning` 颜色），避免信息被藏起来后没人注意。

## 4. 窄屏（≤ 750px）

Claude 2026-11-12 决定（ML-Q3，Product Owner 可改）：手机宽度下顶栏筛选会换成多行，一屏骨架会让地图太小，因此：

- 恢复普通页面滚动；顺序为顶栏 → 地图（高度 `60dvh`，最小 360px，同现在）→ 线路栏。
- 线路列表保持自己的滚动区，最大高度约 `60dvh`。
- 详情卡片在地图下方、线路栏上方按普通流式显示（不再浮在地图上）；覆盖率面板同理。
- 不出现横向滚动；图例不挡缩放按钮和署名（MVR-AC6 继续适用）。

## 5. 边界情况

- 加载中 / 失败 / 无数据：地图区域保持占位高度，横幅显示状态；线路栏显示空状态，不出现页面滚动。
- 搜索无结果：`#map-no-match` 显示在滚动区内。
- 线路很多（片区总览，几百条）：只有列表滚动；选中线路后自动滚动到可见位置。
- 窗口很矮（< 600px 高）：顶栏 + 地图仍然一屏；详情卡片和图例内部滚动；可以接受线路栏可见行数较少。
- 浏览器缩放 125% / 150%：同上，不出现页面滚动。
- 价格明细、更新记录、仓库管理等 `<dialog>` 仍按现在方式全局弹出，不受骨架 `overflow: hidden` 影响。

## 6. 验收标准

- **ML-AC1** 宽度 ≥ 751px（检查 1920×1080、1440×900、1366×768）时，`document.documentElement.scrollHeight === innerHeight`，`scrollWidth === innerWidth`；在地图上滚动只会缩放地图，地图的 `getBoundingClientRect()` 不变。
- **ML-AC2** 线路栏在左侧；只有 `#map-routes` 可以纵向滚动（`scrollHeight > clientHeight` 且 `overflow-y: auto`）；搜索框固定在滚动区上方。
- **ML-AC3** 顶栏按 ML-B 包含标题、页面切换、全部筛选、快照时间、数据操作、管理仓库；宽度不够时换行，不出现横向滚动；换行后仍然一屏。
- **ML-AC4** 列表行按 ML-D 显示线路名、DSP、ZIP 数、PPH、领件量和难度徽章；空值为 `—`；色块颜色跟随着色模式；站点组头 / DSP 组头保留。
- **ML-AC5** 着色模式与图例在右上，选中详情卡片在右下且不遮挡署名，缩放 / 定位在左上，仓库图例和覆盖率按钮在左下，互不遮挡（四个尺寸下检查矩形不相交）。
- **ML-AC6** 详情卡片内容、价格明细按钮、清除选择与改动前一致；无选择时隐藏；邮编 + 线路同时存在时容器内部可滚动。
- **ML-AC7** 覆盖率按钮打开的面板包含覆盖率、冲突、缺少边界的邮编和 ZCTA 说明，id 不变；键盘可打开 / 关闭（Esc）；有冲突时按钮有提示点。
- **ML-AC8** 加载中、失败（含重试）、按日期查看提示、仓库提示、数据状态都显示在地图顶部横幅，空时不占位，不造成页面滚动。
- **ML-AC9** 窗口缩放或顶栏换行后地图无灰色未渲染区域（调用了 `invalidateSize`）。
- **ML-AC10** ≤ 750px 按第 4 节：普通滚动，地图 → 详情 → 线路栏，无横向滚动，390px 下图例不挡缩放和署名。
- **ML-AC11** 现有功能不变（`AGENTS.md` 第 5 节、MVR-AC7、P2-AC4..7）：站点 / DSP / 日期筛选、线路和邮编选择、搜索（含 5 位邮编）、tooltip、四种着色模式、DSP 图例点击、仓库层与管理、更新记录、定位按钮。`npm test` 全部通过；因 DOM 位置改变而失效的断言逐条说明。
- **ML-AC12** Claude 在 Chrome 中检查北加片区总览和 SFO01；Product Owner 预览签字。

## 7. 测试要求

- 静态 / DOM 测试：`map.html` 中的结构（顶栏、左侧栏、滚动区、浮层容器、横幅栈、覆盖率面板）和保留的 id。
- CSS 测试：`.map-page` 一屏骨架、`#map-routes` 为唯一滚动区、`#route-map` 不再使用 `78vh`、≤750px 规则。
- 列表行渲染：字段、空值、难度徽章在四种模式下都显示、分组头保留。
- 浏览器检查（Playwright headless，使用已运行的本地服务，不重启服务）：ML-AC1 / AC5 / AC10 的尺寸和矩形数据，记录在实现记录中，截图只保存在 `.handoff/`。

## 8. 影响与风险

- 地图页 DOM 结构变化较大，`route-map-web.test.js` 中按位置 / 结构的断言可能要更新；行为断言不能删。
- `map-view.js`（643 行）、`map-panel.js` 已较大（`docs/tech-debt.md`）。本次以 HTML / CSS 为主，JS 只改列表行渲染和 `invalidateSize`；不顺带重构。
- 原来提示行在页面流里，现在浮在地图上，可能遮挡地图顶部的一小部分；横幅宽度受限并可在加载完成后消失。
- `data-status.js` 两个页面共用，改动需要限定在 `.map-page` 范围内。

## 9. 任务拆分

| 任务 | 内容 | 授权 |
|---|---|---|
| ML-T1 | ML-A/B/C/F：一屏骨架、顶栏、左侧栏 + 唯一滚动区、提示横幅栈、`invalidateSize`、≤750px 规则（第 4 节中与骨架相关的部分） | 待授权 |
| ML-T2 | ML-D：列表行内容 | 待授权 |
| ML-T3 | ML-E/G/H：浮层位置（图例移到右上）、选中详情卡片、覆盖率面板；≤750px 下的流式显示 | 待授权 |

T1 → T2 → T3 顺序执行，每步 review 后再进行下一步。

## 10. 实现记录（Implementation Notes）

### ML-T1（2026-11-12）

- 仅调整 `/map`：合并顶栏；桌面使用 `100vh` / `100dvh` flex 骨架，370px 左侧栏；移动状态信息到 Leaflet 外层的顶部横幅栈。未改 API、数据、着色、搜索或仓库业务逻辑。
- `#map-routes` 为主要滚动区，新增内部 `#map-route-items` 承载原有行渲染，使 `#map-no-match` 始终保留在滚动区中；计数使用实际渲染的线路数，文案在 `map-text.js`。固定搜索头部，其他面板暂放侧栏下方独立滚动区；线路面板和其他面板按 85% / 15% 分配可用空间，T3 再处理浮层。
- 在地图初始化附近使用 `ResizeObserver` 观察外层，调用 `invalidateSize({ pan: false })`；手机恢复普通页面滚动，地图高 `60dvh`（最小 360px），线路列表限制为 `60dvh`。
- 测试适配：R1b 的旧 `78vh`、列表 `360px` 上限、手机旧高度断言由 ML 一屏和手机规则断言替代，旧 grid 布局断言改为新 flex 骨架断言；保留字体、颜色、搜索、选择、价格详情等行为断言。地图 fixture 增加计数并映射内部行容器；价格面板 fixture 同步补充新节点。
- 使用已运行的 `http://127.0.0.1:3000/map` 和已有 Playwright headless Chromium 检查，未启动、停止或重启服务。桌面 `scrollWidth × scrollHeight`：1920×1080 → 1920×1080；1440×900 → 1440×900；1366×768 → 1366×768；额外 751×768 → 751×768。390×844 → 390×1683，符合手机普通纵向滚动且无横向溢出。五个尺寸滚轮缩放前后地图矩形一致；左栏桌面 x=0，列表 overflow-y=auto，未捕获页面 JavaScript 错误。尺寸记录保存在 `.handoff/ML-T1-browser.json`，缩放截图在 `.handoff/ML-T1-resize.png`。
- 实测 SFO01 37 条线路，计数为 37。相关测试 70/70 通过；完整测试结果见本节后续记录。无 lint 配置或 build 命令。PowerShell 禁止执行 `npm.ps1`，通过 `npm.cmd test` 运行项目测试。
- 本次只覆盖 AC1、AC2、AC3、AC8、AC9、AC10 的骨架部分及 AC11；T2/T3 和人工预览签字仍待后续任务。
- 最终检查：`npm.cmd test` 859/859 通过，0 失败、0 跳过；调整临时面板空间比例后再次运行地图及价格相关测试，70/70 通过；`git diff --check` 通过。未执行 commit、push 或部署。

### ML-T2（2026-11-12）

- 在 T1 未提交改动基础上，仅修改列表行呈现、文案、样式和相关测试。每行显示线路名、DSP / ZIP 数、两位小数 PPH、整数千分位领件量和四模式常驻难度徽章；缺失指标、DSP 和未知难度显示 `—`。首公里距离不显示，API、数据、过滤、分组、排序、搜索和着色规则不变。
- 继续使用已有 difficulty.js / format.js 导入。难度徽章采用 difficultyColor，S/A/C 白字，B/D/未知使用 #111827 深色字；测试覆盖六种颜色的文字对比度均 ≥4.5:1。模式色块为 4px 竖条。列表样式限制在 .map-page，删除旧 span:nth-child(2)、span:last-child 和 map-level 规则。按钮提供包含线路名、DSP、ZIP 数、PPH、领件量、难度的 aria-label。
- 断言适配逐项：RM5 难度文字定位从 children[2] 改为徽章 children[3]；两处 Mock-C 名称断言改为 info 内的 title；MVR-T6 模式色块匹配、同名线路断言和 DSP 排序断言改为读取 info 内的 title。未删除行为断言；站点 / DSP 组头、aria-pressed、点击和 scrollIntoView({block:'nearest'}) 继续由原有测试验证。新增 ML-T2 测试覆盖字段、缺失值、四模式徽章与色块、无障碍名称和对比度。
- 使用已运行的 http://127.0.0.1:3000/map 和已有 Playwright headless Chromium；未安装依赖、未启动 / 停止 / 重启服务。1440×900 与 390×844 均显示 SFO01 的 37 条线路，行高 60px；页面 scrollWidth 分别为 1440 / 390，列表 clientWidth / scrollWidth 分别为 344 / 344、364 / 364，无横向溢出，未捕获页面 JavaScript 错误。已查看两张截图，列表内容可读。记录：.handoff/ML-T2-browser.json；截图：.handoff/ML-T2-1440.png、.handoff/ML-T2-390.png。
- 检查：地图 DOM / 单元测试 65/65 通过；npm.cmd test 全量 860/860 通过，0 失败、0 跳过；git diff --check 通过（仅现有 LF/CRLF 提示）。无 lint 配置或 build 命令。测试日志：.handoff/ML-T2-targeted.log、.handoff/ML-T2-tests.log。
- 本任务实现 ML-AC4，并通过自动化回归检查本任务涉及的 ML-AC11；全部人工业务流程未逐项复测。ML-T3、Claude review 与 Product Owner 预览签字仍待后续处理。未 commit、push 或部署。

### ML-T3（2026-11-12）

- 在 T1/T2 未提交改动上，移除临时 `.map-sidebar-details`；侧栏仅保留固定搜索头部和占满余高的 `#map-routes`。邮编、线路面板按此顺序移入 Leaflet 外的右下详情卡片，保留原有 id、字段、价格详情和清除按钮移动逻辑；空选择隐藏整个容器。图例沿用原 Leaflet control，位置改为 `topright`。
- 覆盖率、冲突、缺少边界邮编和 ZCTA 说明移入左下面板；按钮使用 aria-expanded / aria-controls，支持点击、键盘 Enter 和 Esc 关闭返回焦点；关闭覆盖率时保留地图选择。文案读取已经格式化的覆盖率值，冲突提示点跟随原冲突面板 hidden 状态。卡片、覆盖率和图例阻止滚轮事件传播。
- 桌面卡片宽 350px，高度不超过地图 60%，并预留右上图例空间；覆盖率面板最高约 70%，额外限制高度以避开左上控件。横幅左右留出控件空间。≤750px 使用普通流式顺序：顶栏 / 状态提示、地图、详情、线路栏、覆盖率；隐藏覆盖率按钮，内容直接展开。
- 断言适配：图例线路说明由“右侧列表”改为“左侧列表”；原 MVR 图例手机 `margin-bottom: 32px` 断言改为手机紧凑宽度断言，因为图例已移到右上，无需为底部署名留白。未删除选择、筛选、价格或搜索行为断言。新增 DOM、侧栏范围、面板切换、aria-expanded、Esc 返回焦点且保留选择、冲突点、卡片隐藏和滚轮阻止传播测试。
- 使用已有 Playwright headless Chromium 和正在运行的 http://127.0.0.1:3000/map?station=SFO01；未安装依赖、未启动 / 停止 / 重启服务。每个尺寸先选择 SFO01 线路，再点击地图 ZIP，并打开覆盖率面板（手机直接展开）。三个桌面尺寸 scrollWidth × scrollHeight 分别为 1920×1080、1440×900、1366×768；390×844 为 390×2651，只有纵向页面滚动。四个尺寸各浮层有效矩形两两相交结果均为空，未捕获页面 JavaScript 错误。矩形、滚动尺寸完整记录：`.handoff/ML-T3-browser.json`；截图：`.handoff/ML-T3-1920.png`、`ML-T3-1440.png`、`ML-T3-1366.png`、`ML-T3-390.png`，已查看 1366px 和 390px 截图。
- 桌面详情卡片矩形（x,y,width,height）：1920px 为 (1560,435.45,350,614.55)，1440px 为 (1080,431.25,350,438.75)，1366px 为 (1006,431.25,350,306.75)。1366px 实测卡片 clientHeight=305、scrollHeight=782，可内部滚动；卡片滚轮前后地图矩形均为 (370,101.25,996,666.75)，地图 pane 未改变。真实键盘 Enter 打开、Esc 关闭返回焦点且保留选择、价格详情打开及关闭、清除选择隐藏容器均通过；记录 `.handoff/ML-T3-interactions.json`。浏览器脚本最初用 Esc 退出价格弹窗，触发既有全局清除选择，造成后续点击超时；最终改用价格弹窗自己的关闭按钮完成验证，未修改弹窗业务逻辑。
- 检查：`npm.cmd test` 全量 862/862 通过，0 失败、0 跳过；最后补充图例滚轮阻止传播后，地图 / 价格相关测试再次 73/73 通过。`git diff --check` 通过，仅 LF/CRLF 提示。无 lint 配置或 build 命令。日志：`.handoff/ML-T3-tests.log`、`.handoff/ML-T3-targeted.log`。
- 本任务涉及 ML-AC1/2/5/6/7/10 的实现及自动化检查通过，ML-AC11 全量回归通过；所有人工业务流程未逐项复测。Claude review 和 Product Owner 预览签字仍待进行，不将 ML-AC12 标记完成。无 API、数据或 schema 变更，未 commit、push 或部署。

### ML-T3 第 1 轮修复（2026-11-12）

- 最终检查：`npm.cmd test` 全量 864/864 通过，0 失败、0 跳过，日志 `.handoff/ML-T3-r1-final-tests.log`；`git diff --check` 通过，仅 LF/CRLF 提示。首次测试时新增断言中的占位符经 PowerShell 管道写成问号而失败，已修正实际 UTF-8 字符并重新运行全量测试通过。
- 修正覆盖率按钮空值判断：空字符串或 `—` 使用 coverageToggle，已有数值继续使用 coverageToggleValue。文件保持 UTF-8，占位符确认为 U+2014；新增加载前 clear 和 total=0 的按钮文案断言。
- 仅在详情卡片和覆盖率面板内收紧字号：h2 为 16px / 600，覆盖率和邮编号码为 22px，详情指标 dd 为 16px（排除 difficulty，保留徽章）；窄屏沿用同样字号。新增 CSS 断言，未删除原有行为断言。
- 使用现有本地服务和 Playwright headless，未重启服务或安装依赖。1366×768 下选中 SFO01 线路和 ZIP、展开覆盖率：页面 scrollWidth / scrollHeight 为 1366 / 768，浮层矩形两两相交为空，无页面 JavaScript 错误。截图 `.handoff/ML-T3-r1-1366.png` 已查看；矩形记录 `.handoff/ML-T3-r1-browser.json`。详情卡片保留内部滚动。
- 无数据、API 或 schema 变更，无 lint / build 命令。未 commit、push 或部署；本轮未重跑其他尺寸的浏览器检查，Claude review 和 Product Owner 预览签字仍待完成。
