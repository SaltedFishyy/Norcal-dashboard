# 线路档案布局：一屏固定 + 左侧线路栏 + 右侧详情（Profile Layout，PL）

状态：**Done**（Product Owner 2026-11-12 授权 PL-T1..T5；全部经 Claude review 通过；Product Owner 2026-11-12 预览签字并批准提交）

设计稿：`.handoff/profile-ui/profile-mock-B.png`（方案 B，SFO01 真实数据；生成用的 HTML 在同目录 `mock-B.html`）。同目录下 A / C / D 是落选方案，仅作记录。

## 1. 目标

Product Owner 2026-11-12：线路档案（`/`）的 UI 改成和线路地图（`/map`，ML）同一种风格。四个方案中选 **B：地图同款**。

现状问题：

- 页面整体滚动，表格很长，标题和筛选栏会被滚出屏幕。
- 线路详情是模态弹窗（`<dialog id="route-detail">`），打开后整张表被挡住，换一条线路要先关掉弹窗。
- 视觉上和新版线路地图不一致：顶栏更高、分块更多，也没有线路颜色。

目标：

- **整页高度 = 浏览器窗口，页面本身不滚动**（≥ 751px）。
- **左侧是线路列表**，样式与地图页左侧列表一致，只有列表自己滚动。
- **右侧是选中线路的详情**，常驻显示，不再弹窗；点左侧另一条线路，右侧直接切换。
- 线路颜色条与地图上同一条线路的颜色一致（`route-colors.js`）。

## 2. 范围与不变项

只改前端布局和呈现：

- **不变：** 所有 API（`/api/route-profiles`、`/api/route-details`、`/api/route-history`、`/api/route-map/zip`、`/api/snapshot-days`、`/api/districts`）、数据、DB、抓取。
- **不变的功能：**
  - 片区 / 站点选择及记忆（`station-preference.js`）
  - DSP 筛选
  - 按日期查看（DV，含“回到最新”和“首票价格为当前报价”提示）
  - 数据状态 / 更新记录（`data-status.js`）
  - 首票价格明细弹窗（`price-detail.js`）
  - ZIP 跨站点定位：多站点选择按钮、“不在当前 DSP 筛选中 · 显示该线路”、各种未找到提示
  - 线路历史（RH）的内容和规则
- **不新增 web 文件**：新文件需要改 `server/src/api/static-files.js` 白名单并重启服务，这是停止条件。**不新增依赖。**
  - `index.html` / `app.js` 可以 import 已经在白名单里的模块（例如 `route-colors.js`）。
  - 不 import 地图专用模块：`map-state.js`、`map-panel.js`、`map-view.js`。
- 现有元素 id 尽量保留；移动或改 id 时，同步改 JS 和测试。
- 线路地图页（`/map`）不变。

## 3. 布局规格（宽度 ≥ 751px）

### PL-A 页面骨架

- `.profile-page` 改为与 `.map-page` 相同的一屏骨架：
  - 高度 `100dvh`（回退 `100vh`），`overflow: hidden`。
  - 纵向排列：顶栏 + 主体。
  - `body` 不出现纵向和横向滚动条。
- 主体是横向两栏：左侧线路栏固定 370px（与地图页一致），右侧详情区占满剩余宽度。

### PL-B 顶栏

- 与地图页 `.map-heading` 同样式（`#111d2e` 底色、紧凑高度），从左到右：
  1. 品牌、标题“线路档案”
  2. 页面切换（线路档案 / 线路地图）
  3. 筛选：片区、站点、DSP、日期（日期字段按 DV 规则显示或隐藏）
  4. 右侧：“DMS 快照，非实时 · 数据更新时间”（`#updated`）、`#map-data-actions`（更新记录）
- 窄一些时允许换成两行（与地图页相同的 `flex-wrap` 规则）。
- 去掉现在独立的“DMS 快照，非实时数据”卡片，以及“更新时间 / 线路总数”指标块。
  - 更新时间进顶栏。
  - 线路总数进左侧栏标题（PL-C）。
- 现在顶栏里的 ZIP 输入框移到左侧搜索框（PL-C）。

### PL-C 左侧线路栏

**标题行**

- 显示“线路”和条数（沿用 `#total` 的规则）：
  - 全部 DSP 时显示 `37 条`。
  - 选了 DSP 时显示 `5 / 37 条`。

**搜索框**（占位文字“搜索线路编号或邮编”）

- 输入时在当前站点内过滤列表：线路名称包含输入内容，或者某个 ZIP 以输入内容开头（用 `postal_codes` 字段）。
- 输入完整 5 位数字并按 Enter（或点搜索按钮）时，走**现有的跨站点 ZIP 定位流程**（`/api/route-map/zip`），提示文字和按钮全部沿用。
  - 定位到后：自动切换到对应片区 / 站点，选中那条线路，列表滚到这一行，右侧详情高亮这个 ZIP。
- 输入不是 5 位数字时按 Enter，提示“请输入 5 位 ZIP”，与现在相同。
- 提示信息显示在搜索框下方，取代现在的 `#profile-zip-result`。

**排序按钮**（一行小按钮，样式参考设计稿）

- 按钮：线路名（默认，即 API 返回顺序）、件量、PPH、首票价格、难度。
- 件量、PPH、首票价格沿用 `sortRows` 的现有规则：第一次点击降序，第二次升序，第三次回到默认；空值排最后。
- **难度**是新增排序：
  - 降序为 S → A → B → C → D，升序反过来。
  - 用系统难度 `route_difficulty`；无法识别的排最后；同级保持原顺序。
- 当前排序在按钮上高亮，并显示 ↓ / ↑。

**线路行**（复用 ML-D 两行样式，类名可以共用或复制）

- 左边 4px 颜色条：`routeColor(route_id)`，与地图一致。
- 第一行：线路名称。第二行：`DSP · N ZIP · 首票价格`。
  - 没有报价时不显示价格这一段。
  - 价格是普通文字，不可点击，价格明细在右侧详情里打开。
- 右侧两行数字：`PPH`、`件`（Pickup Volume）。
- 最右是难度字母徽章（S/A/B/C/D，颜色用 `difficultyColor`）。
- 行底部是一条 2–3px 的细件量条：
  - 宽度 = 本行件量 ÷ 当前可见列表的最大件量。
  - 只用一种颜色：该线路的颜色，降低不透明度。
  - 纯视觉，不带数字含义以外的规则。
