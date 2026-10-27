# 页面导航强化 + 线路画像页 ZIP 搜索（NAV1 / PZ1）

- **状态：** Approved（Product Owner 2026-10-08 要求直接实现）
- **相关文档：** `docs/features/route-map.md`（RM5 / RM5b / RM6 / RM7、ZIP 查询）、`docs/features/route-detail.md`（Route Detail / ZIP 明细弹窗）

只改前端。**不改** API contract、scraper、DB、central DB / P3 架构，不新增依赖。

---

## 1. NAV1 — 右上角页面入口

### 现状（Claude 检查）

- `web/index.html`（线路画像页）header 里只有一个 `<a href="/map">线路地图</a>`；`web/map.html` header 里只有一个 `<a href="/" data-map-text="profiles">线路档案</a>`。两个都是普通的小号文字链接。

### 设计

- 两个页面的 header 都换成同一个导航组件 `<nav class="page-nav" aria-label="页面">`，里面放两个入口：
  - “线路档案” → `/`
  - “线路地图” → `/map`
  - 文案保持现有用法不变（`map-text.js` 中的 `profiles` 等）。
- 当前页面的入口：加 `aria-current="page"`，并用更粗的字体、底部高亮线、浅背景来显示 active 状态。颜色沿用现有的强调色 `#65dace`。
- 非当前页面的入口：普通字重，hover 和 focus 时显示背景，并保留清晰的 focus outline。
- 尺寸：字体从现在的正文大小加大到大约 16–17px，点击区域的内边距大约 8px × 12px，两个入口之间间距大约 8px。**不做成**大块的实心按钮。
- 位置：沿用现有 header 中链接的位置（右上角），在现有 flex 布局中排列。390 宽度下可以换行，但不能出现横向滚动。

### 验收

- **NAV1-AC1** 两个页面都有这两个入口，当前页面的入口带 `aria-current="page"` 并有 active 样式，另一个入口没有。
- **NAV1-AC2** 入口的字号和点击区域明显比之前大（测试检查 CSS 规则）；1440 和 390 宽度下都没有横向滚动。
- **NAV1-AC3** header 中的片区、站点、DSP 选择器，数据状态条，更新记录、刷新入口，布局都没有回归。

---

## 2. PZ1 — 线路画像页 ZIP 搜索

### 2.1 方案选择：在画像页里直接定位（不跳到地图页）

- 理由：画像页本身就有“片区 → 站点 → 线路表格 → Route Detail 弹窗（ZIP 明细表）”这一整套流程，用户在画像页搜 ZIP，通常是想看这个 ZIP 属于哪条线路、这条线路的指标是什么。直接在当前页面定位到线路行，并打开 ZIP 明细，最自然。跳到地图页会打断当前的浏览。
- ZIP 归属**完全复用**现有的 `GET /api/route-map/zip?postal_code=`（地图搜索用的就是这个接口，两个 server 都提供），不另写一套归属判断。

### 2.2 UI 位置

- 在画像页 header 的 `dl.metrics`（片区、站点、更新时间、线路总数）这一排的**最右边**，加一个 ZIP 搜索区：
  - `<form id="profile-zip-form">`，里面有：`ZIP` 标签、`<input id="profile-zip" inputmode="numeric" maxlength="5" autocomplete="off">`、“搜索”按钮（type=submit）。用 form submit，这样点按钮和按 Enter 走同一条路径。
  - 下面跟一行结果反馈 `<div id="profile-zip-result" role="status" aria-live="polite">`。
- 390 宽度下，搜索区换到下一行，宽度不超出屏幕。

### 2.3 交互

1. 输入内容去掉首尾空格后必须是 5 位数字；不是的话，直接提示“请输入 5 位 ZIP”，**不发请求**。
2. 请求 `/api/route-map/zip?postal_code=<zip>`。期间搜索按钮 disabled，结果行显示“查询中…”。如果在返回前又发起了新的搜索，只采用最新一次的结果（按 sequence 判断，沿用 `app.js` 现有的做法）。
3. 按返回的 `status` 处理：

