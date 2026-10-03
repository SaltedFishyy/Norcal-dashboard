# Tableau Route Map（Station → Route → ZIP 地图）— Spec

- Status: **Tableau Desktop / workbook 路线：Paused / not selected**（Product Owner 2026-10-02：地图改为直接做进 NC Ops Console，见 `docs/features/route-map.md`）。
  - **仍然有效、被 Web Route Map 复用的部分**：边界数据源决定（M1、M2、M6、第 3 节）、TBL1.5 的数据来源结论、TBL2 的 `postal_codes` 和 Route-ZIP 导出、TBL3 的边界截取和覆盖结果。
  - **暂停的部分**：Tableau Desktop MVP（第 5、5.1 节）、`.twbx` 存放（M7）、Tableau 颜色方案（M8 的 Tableau 部分）。
  - 历史：TBL1 设计 Approved；TBL1.5 阶段 A 完成；TBL2 已实现并提交；TBL3 边界准备完成，Tableau MVP 未搭建。
- 更新：2026-10-02
- 相关：`docs/tableau.md`；`docs/data-schema.md` 第 10 节；`docs/features/route-detail.md`；`docs/features/dms-refresh.md`（D8 全局站点）；`docs/open-questions.md`「Tableau Route Map」

---

## 1. 目标

在 Tableau Desktop 中做一张新的 Route 地图：选择一个 Station，显示该 Station 覆盖的 ZIP 区域，每个 ZIP 是真实的地理 polygon，**颜色只表示 Route**。

不要求复用旧 dashboard 的地图或 GeoJSON。

## 2. 已确认的决定（Product Owner 2026-10-02）

| # | 决定 |
|---|---|
| M1 | **边界数据源：Census 2020 ZCTA，1:500k cartographic boundary（`cb_2020_us_zcta520_500k`）**，按服务区 ZIP 截取。旧 dashboard 内嵌的 GeoJSON（Census ZCTA5 简化版，442 个 ZIP）只作参考，不作为正式来源 |
| M2 | **ZCTA ≠ USPS 实际投递 ZIP 边界。** 这张图用于看 Route 大致覆盖区域，**不用于判断具体地址归属** |
| M3 | Station → Route → ZIP 数据来源：**优先方案 D**——先做一次受控、只读探索（TBL1.5），找 DMS 是否有 Station 级批量的 Route → ZIP 来源。**没有找到低负载来源时停止，不自动改成逐 Route 全量抓取**，由 Product Owner 再决定 A（人工 CSV）/ B（旧 roster）/ C（逐 Route 抓取） |
| M4 | 输入表一行 = 一个 Station 下某条 Route 的一个 ZIP；只放身份字段（第 4 节），不放 Difficulty / PPH / Volume 或其他指标 |
| M5 | ZIP 归属冲突（同 Station 内一个 ZIP 属于多条 Route；或一个 ZIP 属于多个 Station）**不自动选一条**：导出 / 校验阶段报告 conflict、保留冲突行，等 Product Owner 决定业务规则 |
| M6 | 没有 ZCTA polygon 的 ZIP **不伪造 polygon**；MVP 显示 “Mapped X / Total Y” 和 Missing Boundary ZIP 清单。点位显示（point fallback）以后再议 |
| M7 | 工具：**Tableau Desktop**。**不使用 Tableau Public**（内部运营数据）。`.twbx` 暂不提交 Git，以后再决定存放位置（Tableau Server / Cloud 或其他内部位置） |
| M8 | 颜色：Color by Route（同 Route 同色）。不用颜色表示 Difficulty。单 Station Route 多时离散颜色会重复，第一版接受；为降低歧义：ZIP polygon 保留清楚的边界线、Tooltip 必须显示 Route Name、不只靠颜色识别 Route |

## 3. 边界数据（TBL1）

### 3.1 数据源比较结论（2026-10-02）

| 来源 | 结论 |
|---|---|
| 旧 dashboard `index.html` 内嵌 `zipgeo` | 实际就是 Census ZCTA5 简化版：442 个 ZIP、约 3.4 万顶点、约 0.87 MB。没有来源脚本、无法复现或扩展，边缘已简化 → 仅作参考 |
| **Census 2020 ZCTA cb 1:500k** | 官方公开数据（public domain），可复现，按 ZIP 截取后体积小；Tableau 原生支持 shapefile → **正式方案** |
| Tableau 内置 ZIP 地理编码 | 零导入，但边界版本随 Tableau 版本变化、不可控 → 只可在 TBL3 原型时对照，不作为正式来源 |
| Esri / 商业 ZIP 边界 | 最贴近 USPS，但需付费授权 → 第一版不用 |