- 选中行用青色边框和底色，与地图页选中样式一致。
- 整行是一个按钮，支持键盘：Tab 聚焦，Enter / 空格选中。

**滚动**

- 只有列表区域滚动（细滚动条，样式同 `#map-routes`）。标题、搜索框、排序按钮固定不动。

### PL-D 右侧详情区

详情区本身可以上下滚动（内容多时），顶栏和左侧栏不动。

**提示条**（在详情区顶部，样式同地图页 `.map-banners`）

- 数据状态 / 自动更新失败提示（`#data-status`）
- 按日期查看提示（`#profile-date-notice`）
- 有内容时才显示。

**标题区**

- 颜色条、线路名称（大号）、系统难度徽章。
- 一行说明：`站点 · DSP · Route ID · N 个 ZIP`。
- 按日期查看时，在说明后加 `· M/D 的数据`。

**标签**：概况 / 历史

- 沿用现在的 `rh-tabs`，含键盘左右切换。
- 换线路时回到“概况”。

**概况标签内容**

1. **指标卡（5 个）**：Pickup Volume、PPH、首公里距离 (mi)、首票价格、人工难度。
   - 首票价格可以点击，打开现有的价格明细弹窗；没有报价时显示 `—`。
   - Pickup Volume 和 PPH 的卡片上显示趋势小字，**用 RH 的现有规则 `summarizeMetric`**：
     - 当前值对比近 30 天平均值，±5% 以内显示“持平”。
     - 不足 3 天显示“数据不足”。
     - 否则显示 `↑ / ↓ x%`。
   - 不自己发明“对比 30 天前”之类的新规则（设计稿里的 ▲250 只是示意）。
2. **近 30 天趋势**：Pickup Volume、PPH 两张小图。
   - 数据来自 `/api/route-history?days=30`，与历史标签共用请求结果。
   - 沿用 RH 的 `sparkline`：缺失日期断开，有变化的日期画竖线。
   - 历史不可用时，显示 RH 现有的提示文字。
3. **ZIP 画像表**：列为 ZIP、领件量（日均）、熟手 PPH、ZIP 难度。
   - 领件量列前加一条横向小条（宽度 = 本行 ÷ 本线路 ZIP 最大值）。
   - 排序：按日均领件量降序，空值最后，同值按 ZIP 升序。
   - 去掉“首公里距离”列和“在每个 ZIP 行重复显示”的说明。首公里是线路级数值，已经在指标卡里。
   - ZIP 定位高亮（`zip-target`）沿用。
4. **页脚小字**：线路数据更新时间、ZIP 详情更新时间（沿用现有字段和格式）。

**历史标签**：内容与现在相同（RH：7 天 / 30 天、四张卡片、变化记录）。

**状态**

- 加载中、详情 404（“暂无 ZIP 详情”及抓取提示）、请求失败、该日没有这条线路的详情：文字沿用现有 `profileText`。
- 加载中和出错时，标题区和指标卡仍然先用列表行已有的数据显示（同现在 `basicInfo` 的做法）。
- 当前站点没有线路时，详情区显示空状态（沿用现有空数据文字）。

### PL-E 默认选中与切换

- 页面加载完成后，自动选中列表中的第一条线路。
- 换排序、换 DSP 或搜索过滤后：
  - 如果当前选中的线路仍在列表里，保持选中，并滚到可见位置。
  - 如果不在了，选中新列表的第一条。
  - 列表为空时，详情区显示空状态。
- 换片区 / 站点 / 日期时：重新加载，选中第一条（ZIP 定位流程除外，它会指定线路）。
- 快速连续切换线路时，只显示最后一次选择的结果（沿用现有 `sequence` 防串号）。
- 选中状态不写进 URL（第一版）。

### PL-F 趋势图悬停提示（Product Owner 2026-11-12 追加，PL-T4）

Product Owner 预览后追加：鼠标放在趋势图的点上时，显示那一天的日期和数值。

- **范围**：所有用 `sparkline` 画的线路趋势图，包括概况的近 30 天两张小图，以及历史标签（7 天 / 30 天）的四张图。它们共用同一个函数，交互保持一致。
- **触发**：
  - 鼠标在图上任意位置左右移动时，吸附到横坐标最近的那一天，不要求精确对准 3px 的小点。
  - 吸附到的点放大，并显示一条竖向参考线和提示框。
  - 鼠标离开图时隐藏。
  - 那一天没有数据（图上断开处）时不显示提示，不显示假数值。
  - 触屏：点按图的某处显示，再点图外隐藏。
  - 键盘：图可以获得焦点，左右方向键在有数据的日子之间移动，Esc 隐藏。
- **提示内容**：
  - 第一行：日期 `M/D`，与 RH 现有 `shortDay` 格式一致。
  - 第二行：数值加单位，格式和小数位与对应历史卡片一致：
    - 领件量：`1,478 件`
    - PPH：`PPH 23.41`
    - 首公里：`19.98 mi`
    - ZIP 数量：`8 个 ZIP`
  - 当天有变化记录（`changes`）时，再加一行，文字与历史标签“变化记录”列表一致，例如 `DSP SFO-AAS → SFO-HFE`、`ZIP +1 / −0`。
- **不变**：缺失日期断开的规则（Product Owner 2026-11-12 确认保持断开）、图的数据、统计规则、坐标计算。
- **可访问性**：保留现有 `aria-label`；提示框内容同步到一个 `aria-live="polite"` 区域，或作为图的描述，让读屏能读到当前点。
- **样式**：提示框为深色半透明小卡片，与 `/map` tooltip 风格一致；靠近图边缘时不能超出详情区，也不能被裁掉。

### PL-G 字号与强调（Product Owner 2026-11-12 追加，PL-T5）

Product Owner 预览后反馈：字体偏小、不够明显；线路名要更好读，PPH 和领件量是重要指标；“线路档案 / 线路地图”切换不明显。Claude 用注入样式出了三套对比图（`.handoff/profile-ui/font-current.png`、`font-A.png`、`font-B.png`、`font-C.png`），Product Owner 选择 **B：指标突出**。

左侧线路栏（宽度 370px → **390px**；窄屏仍 100%）：