| status | 行为 |
|---|---|
| `covered` | 按下面第 4 步定位 |
| `covered_no_boundary` | 按第 4 步定位，结果行再加一句“有线路归属，但无地图边界” |
| `multi_station` | **不自动选择**。结果行列出 `owners` 中的每一项（Station · Route），每项是一个按钮；点击某个按钮后，按第 4 步定位到它 |
| `uncovered` | 提示“当前数据中未找到该 ZIP 的线路归属” |
| `no_boundary` | 提示“当前数据中未找到该 ZIP 的线路归属（该 ZIP 也没有地图边界）” |
| `out_of_range` | 提示“该 ZIP 不在当前数据覆盖的州范围内，未找到线路归属”。普通提示样式，**不当作错误** |
| HTTP 400 / 5xx / 网络错误 | 固定的错误文案，例如“ZIP 查询失败，请稍后重试”，不显示响应内容 |

4. **定位**（用于 covered、covered_no_boundary，以及多归属时用户选中的那一项）：
   1. 用 `districts`（`/api/districts`）找到目标 Station 所在的 District，包括 `unassigned`。找不到时提示“该 ZIP 属于 <station>，但当前片区配置中没有这个站点”，然后结束。
   2. 如果当前片区或站点和目标不同，**按现有切换片区 / 站点的同一条路径切换**：更新 select，调用 `saveSelection`，关闭已打开的弹窗，然后 `load()`。这条路径要复用现有 change 处理里的逻辑，不要另写一套。等目标 Station 的数据加载完成后再继续。
   3. 在线路表格中找到 `route_id` 相同的那一行，加上高亮 class（例如 `zip-target-row`），并 `scrollIntoView({ block: 'center' })`。找不到这一行时，提示“当前快照中找不到该线路”，然后结束。
   4. 调用现有的 `openRouteDetail(row, button, fetched_at)` 打开这条线路的 Route Detail 弹窗。ZIP 明细加载完成后，在 ZIP 表中找到 `postal_code` 相同的那一行，加上高亮 class（例如 `zip-target`），并 `scrollIntoView({ block: 'center' })`。
      - 需要给 `openRouteDetail` 增加一个可选参数（例如 `{ highlightZip }`），或者让它返回一个 Promise，在渲染完成后 resolve。两种都可以，但现有的调用方式要保持不变。
      - 如果这条线路没有 ZIP 明细缓存，弹窗按现有逻辑显示；如果 ZIP 不在明细表中，结果行补一句“该线路的 ZIP 明细中没有这个 ZIP”。都不伪造数据。
   5. 结果行显示：`ZIP <zip> · 站点 <station> · 线路 <route_name> · DSP <dsp>`。DSP 优先取 `route.dsp_name`，其次取返回的 `dsp_name`。字段没有值时，**这一项不显示**，不显示“—”，也不伪造。
5. **高亮什么时候清除**：
   - 用户手动切换片区或站点时，表格会重新渲染，线路行的高亮自然消失。
   - 用户关闭弹窗、或者点开另一条线路时，ZIP 行的高亮随弹窗内容的替换而消失。
   - 搜索框里的内容**保留**，不清空；不做搜索历史和联想；不写 localStorage。
6. 这个搜索是**画像页自己的功能**：不改地图页的 ZIP 搜索，也和 DSP 筛选（RM7，只在地图页）无关。

### 2.4 验收

