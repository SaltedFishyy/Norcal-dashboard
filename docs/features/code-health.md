# Code Health 清理（CH）

- 状态：Approved（Product Owner 2026-11-16，“可以，你弄吧”）
- 来源：2026-11-16 代码审查（AGENTS.md 第 12 节 Minimal Change Footprint 之后的首轮清理）
- 原则：**只做结构整理，行为不变**。每个任务单独交给 Codex，单独 review，单独提交。

## 1. 目标

把审查中发现的三处真实重复 / 过大函数整理掉，降低以后改动时需要碰的文件数和理解成本。不改任何业务规则、API 输出、页面外观或爬虫抓取范围。

## 2. 范围

| 任务 | 内容 | 预期文件 |
| --- | --- | --- |
| CH-T1 | 合并 Pacific 日期 helper | `web/date-view.js`、`web/route-detail.js`、`server/src/api/date-view.js`、`server/src/api/freshness.js` + 测试 |
| CH-T2 | 把底图加载从 `createMapView` 移出 | `web/map-view.js`、新文件 `web/basemap-layers.js`（或同等命名）、`server/src/api/static-files.js` + 测试 |
| CH-T3 | 拆分 `runStationsBatch` 为几个小函数，行为不变 | `server/bin/dms-scrape-stations.js`（必要时新增一个同目录 / `server/src/dms/` 下的 helper 模块）+ 测试 |

不在范围：

- `web/data-status.js` 的 `pacificTime`（中文显示格式，非重复）、`web/format.js` 的 `formatUpdated`（本地时区）、`auto-refresh-scheduler.js`（可配置时区）。
- `dms-scrape-route-details.js` 的同类拆分（看 CH-T3 效果后另行决定）。
- 任何依赖、schema、数据迁移、抓取范围变化。

## 3. 验收标准

- **CH-AC1**：现有测试全部通过（`npm.cmd test`），`git diff --check` 干净。
- **CH-AC2**：行为不变——
  - CH-T1：日期结果与原实现逐一相同（含跨日 / 年边界的测试）；
  - CH-T2：service / 区域底图回退、缺失提示、覆盖范围刷新与原来一致；3200 页面底图、标注正常，地图性能不退化；
  - CH-T3：进度文件、日志、退出码、锁释放、state / record 写入的顺序和内容与原来一致；现有 worker / multi-station 测试不改断言即可通过（只允许为新 helper 增加测试）。
- **CH-AC3**：改动文件数不超过任务表“预期文件”；超出时 Codex 停下说明（AGENTS.md 第 12 节）。
- **CH-AC4**：每个任务在本文件末尾写实现记录。

## 4. 风险

- CH-T3 涉及 DMS 爬虫主流程，必须纯重构。不做真实 DMS 抓取验证（不在授权内），只靠现有测试和 fixture；Claude review 时逐段对照原代码。

## 5. 实现记录

### CH-T1（2026-11-16）

- 后端在 `server/src/api/date-view.js` 导出 `pacificDay(value)`，保留 `pacificToday(now)` 签名并委托给它；`server/src/api/freshness.js` 删除本地 `dayOf`，复用 `pacificDay`。
- 前端将 `web/route-detail.js` 的 `pacificToday()` 原样移到 `web/date-view.js` 并导出，新增 `pacificYear` 供 `dateOptions` 使用；前后端未互相 import。
- 测试改动：`server/test/date-view-api.test.js`、`server/test/date-view-web.test.js`。新增字符串 / Date / 时间戳、Pacific 跨日、夏令时、跨年和年份标签测试，并对照后端原实现；现有 freshness 断言未修改。
- 检查：`npm.cmd test` 共 911 项全部通过，0 失败、0 跳过；独立日期测试 7 项通过；`git diff --check` 通过。项目没有 lint / build 命令。一次未加载环境配置的定向测试因缺少 `NC_TEST_DB_*` 失败，正式完整测试中的对应 DB 测试通过。
- 使用 Playwright 检查已运行的 `http://127.0.0.1:3200/` 和 `/map`，均为 HTTP 200，未发现页面 JavaScript 异常；未逐项手动验收地图选择、ZIP 搜索和 legacy 分析页。未启停服务、部署、提交或推送。
- 本任务只改动四个预期源文件、上述两个测试文件及本实现记录；未改需求、验收标准或数据结构。