| 元素 | 现在 | B |
|---|---|---|
| 行最小高度 / 内边距 | 60px / 7px 8px | 72px / 9px 10px，元素间距 10px |
| 线路名 | 14px | 17px，粗体 700 |
| 第二行（DSP · ZIP · 价格） | 12px | 13px |
| PPH 数值 | 14px | 19px，粗体 700，白色 |
| 件量数值 | 14px | 15px，600，`#dbe4f0` |
| 单位（PPH / 件） | 11px | 12px，常规字重 |
| 难度字母徽章 | 26px 方块，13px | 32px 方块，15px，圆角 6px |
| 细件量条 | 2px，不透明度 .35 | 3px，不透明度 .5 |

页面切换（线路档案 / 线路地图，**两个页面同一样式**）：

- 分段按钮：外框青色 `#2dd9c6` 细边，内边距 3px，按钮间距 4px。
- 每个按钮 16px、600，内边距 8px 18px，圆角 6px，未选中文字 `#cbd5e1`，悬停底色 `#1c2c42`。
- 当前页：青色实心底 `#2dd9c6`、深色文字 `#06222a`、800 字重，加一圈轻微青色发光。
- 顶栏标题“线路档案 / 线路地图”与当前页按钮重复：**视觉上隐藏**，改为 `sr-only`，保留 `<h1>` 给读屏和页面结构。

右侧详情区：

| 元素 | 现在 | B |
|---|---|---|
| 线路名标题 | 28px | 30px |
| 说明行 | 13px | 14px |
| 指标卡标签 | 12px | 13px |
| 指标卡数值 | 24px，600 | 30px，700 |
| 指标卡趋势小字 | 12px | 13px |
| Pickup Volume、PPH 两张卡 | 与其他卡相同 | 顶部 3px 青色条，底色 `#0f2230` |
| 卡片标题（近 30 天趋势 / ZIP 画像表） | 14px | 15px |
| 趋势小图标题 | 12px | 13px |
| ZIP 表单元格 | 13px | 14px |

- 不改颜色体系以外的任何内容：数据、排序、交互、布局结构都不变。
- `/map` 只改页面切换按钮的样式和标题的 `sr-only`。左侧列表、地图、浮层都不改；地图页的列表字号是否同步另议（PL-Q4）。

## 4. 窄屏（≤ 750px）

- 恢复普通页面滚动，与 ML 第 4 节相同。
- 顶栏换行；线路栏在上（列表最高 60dvh，可滚动）；详情区在下。
- 点选线路后，页面滚动到详情区顶部。
- 不再使用模态弹窗。

## 5. 涉及文件

| 文件 | 改动 |
|---|---|
| `web/index.html` | 新骨架：顶栏、左侧栏（搜索、排序按钮、列表）、右侧详情区。删除 `<table>` 和 `<dialog id="route-detail">` |
| `web/app.js` | 列表渲染、排序按钮（含难度排序）、搜索过滤、ZIP 定位接入、选中逻辑 |
| `web/route-detail.js` | 从“打开弹窗”改为“渲染到详情区”；指标卡、趋势、ZIP 表；历史标签保留 |
| `web/format.js` | `sortRows` 增加难度排序；新增文字放进 `profileText` |
| `web/styles.css` | PL 样式块；尽量复用 ML-D 行样式和 ML 骨架变量；删除不再使用的 profile 表格样式 |
| `server/test/*` | 更新 profile / route-detail / route-history-web / profile-sort / profile-zip-search 相关测试 |

## 6. 验收标准

- **PL-AC1** 1440×900 和 1280×720 下，`document.scrollingElement` 没有纵向和横向滚动；顶栏、左侧栏标题 / 搜索 / 排序固定；只有线路列表和详情区可以滚动。
- **PL-AC2** 列表行显示颜色条、名称、`DSP · ZIP 数 · 首票价格`、PPH、件量、难度字母和细件量条；颜色条与 `/map` 同一线路颜色一致。
- **PL-AC3** 五个排序按钮可用：件量 / PPH / 首票价格规则同现在；难度按 S→D 降序和反向升序，空值最后；默认顺序同 API。
- **PL-AC4** 搜索框：部分输入时按线路名 / ZIP 前缀过滤；5 位 ZIP + Enter 走跨站点定位，现有的全部提示和按钮行为不变（`profile-zip-search` 测试场景全部保留）。
- **PL-AC5** 默认选中第一条；点击行切换详情不弹窗；排序 / DSP / 过滤后选中规则符合 PL-E；快速切换不串号。
- **PL-AC6** 详情区：指标卡、趋势小字（`summarizeMetric` 规则）、30 天小图、ZIP 表（新排序、无首公里列）、更新时间；首票价格点击打开价格明细弹窗；历史标签内容不变。
- **PL-AC7** 加载、404、出错、空站点、按日期查看（含该日无此线路）各状态文字与现在一致。
- **PL-AC8** ≤ 750px 恢复页面滚动，列表在上、详情在下，没有横向滚动。
- **PL-AC9** 片区 / 站点记忆、DSP 筛选、日期视图、数据状态 / 更新记录、`/map` 页面全部不受影响；没有新增 web 文件和依赖。
- **PL-AC10** `npm test` 全部通过，`git diff --check` 通过。改动或删除的旧断言逐条说明原因。
- **PL-AC11** Chromium 截图：SFO01 默认、按件量排序、选中另一条线路、ZIP 定位（同站和跨站各一次）、历史标签、按日期查看、≤750px。console / pageerror 为 0。浏览器按 handoff 第 8 节关闭并检查无残留进程。
- **PL-AC13**（PL-T4）鼠标在概况和历史的每张趋势图上左右移动，提示显示最近有数据那天的日期、数值和单位，当天有变化记录时追加一行；无数据日不显示；离开隐藏；触屏点按和键盘左右键可用；提示不超出详情区；console / pageerror 为 0。
- **PL-AC14**（PL-T5）字号、字重、颜色、尺寸按 PL-G 表格（用计算样式断言）；两页切换按钮当前页为青色实心；`<h1>` 仍存在但视觉隐藏；1440×900 和 1280×720 仍无页面滚动，≤750px 无横向滚动；`/map` 除切换按钮和标题外无变化；console / pageerror 为 0。
- **PL-AC12** Claude 对照设计稿检查，Product Owner 预览签字。

## 7. 风险