Census 1:500k 全国 shapefile 约 316 MB（1:5m 约 8 MB，城区 ZIP 过粗，不采用）。ZCTA 只在十年一次的人口普查时更新，2020 年之后新设的 ZIP 没有 polygon。

### 3.2 ZCTA 覆盖缺口（实测）

ZCTA 由人口普查街区拼成。PO Box 专用、单一机构使用、或地址很少的 ZIP 通常没有 ZCTA。

- SFO01-001（DMS 真实数据，21 个 ZIP）中 **6 个没有 polygon**：94604、94615、94617（DMS 标记 `postalCodeTag = "1"`）、94623、94662、94701。这些 ZIP 在 DMS 中的指标都是极少量样本或为空。
- 旧 dashboard roster 中也有 16 个 ZIP 没有边界。
- 影响：地图上这些 ZIP 没有面可画；如果用 inner join，它们会从图上静默消失。因此 MVP 必须用 **left join（以 Route-ZIP 表为准）**，并显示覆盖率和缺失清单（M6）。

### 3.3 截取产物（TBL2 / TBL3 时生成，未开始）

- 从 Census 下载 `cb_2020_us_zcta520_500k`（需要联网，Codex 沙箱做不到，由 Claude 在 Product Owner 本机执行），只保留 Route-ZIP 表中出现的 ZIP（包含 NV，例如 RNO01）。
- 截取工具可临时使用（例如 `npx mapshaper`），**不加入 `package.json`**。
- 产物和来源说明（下载 URL、vintage、截取日期、ZIP 数）放进仓库；具体路径在 TBL2 时确定。

## 4. Route-ZIP 输入表（TBL2 定稿）

字段定义见 `docs/data-schema.md` 第 10 节。概要：

```text
station | route_id | route_name | postal_code | source | fetched_at
SMF01   | 123      | SMF01-017  | 95667       | dms    | 2026-10-02T18:24:33Z
```

- `postal_code` 为 5 位字符串，保留前导 0，不转数字。
- 校验（TBL2 实现）：
  - `postal_code` 必须匹配 `^\d{5}$`，否则报告并保留原值。
  - 同一 Station 内一个 ZIP 属于多条 Route → conflict。
  - 一个 ZIP 属于多个 Station → conflict。
  - conflict 不自动消解，导出结果中保留冲突行并单独列出（M5）。
- 导出文件写到本机 runtime 目录，**不进 Git**（内部运营数据）。

### 4.1 TBL2 决定（Product Owner 2026-10-02）

- **正式来源**：现有 Route Profile 列表接口（T3 已在使用）的 `postalCodeList` / `postalCodeNum`。不新增 DMS 请求。M3 由此关闭。
- normalized Route Profile 新增 **`postal_codes: string[]`**（不叫 `postal_code_list`）；`raw` 继续保留 `postalCodeList`、`postalCodeNum` 原值。字段定义见 `docs/data-schema.md` 第 8 节。
- transform 校验：每个 ZIP 是 5 位字符串；`postal_codes.length === postalCodeNum`；同一 Route 内不重复；同一 Station 内一个 ZIP 不属于多条 Route。**任一不通过 → 整次抓取失败并报告，不自动解决**（M5 更新为“失败并报告”）。
- `schema_version` 保持 1，`postal_codes` 为向后兼容新增字段：新 snapshot 必须写；旧 snapshot 缺失时 reader / API 仍可读取；不做 migration。
- 新增导出 `npm run export:tableau-route-zips`：只读 `route-profiles.json`，生成 `runtime-data/tableau/route-zips.csv`（字段见 `docs/data-schema.md` 第 10 节），不进 Git。
- 真实验证只用 SFO01：51 条 Route、269 行、269 个唯一 ZIP、0 冲突；SFO01-001 的 21 个 ZIP 与 Route Detail 缓存一致。
- 本次不做：切换 SMF01 / D8、Tableau workbook、TBL3、多 Station 批量、自动刷新、边界截取。

## 5. Tableau MVP（TBL3，未授权）