- **PZ1-AC1** 点击搜索按钮和按 Enter 都能触发同一个搜索；输入不合法时不发请求。
- **PZ1-AC2** 单一归属：自动切换到正确的片区和站点（包括跨片区的情况），线路行高亮并滚动到可见位置，Route Detail 打开，目标 ZIP 行高亮并滚动到可见位置；结果行字段正确，空字段不显示；`saveSelection` 被调用，与手动切换的行为一致。
- **PZ1-AC3** 多归属：不自动选择，列出所有 owners；点击其中一项后正确定位。
- **PZ1-AC4** covered_no_boundary 时正常定位，并显示“无地图边界”的提示；uncovered、no_boundary、out_of_range 显示各自的提示，out_of_range 不使用错误样式；HTTP 错误和网络错误显示固定文案。
- **PZ1-AC5** 连续快速搜索时，只采用最新一次的结果；搜索之后再手动切换片区或站点，旧的高亮不会残留，也不会报错。
- **PZ1-AC6** 现有功能没有回归：画像页的片区 / 站点切换和记忆、线路表格、Route Detail 弹窗（排序、Esc、焦点恢复）、数据状态条；地图页的 ZIP 搜索、DSP 筛选、选中逻辑、RM5 / RM5b / RM6 / RM7、Coverage、Missing、跨站冲突。
- **PZ1-AC7** 1440 和 390 宽度下没有横向滚动，console 没有 error；所有动态内容都用 `textContent` 渲染；`npm test` 全部通过，现有断言除了因为 header 结构变化而必须调整的部分以外都不改，调整的部分要逐条说明；`git diff --check` 通过。

---

## 3. Codex 任务

| 任务 | 内容 | 状态 |
|---|---|---|
| NAV1-PZ1-T1 | 实现第 1、2 节，并编写测试 | 待 review |

### 实现记录（Implementation Notes，2026-10-08）

- 两页复用 `nav.page-nav` 的结构和 CSS；当前入口使用 `aria-current="page"`，地图入口继续使用已有 `profiles` / `title` 文案 key。画像页搜索区与 metrics 共用可换行容器，窄屏独占下一行。
- `app.js` 的手动选择和 ZIP 定位共用可等待的 `switchTo`：同步两个 select、保存站点选择、关闭弹窗、加载画像；用 route ID → 数据 / 表格行 / 按钮映射定位。保留在途加载 Promise，同一目标站点尚未加载完成时等待该请求，不重复加载。
- ZIP 查询使用独立 sequence，在查询、站点加载、弹窗加载后检查当前意图；手动切换会失效旧查询。多归属只根据 API 的 owners 创建选择按钮，不自动决定归属。搜索值不写入 localStorage；结果字段及动态按钮均用 `textContent`。
- `openRouteDetail` 保持原三参数用法，增加可选 `{ highlightZip, isCurrent }`，成功渲染后返回 `{ highlightFound }`。没有详情缓存时沿用原有空状态，已加载的详情不含目标 ZIP 时补充提示。高亮只通过 CSS class，保留难度颜色、排序、Esc 和焦点恢复。
- 新增 `server/test/profile-zip-search.test.js` 的 9 项测试并注册到 `server/test/index.js`，涵盖导航、验证、跨片区和 unassigned、多归属、六种状态、HTTP / 网络错误、缺失数据、空字段、手动切换和查询 / 画像 / 详情阶段的并发响应；没有修改任何现有测试断言。
- 检查：`npm.cmd test` 全部通过（487 项，基线 478 项）；没有 lint / build scripts。PowerShell 的 `npm.ps1` 被执行策略拦截，因此使用同一 npm 安装提供的 `npm.cmd`。首轮新增测试误写了原有空状态文案断言，改为实际文案“该线路暂无详细数据”后重跑通过。日志 `.handoff/NAV1-PZ1-tests.log`。
- 浏览器：已安装的 Playwright / Chromium，临时本地 HTTP 服务和合成 API 数据，不启动真实 API、不访问 DMS、不安装依赖。两页在 1440 / 390 宽度均无页面横向滚动、无 console / page error、无外部请求；验证按钮及 Enter、跨片区 ZIP 定位、弹窗 ZIP 高亮和 Esc 焦点恢复、手动切换清除高亮、地图 ZIP 搜索 / DSP 筛选、刷新入口。复核脚本 `.handoff/NAV1-PZ1-browser-check.mjs`，日志 `.handoff/NAV1-PZ1-browser.log`。
- 截图：`.handoff/NAV1-PZ1-profile-1440.png`（弹窗 ZIP 高亮）、`.handoff/NAV1-PZ1-profile-390.png`（搜索区与线路高亮）、`.handoff/NAV1-PZ1-map-1440.png`、`.handoff/NAV1-PZ1-map-390.png`。已检查实际截图。
- `git diff --check` 无空白错误、退出码 0；Git 默认另有 LF → CRLF 提示，使用仅对本次命令生效的 `git -c core.safecrlf=false diff --check` 无输出。原有未提交改动保留；未改后端、API、scraper、DB、central DB / P3 或地图搜索 / DSP 逻辑；无数据或 schema 变更；未 commit / push / 部署。
- NAV1-AC1 至 AC3、PZ1-AC1 至 AC7 技术检查通过，仍待 Claude review 和 Product Owner 预览签收。