- **`route-detail.js` 从弹窗改成常驻面板是本次最大的改动。** 焦点管理（关闭后回到触发按钮）、`cancel` / 点击外部关闭的逻辑都要去掉。要确认 ZIP 定位和历史标签的“过期请求不覆盖”逻辑仍然成立。
- **每次切换线路会多发一次 `/api/route-history?days=30` 请求。** 现在只有打开历史标签才请求。量很小（单条线路、30 行），可以接受；同一线路的概况和历史标签共用结果。
- 局域网只读服务直接从磁盘读 `web/` 文件，改完立即生效，**没有提交前同事也会看到半成品**。实现期间按 handoff 流程整批完成后再让 Product Owner 预览。

## 8. 未决问题

见 `docs/open-questions.md` 的“线路档案布局 / Profile Layout”。第一版都按默认值做：

- PL-Q1 要不要做全站点汇总（线路数、件量合计、难度分布、平均 PPH）？默认不做；平均 PPH 的算法需要 Product Owner 决定。
- PL-Q2 要不要显示地址类型分布（API 已有 `address_type_distribution`）？默认不做。
- PL-Q3 要不要加“在线路地图中查看”？`/map` 目前不支持通过 URL 打开指定线路，需要另开任务改地图页。默认不做。

## 9. Codex 任务拆分

| 任务 | 内容 | 验收 |
|---|---|---|
| PL-T1 | 骨架 + 顶栏 + 左侧线路栏：PL-A、PL-B、PL-C（列表行、排序含难度、搜索过滤、ZIP 定位接入），详情区先接现有内容（可暂时沿用旧详情渲染，但不弹窗） | AC1–AC4、AC9、AC10 |
| PL-T2 | 右侧详情区：PL-D、PL-E（标题区、指标卡、趋势、ZIP 表、历史标签、状态、选中规则） | AC5–AC7、AC10 |
| PL-T3 | 窄屏 PL-4、清理旧样式、整体浏览器检查 | AC8、AC10、AC11 |
| PL-T4 | 趋势图悬停提示 PL-F | AC10、AC13 |
| PL-T5 | 字号与强调 PL-G（方案 B） | AC10、AC14 |

授权：Product Owner 2026-11-12 授权按 Plan 连续实现 T1→T3（“可以，都开始”）；PL-T4 由 Product Owner 2026-11-12 追加并授权（“可以，保持断开，开始做 T4”）；PL-T5 由 Product Owner 2026-11-12 选择方案 B 并授权（“我要B，弄吧”）。

## 10. 实现记录（Implementation Notes）

### PL-T1（2026-11-12）

- 按本轮 PL-T1 brief 实现，未开始 T2 / T3 的完整详情设计和窄屏交互。`index.html` 改为紧凑顶栏、370px 线路栏和右侧常驻详情；移除旧表格和线路详情 dialog。保留数据状态所需的 `profile-data-summary`（隐藏的兼容节点）、`map-data-actions` 和全部日期 / ZIP id；`data-status.js` 无改动。
- `app.js` 用共享 `routeColor` / `difficultyColor` 渲染按钮行、报价文字及按可见最大件量计算的细条。本地搜索匹配线路名或 ZIP 前缀；ZIP 定位找到线路后清空输入和本地过滤，保留 DSP 外的“显示该线路”流程。总数仍按 DSP 范围计算，不因本地过滤改变。
- 排序按钮使用 `aria-pressed`，非默认排序显示方向；`sortRows` 新增系统难度排序，未知值最后、同级稳定。默认仍为 API 顺序。
- 默认选中第一条；排序 / DSP / 本地过滤保持可见选中项，否则回落第一条，空列表清空详情；站点 / 片区 / 日期重新加载后重新选首条。ZIP 最终选择定位目标并高亮明细。`clearRouteDetail` 同时使概况和历史旧请求失效，移除原关闭、Esc、外部点击及回焦逻辑。已有 ZIP 请求因新意图失效但线路仍可见时，重新加载该线路普通详情，避免留在旧的加载状态。
- T1 右侧沿用旧概况 / ZIP 表 / 历史内容；目前档案页没有价格明细入口，待 T2 指标卡接入。`price-detail.js` 及其弹窗行为测试保留。≤750px 暂时回退普通页面滚动、上下排列，完整窄屏体验仍属 T3。
- 没有改 API、数据、DB、抓取、依赖、静态白名单和 `/map` HTML / JS；没有新增 web 文件，没有读取 `.env` 或 runtime 配置，没有重启现有服务，没有 commit / push / 部署。`npm.cmd test` 按现有命令加载测试环境，未打印环境值。

**测试断言迁移（旧行为覆盖保留）**

| 文件 | 断言变化与原因 |
|---|---|
| `profile-sort.test.js` | 新增难度升降序、未知 / 空值最后、同级稳定和不修改源数组断言。现有数值三态排序规则不变。 |
| `profile-zip-search.test.js` | DOM double 从 `rows` 改为 `profile-routes`；总数加“条”；旧表头 `aria-sort` 改为按钮 `aria-pressed`，默认线路名激活。ZIP 行样式保留 `zip-target-row` 并增加基础行类；列表滚动断言改 `nearest`，明细 ZIP 仍为 `center`。弹窗打开 / 关闭 / 回焦断言改为常驻面板、目标选中和清除旧高亮；定位成功清空输入。日期请求断言允许加载后自动请求第一条详情，仍检查正确日期和站点；详情请求数允许默认选中带来的额外请求。全部 ZIP 状态、多站点选择、DSP 外显式显示、失败和过期响应场景保留。新增按钮行内容 / 颜色 / 件量比例、本地过滤、选中保持 / 回落、HTML 和 PL CSS 断言。 |
| `rd1.test.js` | 主表格单元格断言改为按钮行名称和字母徽章，自动加载详情后再点击同一行无需重复请求。删除已取消的关闭交互断言，改用 `clearRouteDetail` 验证旧请求失效；错误脱敏、404、ZIP 表字段 / 排序、人工难度和颜色断言保留。旧弹窗尺寸断言改为右侧滚动和常驻面板宽度，表格溢出约束保留。 |
| `route-history-web.test.js` | 过期历史测试用 `clearRouteDetail` 取代 `.close()`，继续验证时间窗口竞争和重新选线路后的过期响应；历史内容、键盘切换、日期行为均保留。 |
| `route-quotation-web.test.js` | 档案表格价格单元格 / 点击断言改为列表单价、价格区间、缺失报价省略、整行仅一个按钮、无报价明细请求；表头结构断言改为无旧表格和五个排序按钮。独立价格弹窗全部状态 / 关闭 / 竞争测试及地图价格入口测试不变。 |
| `t7.test.js` | 标题改“线路档案”，旧列名断言改为保留 id / 无表格及无详情 dialog。API 顺序、安全文本、数字和难度断言改为对应按钮行结构；未知难度显示破折号，已识别难度显示字母。DOM double 补充常驻面板和滚动，模拟独立详情请求；请求计数仍针对 profiles。重试、失败、空状态、站点 / 片区记忆断言保留。 |
| `district-config.test.js` | 仅调整 DOM double 的列表 id 并补常驻面板节点；真实片区配置、禁用无快照站点及空状态断言不变。 |
| `data-status.test.js` / `date-view-web.test.js` | 前者仅重命名“卡片”为兼容容器的测试名称，行为断言未变；后者无需修改，全部日期工具 / 参数断言保留。 |