- 数据：Route-ZIP CSV **left join** 截取后的 ZCTA 边界，`postal_code` = `ZCTA5CE20`。
- 地图工作表：Geometry → Detail；Color = `route_name`；Station 单选筛选；Tooltip：ZIP / Route / Station；ZIP polygon 有清楚的边界线。
- 覆盖率：“Mapped X / Total Y”（按当前 Station）。
- Missing Boundary ZIP 清单（当前 Station 中没有 polygon 的 ZIP，含 Route）。
- 不做：Difficulty、PPH、Volume、自动刷新、dashboard 嵌入、Route label、point fallback、复杂颜色策略。

### 5.1 Tableau Desktop 搭建步骤（TBL3 MVP）

输入：
- `%LOCALAPPDATA%\nc-ops-console\runtime-data\tableau\route-zips.csv`（`npm run export:tableau-route-zips` 生成；内部数据，不进 Git）
- 仓库中的 `geo/zcta2020_sfo01.geojson`（边界，来源见 `geo/README.md`）

1. **连接数据**：Connect → Text file → `route-zips.csv`。在数据源页把 `postal_code` 和 `route_id` 的类型改为 **String**（Tableau 可能默认推断为数字）。
2. **加入边界**：在同一数据源里再添加连接 Spatial file → `zcta2020_sfo01.geojson`。拖到画布上，选择 **Left Join**，左边是 `route-zips.csv`，条件 `postal_code = postal_code`（GeoJSON 一侧也是字符串）。**必须是 left join**，这样没有 polygon 的 ZIP 仍然保留在数据中。
3. **计算字段**：
   - `Has Boundary` = `NOT ISNULL([Geometry])`
   - `Mapped ZIP` = `COUNTD(IF [Has Boundary] THEN [postal_code] END)`
   - `Total ZIP` = `COUNTD([postal_code])`
   - `Coverage Label` = `"Mapped " + STR([Mapped ZIP]) + " / Total " + STR([Total ZIP])`