---

## 4. PS1 — 线路档案表格按 Pickup Volume / PPH 排序（**Approved**，Product Owner 2026-10-08）

### 4.1 交互

- “Pickup Volume”和“PPH”两个表头变成可以点击的按钮（`<button>` 放在 `<th>` 里），文字右边有箭头。
- **三种状态循环**：默认顺序 → 点一次，从大到小（↓）→ 再点一次，从小到大（↑）→ 再点一次，回到默认顺序。
  - 默认顺序就是现在的顺序，即接口返回的 rows 顺序。
- 同一时间**只有一个**排序字段处于 active：点另一个表头时，那个字段从降序开始，原来的字段回到非 active。
- active 的表头：箭头明显，文字加粗，`<th>` 带 `aria-sort="descending"` 或 `"ascending"`。非 active 的表头：`aria-sort="none"`，箭头用很淡的中性符号（例如 ↕），或者不显示箭头，不能让人以为两个字段都在排序。
- 点击区域覆盖整个表头文字和箭头，保持现有表格风格；390 宽度下不能出现横向滚动（表格本身在现有的 `table-scroll` 容器中横向滚动是现有行为，不算页面横向滚动）。

### 4.2 排序规则

- 只对当前站点已经渲染的 rows 排序，不改数据。
- 数值判断：只有 `typeof value === 'number' && Number.isFinite(value)` 算有效值；`0` 是有效值。其他情况（null、undefined、非数字）都算**缺失**。
- **缺失值无论升序还是降序，都排在最后**；缺失值之间保持默认顺序。
- 数值相同时，保持默认顺序（稳定排序）。

### 4.3 状态

- 排序状态是页面内存中的一个变量（字段 + 方向），**不写 localStorage**，重新加载页面后回到默认顺序。
- 切换站点、切换片区、ZIP 搜索自动切换站点时，排序状态都**保留**，新站点的数据加载后按同样的排序显示。
- 线路档案页没有 DSP 筛选（DSP 筛选只在地图页，见 RM7），所以“切换 DSP 时保留排序”这一条在这个页面不适用。
- 和 ZIP 搜索（PZ1）兼容：定位线路用 `route_id`，与行的位置无关；排序后高亮和滚动仍然正确。

### 4.4 验收

- **PS1-AC1** Pickup Volume 和 PPH 都按 默认 → ↓ → ↑ → 默认 循环；同一时间只有一个 active，`aria-sort` 正确。
- **PS1-AC2** 缺失值在升序和降序时都排在最后；0 按正常数值排序；相同值时保持默认顺序。
- **PS1-AC3** 切换站点、片区，以及 ZIP 搜索跨站点定位后，排序状态都保留；重新加载页面后回到默认顺序；不写 localStorage。
- **PS1-AC4** 线路详情弹窗、ZIP 搜索（PZ1）、片区和站点的记忆、数据状态条都没有回归；1440 和 390 宽度下页面没有横向滚动；`npm test` 全部通过。