**验证结果**

- `npm.cmd test`：868/868 通过，0 skipped；最终受影响文件定向回归 224/224 通过，ZIP 请求次数收紧为初始首条 / 目标站首条 / 最终定位共 3 次后再次验证 20/20 通过。没有配置 lint 或 build 命令。
- `git diff --check`：通过。
- 使用已有 Playwright headless Chromium 检查正在运行的 `http://127.0.0.1:3000/`。1440×900 / 1280×720 的 `scrollWidth/scrollHeight` 分别等于视口尺寸；默认选择、点击另一条、件量 / 难度排序、过滤、同站及跨站 ZIP 定位、历史、日期 / 回到最新、更新记录均通过。390px 无横向溢出；`/map` 加载和线路选择通过。console / pageerror 为 0。脚本含 `try/finally` 和 55 秒硬超时；退出后检查 `chrome-headless` 和 `ms-playwright` 下的 `chrome.exe`，无残留。
- 截图：`.handoff/PL-T1-1440-default.png`、`PL-T1-1280-default.png`、`PL-T1-other-route.png`、`PL-T1-volume.png`、`PL-T1-difficulty.png`、`PL-T1-filter.png`、`PL-T1-zip-same.png`、`PL-T1-zip-cross.png`、`PL-T1-history.png`、`PL-T1-date.png`、`PL-T1-narrow.png`；浏览器报告 `.handoff/PL-T1-browser.json`。

| 本任务验收项 | 结果 |
|---|---|
| PL-AC1 | 满足：两种桌面尺寸无页面滚动，列表 / 右侧独立滚动。 |
| PL-AC2 | 满足：按钮行包含共享颜色、名称、DSP / ZIP / 报价、PPH、件量、难度字母及比例条。 |
| PL-AC3 | 满足：五个排序按钮、三态与稳定难度排序均已测试。 |
| PL-AC4 | 满足：本地过滤和既有全部 ZIP 测试场景通过，真实同站 / 跨站定位通过。 |
| PL-AC5（T1 选中部分） | 满足：默认首条、常驻详情、保持 / 回落及 sequence 竞争保护。 |
| PL-AC9 | 满足：片区 / 站点记忆、DSP、DV、数据状态回归通过；地图未改，浏览器地图加载 / 选择通过，无新增 web 文件或依赖。 |
| PL-AC10 | 满足：全量测试和 diff 检查通过；受影响断言说明见上表。 |

待 Claude review 和 Product Owner 预览签字；不将 T2 / T3 的验收项标为完成。

### PL-T1 第 1 轮修复（2026-11-12）

- 按本轮审查要求，仅修复 ZIP 提交和空过滤结果两处状态处理。提交 ZIP 时不再清空 `selectedRoute` 和详情；未覆盖、无边界、超出范围、多站点待选择或查询失败只更新搜索提示，成功定位仍沿用 `highlightZipRoute` / `selectRoute`。
- 本地过滤或 DSP 范围内过滤无匹配时，列表显示 `profileText.noMatchingRoutes`（“没有匹配的线路”），选择保留上一条线路详情。清除过滤后恢复原选中项；有匹配但原线路不可见时仍回落首条。站点确实没有数据时继续沿用原有空站点文字和抓取提示。
- `profile-zip-search.test.js` 新增两项回归测试：查询中及未覆盖 / 无边界 / 超范围 / 多站点待选择 / 网络失败保持原选择、详情和标题；无匹配及 DSP 范围内无匹配保留详情且不出现 `dms:scrape`，空站点仍显示原提示。旧的空过滤“暂无数据”断言改为列表“没有匹配的线路”，其余行为断言保留。
- 验证：`npm.cmd test` 870/870 通过，0 skipped；定向 `node --test server/test/profile-zip-search.test.js` 22/22 通过；`git diff --check` 通过（仅现有 LF / CRLF 提醒）。没有 lint / build 命令。没有数据、API、依赖变更，没有 commit / push / 部署。
- 浏览器：已有 Playwright headless Chromium 访问运行中的 3000 服务，使用 ZIP 请求拦截复现 uncovered 和查询失败，验证详情不变及恢复过滤后原选择不变；验证本地过滤无匹配。截图为 `.handoff/PL-T1-r1-zip-uncovered.png`、`.handoff/PL-T1-r1-zip-failure.png`、`.handoff/PL-T1-r1-filter-empty.png`。console / pageerror 为 0；脚本使用 `try/finally` 和 55 秒硬超时关闭浏览器；结束后 `Get-Process` 检查未发现 headless 或 `ms-playwright` 下的 Chrome 残留。未重启任何服务。
- 本轮验收：PL-AC4 满足（ZIP 状态和原定位回归通过）；PL-AC5 本轮选中规则满足（空过滤保留详情按本轮明确要求修正）；PL-AC7 本轮状态区分满足（空过滤与空站点分开）；PL-AC10 满足。AC1–AC3、AC9 本轮未改动对应实现；AC6、AC8、AC11 的完整验收仍属后续任务，AC12 待 Claude review 和 Product Owner 预览签字。

### PL-T2（2026-11-12）

