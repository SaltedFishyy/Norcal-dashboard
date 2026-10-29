# 线路档案 DSP 筛选（PD1）

- **状态：** Approved（Product Owner 2026-10-29 提出需求，并确认 PD1-3 中的两个决定）
- **相关文档：** `docs/features/profile-zip-search.md`（PZ1 ZIP 搜索）、`docs/features/route-detail.md`（线路详情弹窗）、`docs/features/route-map.md` RM7（地图 DSP 筛选）

只改前端。**不改** API、数据、DB、scraper，不新增依赖，**不新增 web 文件**（静态白名单固定，见 WH-FIX1）。

## PD1-1 目标

用户可以在线路档案里按 DSP 查看它名下当前所有 Route。

## PD1-2 现状（Claude 检查）

- 线路档案（`web/index.html` + `web/app.js`）一次只显示一个站点：`/api/route-profiles?station=…` 返回 `rows`，每一行都有 `dsp_name`。没有“全部站点”视图，所以 DSP 选项来自当前站点的 rows。
- 地图已经有生成 DSP 选项的 `dspOptions(routes, focusStation)`（`web/map-state.js`，去空白、去重、排序）。**复用**它：把它移到两个页面共用的 `web/format.js`，`map.js` 和测试改为从 `format.js` 导入（行为不变），避免线路档案依赖地图模块。
- 地图的 DSP 不持久化（每次加载都是全部 DSP）；线路档案保持一致，也不持久化。

## PD1-3 规则

| # | 规则 |
|---|---|
| R1 | 在“站点”下拉框旁边加“DSP”下拉框 `id="profile-dsp"`，第一项是“全部 DSP”（value 为空）。样式和现有下拉框一致。数据加载完成前为 disabled。 |
| R2 | 选项 = 当前站点 rows 中非空 `dsp_name` 的去重排序列表（`dspOptions(rows)`）。没有任何 DSP 时只有“全部 DSP”。 |
| R3 | 选择某个 DSP 后，表格只显示 `dsp_name`（trim 后）等于该 DSP 的行。排序（Pickup Volume / PPH）在筛选后的行上照常生效。“全部 DSP”时显示当前站点的全部行。 |
| R4 | 切换片区或站点后，如果当前 DSP 不在新站点的选项中，自动重置为“全部 DSP”；如果还在，保留。 |
| R5 | **线路总数**（Product Owner 决定）：全部 DSP 时显示站点总数（例如 `45`）；选了 DSP 时显示 `筛选数 / 全部数`（例如 `12 / 45`）。 |
| R6 | 切换 DSP 时：清除 ZIP 搜索结果和高亮行，关闭已经打开的线路详情弹窗（与切换站点的行为一致）。ZIP 输入框的内容保留。 |
| R7 | **ZIP 搜索结果不在当前 DSP 中**（Product Owner 决定：提示后让用户切换）：定位流程不变（需要时仍然会切换片区 / 站点）。如果切换后目标线路被当前 DSP 筛掉，不自动改筛选，而是显示：`ZIP 95111 · 站点 SFO01 · 线路 SFO01-051 · DSP SFO-UNS · 不在当前 DSP 筛选（SFO-DAE）中`，并附一个按钮“显示该线路”。点击按钮后：DSP 改为“全部 DSP”，然后按正常流程高亮该行并打开线路详情。这条规则也适用于 multi_station 的选择按钮。 |
| R8 | 只做前端筛选，不修改 `renderedData` / 原始 rows；重新排序或重新渲染时从完整数据开始筛选。 |
| R9 | 390 宽度不能出现横向滚动；1440 宽度下和现有筛选器排在一行，或者沿用现有的换行规则。 |

## PD1-4 验收标准

- **PD1-AC1** 有 `#profile-dsp`，第一项是“全部 DSP”；选项只来自当前站点，去重、排序、不含空值；加载前为 disabled。
- **PD1-AC2** 选择某个 DSP 后，表格只剩该 DSP 的行；排序仍然正确；选回“全部 DSP”后恢复全部行。原始数据不被修改。
- **PD1-AC3** 切换站点 / 片区：DSP 不适用时重置为“全部 DSP”，适用时保留；选项重新生成。
- **PD1-AC4** 线路总数按 R5 显示。
- **PD1-AC5** 切换 DSP 时清除 ZIP 结果和高亮，并关闭弹窗；ZIP 输入框的内容保留。
- **PD1-AC6** ZIP 搜索：目标线路在当前 DSP 中时，行为和现在一样；不在时显示 R7 的提示和按钮，不自动修改筛选；点击按钮后切回“全部 DSP”，高亮该行并打开详情。过期的 ZIP 请求不能覆盖新的结果（沿用 `zipSequence`）。
- **PD1-AC7** 地图页的 DSP 行为不变（`dspOptions` 移到 `format.js` 后，地图相关测试继续通过）。
- **PD1-AC8** Claude 在 Chrome 中检查 1440 和 390 宽度：筛选、总数、ZIP 跨 DSP 提示都正确，没有横向滚动。

## 实现记录（Implementation Notes）

### PD1（2026-10-29）

- `dspOptions` 原样移入 `web/format.js`；地图和对应测试只调整导入。保留工作区原有 RM10 / RM11 改动。
- 档案页增加内存中的 DSP 状态和下拉框：按当前站点生成选项，加载中 / 出错时禁用，不适用时重置。每次从完整 rows 筛选后排序，原始数据不变；总数显示站点总数或“筛选数 / 全部数”。空 rows 时保留唯一的“全部 DSP”。
- DSP 切换复用 `invalidateZip()`，保留输入、清除反馈和高亮、关闭详情。ZIP 定位先检查完整快照中的目标，再判断 DSP；被排除时提供显式按钮。按钮先验证 sequence，再清除筛选；共用 `highlightZipRoute` 完成高亮和详情定位。
- 在 `profile-zip-search.test.js` 增加 3 项综合测试，覆盖选项、重置 / 保留、排序、总数、冻结源数据、禁用状态、ZIP 清理、过期查询 / 按钮及多归属定位。现有 `district-config.test.js` 的唯一旧断言“不存在 DSP select”改为检查新增 select 初始禁用；其余既有断言不变。
- 相关测试 37/37 通过。全套测试首轮 620/621 通过，唯一失败为上述旧断言，已修正。项目无 lint / build scripts。`git diff --check` 通过（Git 另有 LF → CRLF 提示）。
- 修正后重跑 `npm.cmd test`：621/621 通过，失败 / 跳过均为 0；最终 `git -c core.safecrlf=false diff --check` 无输出、退出码 0。
- 使用已安装 Playwright / Chromium 和临时本地 HTTP 合成 API 检查实际页面，1440 / 390 下筛选、总数、ZIP 跨 DSP 提示、显式显示、线路和 ZIP 高亮均通过，无页面横向滚动、console / page error。脚本 `.handoff/PD1-browser-check.mjs`；全套测试日志 `.handoff/PD1-tests.log`。无需调整 CSS。
- 无 API、生产数据或 schema 改动，无新增依赖，不访问 DMS，未 commit / push / 部署；全套测试沿用项目现有独立测试数据库。PD1-AC1 至 AC7 技术检查通过；AC8 仍按 brief 待 Claude Chrome 复核及 Product Owner 预览签收。