4. **地图工作表（Route Map）**：双击 `Geometry`；`route_name` → Color；`postal_code` → Detail；在 Color 的 Border 中选深灰色细边界；Tooltip 编辑为 `ZIP: <postal_code>` / `Route: <route_name>` / `Station: <station>`。右下角 “N unknown” 是没有 polygon 的 ZIP，属于预期现象。
5. **Station 筛选**：`station` → Filters，显示为 Single Value（dropdown），并设为 Apply to Worksheets → All Using This Data Source。
6. **覆盖率工作表（Coverage）**：`Coverage Label` → Text。
7. **缺失清单工作表（Missing Boundary ZIP）**：`route_name`、`postal_code` → Rows；`Has Boundary` → Filters，只保留 False。
8. **Dashboard**：Route Map 为主体，旁边放 Coverage 和 Missing Boundary ZIP。
9. **保存**：本机保存为 `.twb` 或 `.twbx`，放在仓库外（例如 `%LOCALAPPDATA%\nc-ops-console\tableau\`）。**不提交 Git、不发布到 Tableau Public。**

SFO01 当前的预期结果：Coverage 显示 `Mapped 254 / Total 269`，缺失清单 15 行（见 `geo/README.md`）。

## 6. 实施顺序

| 阶段 | 内容 | 状态 |
|---|---|---|
| TBL1 | 确认并记录 Census ZCTA 边界方案 | **完成**（本文档第 2、3 节） |
| TBL1.5 | 受控、只读探索 DMS 的 Station 级 Route → ZIP 数据来源 | **完成**（阶段 A；阶段 B 不需要），见实现记录 |
| TBL2 | Route Profile 增加 `postal_codes` + 校验；Route-ZIP CSV 导出 | **授权实现（2026-10-02）**，见第 4.1 节。边界截取不在本次范围 |
| TBL3 | 边界准备 + Tableau MVP（第 5 节） | 边界准备**完成**（见实现记录，被 Web Route Map 复用）；Tableau MVP **Paused / not selected**（2026-10-02） |
| TBL4 | 自动更新、dashboard 嵌入、更多指标 | Paused（随 Tableau 路线暂停） |

## 7. 验收标准（TBL2 / TBL3，届时细化）

- **TBL-AC1** Route-ZIP 表符合 `docs/data-schema.md` 第 10 节；`postal_code` 全部是 5 位字符串；没有指标字段。
- **TBL-AC2** 归属冲突被检测并报告，冲突行保留，没有自动选择。
- **TBL-AC3** 边界文件来源可追溯（URL、vintage、截取日期），只含服务区 ZIP，`package.json` 未新增依赖。
- **TBL-AC4** Tableau MVP 满足第 5 节；没有 polygon 的 ZIP 不会从统计中消失（Mapped X / Total Y 与 Route-ZIP 表行数一致）。
- **TBL-AC5** 不使用 Tableau Public；`.twbx` 和导出的 CSV 不在 Git 中。
- **TBL-AC6** Product Owner 在 Tableau Desktop 中预览签字。

## 实现记录（Implementation Notes）

### TBL1.5 阶段 A — DMS Station 级 Route → ZIP 来源（2026-10-02，Claude 本机受控探索）

- 范围：Product Owner 只批准阶段 A。全局站点保持 SFO01（页头确认），未切换；打开路区画像页面 1 次 + 与 T3 相同的查询 1 次（转运站点 SFO01、每页 100）。没有打开其他页面，没有点击导出 / 下载 / 详情 / 编辑 / 保存。
- 请求：`/prod-api/` 共 20 个（上限 30），其中列表请求 3 个（= 上限，与 T3 相同：默认加载 1 + 切换每页条数 1 + 查询 1）。无 429 / 5xx，session 有效，没有写操作请求被拦截。原始响应存于 `%LOCALAPPDATA%\nc-ops-console\tbl15-exploration\`（仓库外）。
- **结论：T3 已经在使用的列表接口 `POST …/roadAreaPortrait/home/frontPage/queryList/pagination` 每条记录都包含 `postalCodeList`（逗号分隔的 ZIP 字符串）和 `postalCodeNum`。** T3 transform 当时没有保留这两个字段。不需要逐 Route 进入画像详情。
  - 请求体：`{pageNum: 1, pageSize: 100, siteHandleType: "ALL", transitStationCodeList: [<站点内部 ID>], pageType: ""}`；SFO01 一页返回全部 51 条（`total` 51）。
  - 字段映射：`station` ← 抓取时选择的 Station（记录中 `transitStationName` 全部为 SFO01，可用于校验）；`route_id` ← `roadAreaId`（number，51 个唯一，与 T3 snapshot 的 51 个 route_id 完全相同）；`route_name` ← `roadAreaName`；`postal_code` ← `postalCodeList` 按逗号拆分。
  - 校验：51 / 51 条 Route 的 `postalCodeList` 非空；共 269 行 Route-ZIP，269 个唯一 ZIP；每条 Route 拆分后的数量都等于 `postalCodeNum`（总和 269）；全部是 5 位数字（列表中不带 `NEW` 后缀）；**没有任何 ZIP 属于多条 Route**（SFO01 内无冲突）。
  - 与 SFO01-001 已缓存的 Route Detail（21 个 ZIP）对比：完全一致（无缺失、无多余）。
  - 粗略覆盖（用旧 dashboard 的 ZCTA 作参考，正式数字待 TBL2 用 Census 原始文件计算）：253 / 269 个 ZIP 有 polygon；缺 16 个：94018、94537、94604、94615、94617、94623、94624、94662、94701、95036、95056、95151、95152、95156、95164、95173。
  - 分页：`total` 超过每页条数时需要翻页（页面最多可选 500 条 / 页），SFO01 不需要。
- 启动阶段的菜单树接口为 `GET /prod-api/bas-baseapi/pc/getRouters`；含关键词的菜单项有「快递员工作区域」「任务区域设置」「站点管理」等。由于列表接口已经满足需求，阶段 B 不需要。
- 其他 Station（例如 SMF01）仍取决于 D8（切换页头全局站点）的授权。

### TBL2 — postal_codes 校验与离线 CSV 导出（2026-10-02，Codex）

- 新增纯函数模块 `server/src/transform/postal-codes.js`：解析和校验 ZIP 格式、数量、Route 内重复及 Station 内冲突。`transformRoutePortrait` 新增 `postal_codes`，raw 保留 `postalCodeList` / `postalCodeNum`；失败抛 `SchemaError`，现有抓取 CLI 不写 snapshot，并记录失败原因。
- 新增共用 `writeFileAtomic`：同目录临时文件、`wx`、`mode 0o600`、rename、finally 清理。两个 store 和 CSV 共用；原有对外签名和错误类型保留。新增只读 `readRouteProfiles`，沿用文件和 snapshot 校验；旧 snapshot 的 reader / API 不要求 `postal_codes`，`schema_version` 仍为 1。
- 新增纯导出模块 `server/src/export/tableau-route-zips.js`、CLI `server/bin/export-tableau-route-zips.js` 和 `npm run export:tableau-route-zips`。只读取配置指定 runtime 中的 snapshot，按实际 Station 展开六列、稳定排序、UTF-8 无 BOM、LF、RFC 4180 转义；复用 ZIP 校验。raw 来源字段存在时复核数量及 normalized / raw 一致性。同 Station / 跨 Station 冲突报告 ZIP 和 Route 身份明细，拒绝写 CSV；缺字段提示对应 Station 的重新抓取命令。
- 成功原子写入 `<runtime>/tableau/route-zips.csv`，打印每 Station Route 数 / 行数 / 唯一 ZIP 数、冲突数 0 和输出路径；失败退出码为 1，保留旧 CSV。
- 新增 `postal-codes.test.js`、`atomic-file.test.js`、`tableau-export.test.js` 并接入入口。原有 T3 测试仅在字段 keys 期望增加 `postal_codes`；合成 fixture 三条 Route 分别改为 3 / 4 / 5 个互不重叠的虚构 ZIP，保留 `00123`。其余 T3 / CLI 断言未修改。
- 验证：`npm.cmd test` **184/184 通过**；`git diff --check` 通过；新增 npm 命令在临时合成 snapshot 上执行成功、核对 CSV 后移除临时目录。未配置 lint / build。旧 snapshot 通过 reader 和实际 loopback HTTP API 测试；两个 store 原有测试继续通过。
- 未新增依赖，未修改 frontend / legacy，未访问真实 DMS、真实 session 或真实 runtime data，未 commit / push / deploy。真实 SFO01 的 51 Routes / 269 ZIP 验证留给 Claude 本机执行；本次不生成真实 CSV 或 Tableau workbook。已有文档改动保留，仅追加本记录。

### TBL2 本机真实验证（2026-10-02，Claude 在 Product Owner 本机运行）

- `npm test` 184/184 通过；`git diff --check` 通过。
- `npm run dms:scrape -- --station SFO01`：与 T3 相同路径，列表请求 3 个，51 行，`parse_errors` 0，校验通过（无冲突）。新 snapshot：`schema_version` 1，每行都有 `postal_codes`，raw 含 `postalCodeList` / `postalCodeNum`。
- `npm run export:tableau-route-zips`：`runtime-data/tableau/route-zips.csv`，表头 `station,route_id,route_name,postal_code,source,fetched_at`，**51 条 Route、269 行、269 个唯一 ZIP、0 冲突**；全部是 5 位字符串；按 station → route_name → postal_code 排序；`source` = `dms-playwright`；`fetched_at` = snapshot 抓取时间；UTF-8 无 BOM、LF 换行。
- SFO01-001：CSV 中 21 个 ZIP（route_id 831）与 Route Detail 缓存完全一致；全部 Route-ZIP 组合与 TBL1.5 阶段 A 的列表响应完全一致。
- 向后兼容：用抓取前备份的旧 snapshot（无 `postal_codes`）验证——`getStationSnapshot` 正常读取 51 行；导出失败并提示 `npm run dms:scrape -- --station SFO01`，退出码 1，没有写出 CSV。

### TBL3 边界准备（2026-10-02，Claude 在 Product Owner 本机执行）

- 从 Census 下载 `cb_2020_us_zcta520_500k.zip`（约 66 MB，HTTP 200），解压到仓库外 `%LOCALAPPDATA%\nc-ops-console\geo-source\`；全国原始文件不进 Git。
- 用 `npx --yes mapshaper@0.6` 截取（临时工具，`package.json` 未改）。输入为 `route-zips.csv` 中 SFO01 的 269 个 ZIP。全国 33,791 个 ZCTA 中保留 254 个，生成 `geo/zcta2020_sfo01.geojson`（约 0.86 MB，WGS84，只有 `postal_code` 一个属性，5 位字符串，每个 ZIP 一个 feature）。
- 覆盖：**Total 269 / Mapped 254 / Missing 15 / Coverage 94.42%**，缺失清单见 `geo/README.md`。没有伪造或猜测 polygon。与旧 dashboard 简化版相比，94018 在 2020 原始数据中有 polygon。
- 优先使用 GeoJSON；只有 Tableau 版本出现兼容问题时才另外生成 shapefile，本次没有生成。
- 本机没有安装 Tableau Desktop（注册表中未找到），MVP 由 Product Owner 按第 5.1 节在装有 Tableau Desktop 的电脑上搭建。