- 在未提交的 T1 / T1 第 1 轮修复之上实现右侧详情，没有修改 `app.js` 的列表、排序、搜索或选中规则。标题使用共享 `routeColor` 和系统难度颜色；说明行包含站点、DSP、Route ID、ZIP 数及日期后缀。详情返回前使用列表 ZIP 数，返回后使用 `zip_count`。清空面板时同时清除颜色、难度和说明。
- 概况改为五张指标卡、近 30 天两张趋势图、四列 ZIP 画像表、更新时间页脚。价格卡复用 `openPriceDetail(row, button)`；没有报价时为破折号，日期视图标注“当前报价”。人工难度继续使用 `difficultyTone`。更新时间继续使用原始时间字段、`formatUpdated` 和 `title`。
- 每次选中线路创建一个 30 天共享 Promise（含加载中和失败结果），概况与历史 30 天窗口复用；7 天仍独立请求。切换线路重新创建缓存，概况更新受 `sequence` / `isCurrent` 保护，历史窗口另受 `request` 保护。`summarizeMetric` / `sparkline` 规则不变，抽出 `trendText` 供两处使用。历史加载中、不可用或失败时指标卡隐藏趋势小字，趋势区域使用原 RH 提示。
- ZIP 按日均领件量降序、空值最后、同值 ZIP 升序排序；横条按本线路最大件量计算比例，空值无条，全零时为零宽。保留 `zip-target`、滚动定位与 `highlightFound`。移除 ZIP 首公里列及 `profileText.firstMileNote`，首公里仍在指标卡。ZIP 表覆盖旧全局表格的 980px 最小宽度，避免桌面卡片内列被挤到右侧。
- 新样式仅在 `/* PL */` 内且限定 `.profile-page`。宽屏五卡一行，中等宽度自动换行，趋势两图并排，右侧继续独立纵向滚动。没有线路详情关闭按钮、dialog 选择器或关闭交互残留；保留 `.data-dialog`（更新记录）和价格弹窗的共用样式，它们仍在使用。
- 未改 API、数据、DB、抓取、依赖、白名单及 `/map` 规则；没有新增 web 文件，没有读取 `.env` 或 runtime 配置，没有重启或停止现有服务，没有 commit / push / 部署。按要求运行的 npm 测试命令沿用项目自身的测试环境加载机制，没有显示环境值。

**旧断言迁移及新增覆盖**

| 文件 | 说明 |
|---|---|
| `rd1.test.js` | 原基础字段网格断言改查标题说明、五卡和页脚，继续验证来源、格式、回退 ZIP 数、详情返回 ZIP 数和原始时间 title；系统难度改查标题徽章，人工难度继续查卡片。五列改四列、件量顺序改降序、caption 改新排序说明；删除 ZIP 首公里值断言（值仍由线路首公里卡验证），不再要求重复首公里说明。异步请求计数增加概况 30 天请求。状态 / 错误脱敏断言移至 ZIP 卡区域，旧响应保护保留。新增件量同值排序、空值最后、100/50/0% 横条、无空值条、冻结输入不变、ZIP 高亮及未找到返回值测试。 |
| `route-history-web.test.js` | 历史仍在首次切标签时请求 7 天；初始计数增加概况 30 天，选择 30 天改为验证复用已有请求。日期说明改查标题说明行，历史请求仍不带日期。过期测试隔离新概况请求与旧历史窗口请求。新增持平 / 不足 / 升 / 降 / 空 points、概况与历史趋势一致、加载中 Promise 共用、换线路和 `isCurrent` 过期保护、不可用 / 失败隐藏小字及错误脱敏。原四卡、变化记录、SVG 断点、键盘、窗口竞争断言保留。 |
| `route-quotation-web.test.js` | 新增卡片价格区间按钮真实调用共享价格弹窗、正确 route_id、关闭回焦、日期“当前报价”、无报价无按钮测试；既有列表报价、独立弹窗及地图价格入口断言保留。 |
| `profile-zip-search.test.js` | DOM double 补标题节点，并为新增的历史请求返回独立不可用响应，避免混入 ZIP 请求场景；日期后缀断言移到标题说明，日期无详情文字仍查 ZIP 区域。既有全部 ZIP 状态及 T1 修复断言保留。 |
| `t7.test.js` / `district-config.test.js` | 仅补新增标题节点及 DOM double 的 style；T7 为历史请求提供独立响应，原 profiles 请求计数、重试、站点和片区记忆断言不变。 |
| `date-view-web.test.js` | 无需改动；日期工具和参数测试原样通过。 |

**验证结果**

- `npm.cmd test`：875/875 通过，0 skipped；修改过程中的旧布局断言失败已按上表迁移并回归。没有配置 lint / build 命令。
- `git diff --check`：通过（仅现有 LF / CRLF 提醒）。
- 已有 Playwright headless Chromium 访问运行中的 3000 服务：1440×900 SFO01 默认、切换线路、连续选择三条、真实报价明细、历史 7 / 30 天（检查 30 天请求未增加）、日期 / 当前报价提示、ZIP 定位高亮通过；1440 / 1280 桌面没有页面滚动，750 / 390px 没有横向溢出；地图加载及线路选择通过。console / pageerror 为 0。脚本含 `try/finally` 和 55 秒硬超时，关闭后进程检查无 headless 或 `ms-playwright` Chrome 残留。
- 截图：`.handoff/PL-T2-1440-default.png`、`PL-T2-other-route.png`、`PL-T2-rapid.png`、`PL-T2-price.png`、`PL-T2-history7.png`、`PL-T2-history30.png`、`PL-T2-zip.png`、`PL-T2-date.png`、`PL-T2-1280.png`、`PL-T2-narrow-750.png`、`PL-T2-narrow-390.png`；报告 `.handoff/PL-T2-browser.json`，脚本 `.handoff/PL-T2-browser.mjs`。

| 本任务验收项 | 结果 |
|---|---|
| PL-AC5（详情及快速切换部分） | 满足：常驻详情、换线路回概况、旧异步结果不覆盖新选择；T1 列表规则未改。 |
| PL-AC6 | 满足：五卡、共用 RH 规则 / 30 天请求、两图、四列排序 ZIP 表、横条、页脚、价格入口及原历史内容均通过验证。 |
| PL-AC7 | 满足：加载、404、失败、空站点、日期无详情及 T1 无匹配状态回归通过；标题和指标卡保留列表数据。 |
| PL-AC9 | 满足：片区 / 站点记忆、DSP、DV、数据状态回归通过；无 API / 地图 / 依赖改动，无新增 web 文件。 |
| PL-AC10 | 满足：全量测试和 diff 检查通过，旧断言迁移说明如上。 |

待 Claude review 和 Product Owner 预览签字。PL-T3 的完整窄屏交互不在本轮范围内。

### PL-T3（2026-11-12）