### CH-T2（2026-11-16）

- 将底图常量（含 BSD-3 许可注释）及加载逻辑原样移至新增的 `web/basemap-layers.js`；`web/map-view.js` 保留兼容导出、`loadBasemaps` 接口、`MAP_RENDER` 和 `ROUTE_LABEL`，从 690 行减少至 449 行。
- `server/src/api/static-files.js` 注册新模块；`server/test/route-map-web.test.js` 新增静态资源读取和直接 / 原接口调用等价测试，覆盖全部 9 层底图加入 map、请求顺序、Range 头、错误回调及覆盖刷新。现有断言未改。
- 对照 Git 原代码验证：常量、注释及加载函数体仅签名、缩进与 grid 参数替换，其他内容完全一致。新增测试单独运行通过。
- 第 1 轮修复按明确授权，仅将 `server/test/route-map-web.test.js:1301` 的源码读取路径从 `web/map-view.js` 改为 `web/basemap-layers.js`，保持 `protomaps.leafletLayer` 的匹配正则和断言不变。检查其他读取 `map-view.js` 源码的测试后，确认其检查内容仍在原文件，无需修改其他路径。
- 最终检查：`npm.cmd test` 共 912 项全部通过，0 失败、0 跳过；`git diff --check` 通过（Git 提示既有 CRLF 转换警告）。
- 未修改需求或验收标准、数据、依赖和其他既有工作区改动；未浏览器实测、启停服务、部署、提交或推送。项目没有 lint / build 命令。3200 底图、标注与性能复测仍待 Claude 执行。

### CH-T3（2026-11-16）

- 在 `server/bin/dms-scrape-stations.js` 内抽出并导出 `buildProgressValue`、`newStationRecord`、`guardRouteNameQuery`、`markStationStopped`、`buildRunRecord`。`runStationsBatch` 从 298 行缩短至 259 行（含函数签名和闭合括号，不含函数后的空行）。
- 保留 Station / Route 循环、`finishStation`、`diagnose`、session 回调和最外层 try/catch/finally；`validateStationList`、`safeType` 未修改。进度写入与错误处理留在原处，`automaticListSeen` 仍只在 switch 停止分支读取。
- 新增 `server/test/stations-batch-helpers.test.js` 并在 `server/test/index.js` 注册，覆盖五个 helper 的状态、字段、分页保护、Station 校验和停止计数。未修改任何现有测试断言。
- 重构前使用现有 multi-station 模拟 fixture 生成 `server/test/stations-batch-before.json`；新增完整批次对照测试，比较退出码、11 次 state/record 写入、9 次进度写入、日志和模拟页面事件。固定时间，只归一化环境相关的 runtimeDir 和随机 run_id；快照不包含真实 DMS 数据。
- 检查结果：新增测试独立运行 6 项通过；`npm.cmd test` 共 918 项全部通过，0 失败、0 跳过（含现有 worker / multi-station / 锁释放 / 双写错误路径测试）；`git diff --check` 通过，仅有 Git 的 CRLF 转换提示。项目没有 lint / build 命令。
- 本任务只改动一个预期源文件、测试入口、新增 helper 测试与模拟快照，以及本实现记录；未修改需求、验收标准、数据结构、依赖或其他既有工作区改动。未进行真实 DMS 抓取、浏览器访问、UI 手动检查、服务启停、提交、推送或部署。CH-AC1–CH-AC4 均满足，待 Claude review。