| 任务 | 内容 | 状态 |
|---|---|---|
| RM8-PS1-T1 | 实现 RM8（route-map.md）和 PS1（本文件第 4 节），并编写测试 | 待 review |

### RM8 / PS1 实现记录（Implementation Notes，2026-10-08）

- RM8：panel.clear 仅清理数据和状态，不清空搜索文本。删除无调用方、无测试引用的 preserveSearch；范围加载始终 fitToStation，zipSequence 不再恢复。站点 / 片区 / DSP 切换使旧 ZIP 查询失效；加载成功及 DSP 切换显示 map-text.js 中的保留 ZIP 提示，不自动查询。原有 input / Enter 查询及清除选择逻辑保留。
- PS1：复用已在静态白名单中的 format.js，导出 sortRows；严格有限 number 判断，缺失值末尾，原始下标打破平局，返回新数组。app.js 仅内存保存排序，点击表头不请求、不写 localStorage；按 route_id 重建定位映射，排序时保留已有线路高亮。
- 两个表头使用原生 button、aria-sort、箭头和 focus 样式。切换站点 / 片区及 ZIP 自动定位沿用现有路径，不重置排序。
- 新增 profile-sort.test.js 并注册 index.js；在原有地图 / PZ1 DOM 夹具中增加 RM8 / PS1 测试。没有修改现有测试断言；画像页夹具仅增加排序表头节点。初轮新增夹具重复初始化导致全局 fetch 恢复错误，已拆成独立 fresh-page 测试修正隔离；临时脚本字符编码问题也已修正。
- 浏览器复核使用已安装 Playwright / Chromium、本地临时 HTTP 服务和合成数据。两页 1440 / 390 宽度无页面横向滚动，无 console / page error，无外部请求；地图底图使用预期不可用的合成响应，边界与交互正常。画像页手机截图在既有表格滚动区内滚动至 active 箭头。脚本和日志：.handoff/RM8-PS1-browser-check.mjs、RM8-PS1-browser.log；截图：RM8-PS1-profile-1440.png、RM8-PS1-profile-390.png、RM8-PS1-map-1440.png、RM8-PS1-map-390.png（均位于 .handoff/）。已查看要求的三张截图。
- 无数据 / schema 改动，无新增依赖；未改后端 / API / scraper / DB / P3，未访问真实 DMS，未写凭据，未 commit / push / 部署。工作区已有改动保留。项目没有 lint / build scripts。
- 技术实现待 review，UI 仍待 Product Owner 预览签收。

- 最终检查：npm.cmd test 494/494 通过（原基线 487，新增 7 项）；日志 .handoff/RM8-PS1-tests.log。git -c core.safecrlf=false diff --check 无输出、退出码 0（仅此命令关闭原有 LF/CRLF 提示）。RM8-AC1 至 AC4、PS1-AC1 至 AC4 技术检查通过。

- 第 1 轮修复（2026-10-08）：仅用限定在 #profiles 内的 CSS 将表头统一为 14px / 600、上下 padding 12px 和垂直居中，重置排序按钮默认间距并用 inline-flex 对齐文字与箭头，保留数字右对齐、分隔线、强调箭头及 hover / focus；功能、数据、表体和其他表格不变。合成数据浏览器检查确认整行文字坐标一致、1440 / 390 无页面横向滚动，排序 / aria-sort、ZIP 高亮、详情弹窗及地图回归通过，无 console / page error；覆盖两张画像截图，新增 .handoff/RM8-PS1-profile-1440-r1.png。npm.cmd test 494/494 通过，没有调整既有测试断言，无 lint / build scripts；git -c core.safecrlf=false diff --check 无输出。复核脚本及日志：.handoff/RM8-PS1-r1-browser-check.mjs、RM8-PS1-r1-browser.log、RM8-PS1-r1-tests.log。UI 仍待 Product Owner 预览签收。