- 保留 T1 的 ≤750px 普通页面滚动、上下排列和列表 `60vh / 60dvh` 上限；指标卡固定两列，趋势两图纵排，ZIP 表继续由 `.detail-table-scroll` 承接横向溢出。详情区增加 `100vh / 100dvh` 最小高度，使详情内容较少或仍在加载时也能滚到详情顶部。
- `app.js` 在窄屏自动选择 / 排序 / 过滤 / ZIP 定位时仅调整列表 `scrollTop`，避免行的 `scrollIntoView` 连带移动整页。只有线路行 click 监听器调用详情区 `scrollIntoView({ block: 'start', behavior: 'smooth' })`；减少动画偏好下使用 `instant`。通过 `matchMedia('(max-width: 750px)')` 判断；桌面仍使用原列表行 `nearest` 定位。未更改选择、排序、搜索或异步请求规则。
- 日期提示条继续共用 `.profile-banners` 的背景和 `8px 12px` 内边距，字号改为与数据状态条相同的 `var(--fs-14)`，去掉旧边框；“回到最新”按钮继承字号并缩小内边距。
- 经 `rg` 确认后，删除旧 `#profiles thead th`、`#profiles th.numeric`、`#profiles .sort-button`（含 hover / focus / active）、`#profiles .sort-arrow` 规则、未使用的 `.route-link` 和旧表格 `.zip-target-row > td` 分支。删除未使用的 `profileText.routeName / routeId / station / dsp / difficulty / zipCount`。brief 提到的 `.profile-data-card / .profile-summary / .profile-metric / .profile-zip-search / #table-container / dialog#route-detail` 已在前序任务移除，没有重复清理。未发现其他可独立删除的 JS 死逻辑；保留共享价格弹窗所需的 `.detail-metrics`、更新记录所需的 `.detail-heading` 和仍使用的 ZIP 高亮规则。地图规则未改。
- `profile-zip-search.test.js` 新增两项测试：用户点击 / 自动选择 / 宽屏 / 减少动画及列表内部滚动；窄屏布局、列表高度、两列指标、单列图表、详情最小高度、提示条和清理后共享规则。DOM double 补充矩形和详情区节点。未删除或放宽旧断言。

**验证结果**

- `npm.cmd test`：877/877 通过，0 skipped；最终窄屏最小高度断言加入后定向回归 24/24 通过。`git diff --check` 通过，仅 LF / CRLF 提醒。没有 lint / build 配置。
- 使用现有 Playwright headless Chromium 访问正在运行的 3000 服务，1440×900 和 1280×720 均验证：无页面横纵滚动、SFO01 默认首条、件量排序、切换线路、真实首票价格明细、同站 / 跨站 ZIP 定位及 ZIP 高亮、历史标签、按日期查看；计算样式确认两种提示条字号 / 内边距 / 背景一致。
- 390×844 和 750×1000 均无横向溢出；列表最大高度分别为 506.4px / 600px，列表内部可滚动；指标两列、趋势一列；初次加载 / 排序 / 过滤页面留在顶部，用户点击后详情顶部对齐视口，减少动画偏好通过。首次浏览器检查发现加载时短详情限制滚动距离，增加详情区最小高度后完整复测通过。
- `/map` 列表、边界图形和线路选择正常。最终 console / pageerror 均为 0。脚本 `.handoff/PL-T3-browser.mjs` 包含 `try/finally` 关闭浏览器及 55 秒超时后的强制退出；报告 `.handoff/PL-T3-browser.json`。每次浏览器脚本结束后均用 `Get-Process` 检查，未发现 `chrome-headless` 或 `ms-playwright` 下的 Chrome 残留。
- 截图：`.handoff/PL-T3-{1440,1280}-{default,volume,other-route,price,zip-same,zip-cross,history,date}.png`、`PL-T3-narrow-{390,750}-{initial,detail}.png`、`PL-T3-map.png`。
- 无 API / 数据 / DB / 抓取 / 依赖 / web 文件新增，无凭据写入，无配置读取，无服务重启或停止，无 commit / push / 部署。测试命令仅沿用项目自身的环境加载机制，不显示环境值。

| 验收项 | 结果 |
|---|---|
| PL-AC1 | 满足：两种桌面视口页面尺寸等于视口，列表 / 详情独立滚动。 |
| PL-AC2 | 满足：原列表结构、共享颜色和件量条测试通过。 |
| PL-AC3 | 满足：五按钮和三态 / 难度排序回归通过，浏览器验证件量排序。 |
| PL-AC4 | 满足：全部原 ZIP 场景和过滤测试通过，两种桌面视口真实同站 / 跨站定位通过。 |
| PL-AC5 | 满足：原选择 / 请求竞争回归通过；本轮仅新增窄屏用户点击滚动。 |
| PL-AC6 | 满足：详情和历史回归通过，浏览器价格弹窗、历史和 ZIP 表正常。 |
| PL-AC7 | 满足：加载 / 404 / 失败 / 空站点 / 日期无详情及前序修复状态测试通过。 |
| PL-AC8 | 满足：390 / 750px 恢复页面滚动，上列表下详情，无横向溢出。 |
| PL-AC9 | 满足：片区 / 站点记忆、DSP、日期、数据状态测试通过，地图浏览器检查通过；无新增 web 文件或依赖。 |
| PL-AC10 | 满足：877 项测试及 diff 检查通过；本轮未删除或放宽旧断言。 |
| PL-AC11 | 满足：全部要求的截图 / 交互已检查，console / pageerror 为 0，浏览器关闭且无残留。 |
| PL-AC12 | 待 Claude review 和 Product Owner 预览签字。 |

### PL-T4（2026-11-12）

- 仅修改 `web/route-detail.js`、`web/styles.css`、`server/test/route-history-web.test.js` 和本实现记录，接续未提交的 T1–T3。`sparkline` 返回包含原 SVG 和 HTML 提示框的容器，概况两图及历史四图共用交互。保留原日期断点、坐标、变化竖线及 `summarizeMetric`；未改变 sequence / request 防串号。
- pointer 横坐标按 SVG 默认等比例缩放及居中留白反算到 viewBox，再按原 x 公式吸附最近日历日；缺失日隐藏，不跨日期补值。当前圆点增大并显示独立参考线，鼠标离开隐藏。触屏 / pen 点按后保持显示，点图外隐藏。
- SVG 保留原 aria-label，增加 tabindex；左右键仅访问有数值日期，边缘停止，Esc / 失焦隐藏。HTML 提示框使用 aria-live polite / aria-atomic。四种指标的单位和小数位集中映射，日期复用 shortDay；变化文案抽为 formatHistoryChange，与变化记录列表共用，同一天多条用分号连接。
- 提示样式位于 PL 区块并限定 profile-page，深色半透明背景、细边框、小字号。提示位置夹紧到图表容器内，宽高不超过容器，防止详情边缘溢出或被滚动父容器裁切。可见提示才注册 document pointerdown；隐藏、换线路、清空详情、换标签、换时间窗口时移除，旧提示随旧图丢弃。
- 测试仅扩展现有 DOM double 和新增两项测试，未删除或放宽旧断言。新增覆盖两端 / 中点 / 越界吸附、缺失日、四种单位、变化文案一致、圆点及边界位置、键盘跳过缺失日、Esc / blur、touch / pen、外部点击、窗口 / 标签 / 线路切换后的提示和监听器清理。
- `node --test server/test/route-history-web.test.js`：9/9 通过；`npm.cmd test`：879/879 通过，0 skipped；`git diff --check` 通过（仅现有 LF / CRLF 提醒）。没有配置 lint / build 命令。测试命令沿用项目自有环境加载机制，未手动读取或打印 `.env` / runtime 配置。
- 已有 Playwright headless Chromium 访问运行中的 `http://127.0.0.1:3000/`：1440×900、SFO01 默认线路概况件量首点 / 尾点 / 缺失日、PPH、历史 30 天四种指标、Tab 到图后右键及 Esc 均通过。SFO01-007 的真实变化记录验证通过。390×844 真实 touch 点按保持提示、图外点按隐藏通过。各数值提示检查日期及容器边界；console / pageerror 均为 0。人工查看变化记录与触屏截图，显示正常。
- 浏览器脚本 `.handoff/PL-T4-browser.mjs` 包含 try/finally 关闭及 55 秒硬超时；报告 `.handoff/PL-T4-browser.json`。结束后通过 Get-Process 检查，无 chrome-headless 或 ms-playwright 路径下 Chrome 残留。截图 `.handoff/PL-T4-{volume-first,volume-last,volume-gap,pph,keyboard,history-pickup_volume,history-pph,history-first_mile_distance,history-zip_count,changes,touch}.png`。
- PL-AC13：满足本轮交互和浏览器检查；PL-AC10：满足。待 Claude review 和 Product Owner 预览签字。没有 API / 数据 / DB / 抓取 / 地图 / 依赖变更，没有新增 web 文件，没有服务重启 / 停止、凭据写入、commit / push / 部署。

### PL-T5（2026-11-12）

- 接续未提交的 PL-T1～T4，仅实现 PL-G 方案 B。直接修改原有 PL 样式：侧栏 390px，线路名 17px / 700、PPH 19px / 700、件量 15px / 600、难度徽章 32px，详情标题 30px、指标值 30px / 700；其余标签、说明、表格字号及件量细条均按表格调整。
- `app.js` 为 PPH / 件量添加 `profile-route-pph` / `profile-route-pickup`；`route-detail.js` 按字段键给 Pickup Volume / PPH 添加 `pl-metric-key`，用于青色顶部条和重点底色。不依赖子节点位置；不改数据、排序、选择和请求逻辑。
- 两页导航合并为一份共享规则，当前页青色实心、深色文字、800 字重和轻微发光。两页保留 h1 并加 `sr-only`，地图标题保留 `data-map-text="title"`；原标题容器移出布局并去掉分隔线 / 内边距，品牌与导航保持顶栏 gap。地图列表、地图和浮层规则未改。
- ≤750px 沿用全宽侧栏和原上下排列，不另缩字号。390×844、750×844 检查无横向滚动，行内元素不越出行边界；390px 截图中线路名仍完整可读。
- 新增 `profile-typography.test.js` 并接入 `server/test/index.js`，断言明确类名、PL-G 关键数值、共享导航及两页隐藏 h1。旧断言仅两处迁移：`profile-zip-search.test.js` 的侧栏 370px → 390px，原因是 PL-G 明确调整宽度；`t7.test.js` 的裸 h1 → 带 `sr-only` 的 h1，原因是 PL-G 要求视觉隐藏但保留语义。其余旧断言未删除或放宽。
- 首次验证中发现类名变量未解构导致列表渲染失败，修复后定向测试 26/26 通过；后续全量回归发现旧 h1 断言并按上述要求迁移。最终值另补第二行 13px 的 CSS 和计算样式断言。
- 已有 Playwright headless Chromium 访问运行中的 3000 服务：档案页 1440×900 / 1280×720 无页面滚动，390×844 / 750×844 无横向滚动；地图页 1440×900 / 1366×768 保持一屏且无横向滚动。计算样式核对线路名、第二行、PPH、件量、单位、徽章、侧栏、件量条、详情标题 / 说明、指标卡、重点条、卡片标题、趋势标题、ZIP 表及两页导航 / h1，全部通过。console / pageerror 为 0。人工对照 `font-B.png` 及桌面、窄屏、地图截图，字号和强调符合方案 B；顶栏按本轮要求隐藏重复标题。
- 浏览器脚本 `.handoff/PL-T5-browser.mjs` 含 try/finally 关闭和 55 秒硬超时；报告 `.handoff/PL-T5-browser.json`。截图 `.handoff/PL-T5-profile-{1440,1280,390,750}.png`、`.handoff/PL-T5-map-{1440,1366}.png`。每次检查结束后均用 Get-Process 检查，无 chrome-headless 残留；现有其他 Playwright Chrome 进程未擅自结束。CIM 父进程查询被沙箱拒绝（Access denied），未扩大权限。
- 无 API / 数据 / DB / 抓取 / 依赖变更，无新增 web 文件，无凭据写入；未手动读取 `.env` / runtime 配置，npm 测试仅沿用项目既有环境加载机制；无服务重启 / 停止、commit / push / 部署。待 Claude review 和 Product Owner 预览签字。
- 最终检查：`npm.cmd test` 881/881 通过，0 failed、0 skipped；`git diff --check` 通过（仅 LF / CRLF 提醒）。项目没有 lint / build 命令，未声称执行。PL-AC10 满足；PL-AC14 的代码、计算样式、视口及无浏览器错误检查满足。UI 最终完成仍待 Claude review 和 Product Owner 预览签字。
