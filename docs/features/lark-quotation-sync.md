# Lark 报价表同步 / Lark Quotation Sync（LQ）

- **状态：** Approved（Product Owner 2026-11-06）。LQ-T1 至 LQ-T4、LQ-T6 已实现；LQ-T5（正式库 migration、首次同步、开启 60 分钟定时同步、重启 Worker）经 Product Owner 2026-11-06 授权已执行，见第 12 节 LQ-T5 记录。Product Owner 2026-11-06 确认功能及 UI（签字）。
- **上游：** `docs/features/route-quotation.md`（RQ）。本功能是 RQ 第 12 节 **RQ-T4（导入入口）** 的具体化：把数据来源从「手动 xlsx 文件」换成「Lark 表格」。RQ 的数据库（migration 005）、当前价格规则（RQ 第 4.2 节）、API（RQ-T2）、地图 hover / 线路档案 / 价格详情（RQ-T3）全部复用，不另建价格缓存或第二套展示。
- **相关文档：** `docs/data-schema.md` 第 12 节、`docs/deployment.md`（环境变量、角色）、`docs/open-questions.md`「Lark 报价同步」、配置交接与表格验证结果 `docs/workflow/lark-quotation-handoff.md`（第 5.1 节）。
- **不做：** 聊天机器人、消息事件订阅、长连接 / 回调、AI 模型、自动回复、续票显示到主界面、电子围栏附加费、写回 Lark、自动替换无法匹配的线路。

---

## 1. 目标

后端读取 Lark 价格表，按 Route + ZIP 写入现有报价表，地图 hover、线路档案和价格详情自动显示当前首票价格。读取失败时保留上次成功数据；未找到报价显示 `—`，**永远不显示为 0**。

主界面显示范围不变（RQ-D9，Product Owner 2026-11-06 再次确认）：地图 hover 和线路档案只显示 **0–1 lb 首票价格**；其他重量段和续票只在价格详情显示。

## 2. 架构结论

```text
Lark Sheets API（应用身份 tenant_access_token，只读）
   → Lark client（取 token、读表，凭据只在后端环境变量）
   → 解析 / 校验（表头映射、日期、数值、空值；第 6 节）
   → 匹配 DMS 当前 Route（v_active_routes，精确 route_name → route_id）
   → 镜像比对（第 5 节）→ 同步计划（新增 / 不变 / 替换 / 作废 / 拒绝）
   → 写入 route_quotation_imports / lines / prices（单事务）
   → 现有视图 v_route_quotation_* → 现有 API → 现有 UI
```

- **只需要调用 Sheets 读取接口。** 不需要机器人能力、消息事件、回调地址或长连接。
- 运行位置：**Worker（3100，公用电脑本机）**。只读 server（3000 / readonly.env）不接触 Lark 凭据和写入角色。
- 不新增 npm 依赖：Node 内置 `fetch`。
- 分层（CLAUDE.md 5.1）：`server/src/quotations/lark-client.js`（HTTP）→ `lark-sheet-parse.js`（表头 / 单元格 → 规范行，纯函数）→ `quotation-sync-plan.js`（镜像比对，纯函数）→ `quotation-sync-db.js`（读当前行、执行计划）→ CLI / Worker。文件名为建议，Codex 可按现有结构调整，但各层不混写。

## 3. 现状核对（2026-11-06）

| 部分 | 现状 | 本功能 |
|---|---|---|
| 数据库 | migration 005 已提交（`6c8cf85`），**正式库未执行**；reader 只读视图 | 复用；migration 006 增加一列（第 4.1 节）；写入角色权限放在 migration 007（LQ-T6） |
| 当前价格规则 | RQ 4.2（洛杉矶自然日、有效期、最新生效优先、同日冲突拒绝） | 复用，不改 |
| API | RQ-T2 已提交（`f8bc03b`） | 复用，不改 |
| 地图 hover / 线路档案 / 详情 | RQ-T3 已提交（`5c75af6`） | 复用，不改 |
| 写入角色 | `nc_quotation` / `nc_test_quotation` 均未创建（2026-11-06 核对测试集群角色列表） | 创建角色属停止条件，LQ-T6 |
| Worker | `server/src/worker/worker.js`，无定时任务机制 | LQ-T4 增加可配置定时同步（默认关闭） |
| Lark 表格结构 | 2026-11-06 只读验证完成：链接中的 `iwYw5J` 是公式汇总的「总表」，不可用；SFO 分表 `uAaPvG` 结构与 RQ 模型一致 | 第一阶段只读 `uAaPvG`（LQ-D1） |

## 4. 匹配规则与字段

地图数据粒度：一个 polygon = DMS 当前 snapshot 中某 Station 下某 Route 的一个 ZIP（`station + route_id + postal_code`）。

| 维度 | 规则 |
|---|---|
| 线路 | C 列「线路名称/Route」原值（trim）→ 在 DMS active snapshot 中**精确**匹配 `route_name`，得到唯一 `route_id` 和 Station。找不到 / 多个 → 拒绝该行（`route_not_found` / `route_ambiguous`），**不模糊匹配、不自动替换线路**（RQ-D14；如 `SFO02-002`） |
| 邮编 | D 列 → 5 位数字字符串；与 `route_id` 组成报价键 |
| 站点 | A 列只保存原值（实际为 `SFO02` / `SFO`），Station 一律由线路解析 |
| 转运中心 | B 列「转运中心/Sorting Center」保存为 `fleet_name`，**不参与匹配** |
| 有效日期 | T 列生效、U 列结束；RQ 4.2 规则 |
| 第二票半价 | V 列「是否使用第二票半价」**只保存原值**（LQ-D5），不影响首票，不改变 M–S 续票价格的含义或计算，本阶段不在页面显示 |

### 4.1 migration 006（表结构）

`route_quotation_lines` 增加一列 `second_parcel_half_price_raw text`（可空，保存 V 列 trim 后原值；空单元格为 NULL）。另把 005 的 `UNIQUE (import_id, route_id, postal_code)` 替换为 `UNIQUE (import_id, route_id, postal_code, effective_from)`：镜像同步的一次导入可能包含同一 Route + ZIP 的多个生效日期（长期价 + 临时价 / 未来价，RQ 已允许），有效性仍由 `one_quote_per_key_day` 保证（Claude 2026-11-06 技术决定，LQ-T2 发现）。不改其他表、不改现有视图、不改角色权限。理由：Product Owner 要求保存原值（LQ-D5），且 006 尚未在任何正式环境执行。

### 4.2 来源范围（scope）

- 本功能写入的导入记录：`source='lark_sheet'`，`source_ref = 'lark:<spreadsheet_token>/<sheet_id>'`（固定格式，不含 revision）。
- **镜像比对只针对同一 `source_ref` 下未作废的行**；`manual_file` 等其他来源的行不会被本同步替换或作废。
- 与其他来源的未作废行同键（同 `route_id + postal_code + effective_from`）→ 拒绝该行（`conflict_other_source`），不动对方。

## 5. 同步语义：镜像（Product Owner 2026-11-06 确认，LQ-D2）

看板跟随表格：修改报价时更新，删除行时作废对应旧报价，历史保留。

| 表格本次状态（报价键 = `route_id + postal_code + effective_from`） | 处理 |
|---|---|
| 新出现的键 | 新增 |
| 键已存在，内容完全相同（14 个价格、结束日期、原值字段、备注） | 不变，不写库 |
| 键已存在，内容不同 | 作废旧行（`void_reason='lark_replaced'`），写入新行 |
| 数据库中有、表格中已没有的键 | 作废（`void_reason='lark_removed'`），地图自动回到更早的有效报价或 `—` |
| 历史 | 作废行不删除 |

保护规则：

1. **读取失败或表头校验失败：整次不改数据库**（不写导入记录、不作废），只记录同步状态。
2. **拒绝行不能当作删除（LQ-D2）。** 被拒绝的行如果能识别出「线路名称 + 邮编」，则数据库中该线路名称 + 邮编下的所有在用行都受保护，不作废，并记警告 `protected_by_rejected_row`。被拒绝的行连线路名称或邮编都无法识别时，**本次不执行任何「删除作废」**（新增 / 替换照常），记警告 `removals_skipped`。
3. **大幅减少中止：** 本次要作废为 `lark_removed` 的行数超过本来源在用行数的 20%（可配置，`LARK_QUOTATION_MAX_REMOVAL_RATIO`，默认 `0.2`）时，整次中止、不写库，结果为 `aborted_mass_removal`。在用行数为 0 时不适用。
4. 同一次读取内重复的报价键 → 这些行全部拒绝（`duplicate_in_sheet`），不挑选，且按第 2 条保护对应旧行。
5. 计划中没有新增 / 替换 / 作废时 → 不新增导入记录，结果为 `unchanged`。
6. 写入在**单个事务**中完成，并用 advisory lock（如 `nc:quotation-sync:<source_ref>`）防止并发同步。

本节只适用于 `source='lark_sheet'`；RQ 第 8 节和 RQ-D13 对手动文件的「增量、同键同日不同内容为冲突」规则不变。

## 6. 数据处理规则

| 情况 | 处理 |
|---|---|
| 读取失败（网络、超时、token、权限、表格 / 工作表不存在） | 不写数据库；记录同步状态（时间、阶段、错误码）；地图继续显示上次成功数据 |
| 表头不匹配（缺少必需列或某重量段不唯一） | 整次中止，`header_invalid`，同上 |
| 空行（线路、邮编、价格全空） | 跳过，不计入拒绝 |
| 线路在 DMS 中找不到 / 多个 | 拒绝该行 |
| 邮编不是 5 位数字 | 拒绝该行 |
| 价格单元格为空 / 非数字 / 负数 / 超过两位小数 | 拒绝该行；**空值永远不转成 0**。浮点误差在 1e-6 以内的按两位小数取整 |
| 价格为 0 | **拒绝该行**（`price_zero`，LQ-D3） |
| 日期不是有效的 `MM/DD/YYYY`（读取时指定 `dateTimeRenderOption=FormattedString`；1–2 位月 / 日、4 位年，日历日期必须有效） | 拒绝该行；数字序列号或其他格式也拒绝 |
| 结束日期为空 | 长期有效 |
| 结束早于生效 | 拒绝该行 |
| 报价已过结束日期 | 照常保存为历史；当前价格规则自动不显示 |
| 邮编不在该线路当前 DMS ZIP 中 | 保存并警告（`zip_not_in_route`） |
| 转运中心与 DMS `dsp_name` 写法不同 | 不比较、不警告（写法本来就不同） |
| 第二票半价原值不是「是」/「否」 | 保存原值并警告（`half_price_flag_unexpected`） |

每个拒绝 / 警告记录：表格行号、线路名称原值、邮编原值、原因代码；**不记录价格值**。

### 6.1 表头识别

- 在前 5 行内按**表头文字**定位列，不按固定列号；表头文字先规范化（去空白 / 换行、小写、`(Ib)` → `(lb)`）。
- 必需列：线路名称、邮编、首票 7 段、续票 7 段（含「续票」或 `second and subse…`）、生效日期、结束日期。可选列：站点名称、转运中心、参考邮编、是否使用第二票半价、备注。
- 重量段识别需有边界（`0-1` 不能误配 `10-20`），每个「票型 × 重量段」恰好一列，否则表头无效。
- 数据从最后一个表头行的下一行开始（SFO：第 4 行）。
- 「总表」结构（只有 7 段、无首票 / 续票区分、无日期）必须判为表头无效（测试用例）。

## 7. 同步结果与状态

- 结果：`completed`（无拒绝）/ `partial`（有拒绝）/ `rejected`（有数据行但全部拒绝，不写库）/ `unchanged` / `header_invalid` / `fetch_failed` / `aborted_mass_removal`。
- 有写入时新增一条 `route_quotation_imports`：`source='lark_sheet'`、`source_ref`（第 4.2 节）、`status`（`completed` / `partial`）、`row_count`（数据行）、`accepted_count`（新增 + 替换）、`duplicate_count`（不变）、`rejected_count`、`errors`（拒绝清单）、`warnings`（警告 + 作废摘要），`imported_by='lark-sync'`。
- 每次尝试（含失败）写入 Worker runtime 目录下的状态文件（如 `quotation-sync-status.json`，原子写，复用现有原子写工具）：时间、结果、阶段、错误码、revision、计数。不含凭据、响应原文、价格。
- 页面：3100 数据状态显示「报价最近成功同步时间」「最近一次同步结果 / 失败原因」（LQ-T4）。3000 不新增显示（价格详情已有「报价更新于」）。

## 8. 凭据与安全

- App ID / App Secret 只放在**公用电脑 repo 根目录 `.env`**（已 gitignore，Worker 读取）。不放 `readonly.env`、前端、日志、Git、交接文本、命令行参数。
- 变量：

  ```text
  LARK_OPEN_API_BASE=https://open.larkenterprise.com   # 主机根地址，程序拼接 /open-apis
  LARK_APP_ID=<本机 .env>
  LARK_APP_SECRET=<本机 .env，不要粘贴到聊天>
  LARK_QUOTATION_SPREADSHEET_TOKEN=Wa9VsDiaphLSA3tpWzrcvp5lnAh
  LARK_QUOTATION_SHEET_ID=uAaPvG                       # 第一阶段只允许一个工作表
  LARK_QUOTATION_SYNC_MINUTES=0                        # 0 = 关闭定时同步
  LARK_QUOTATION_MAX_REMOVAL_RATIO=0.2
  NC_DB_QUOTATION_URL=<nc_quotation 连接串，LQ-T6 / LQ-T5 后填写>
  ```

- tenant_access_token 只在进程内存，按返回有效期提前刷新；日志 / 错误只含阶段和错误码，不含 token、Secret、请求头、响应原文。
- 只读表格权限；不写回 Lark。
- 写库角色 `nc_quotation`（LQ-T6）：SELECT `v_active_routes` / `v_route_detail_zips`、报价四张基表；INSERT 导入 / 行 / 价格；UPDATE 只限 `route_quotation_lines(voided_at, void_reason)`；序列 USAGE。不给 scraper / reader / warehouse / district 任何报价写权限。
- 在 LQ-T6 之前，正式同步命令（非 dry-run）在缺少 `NC_DB_QUOTATION_URL` 时直接拒绝运行，**不回退到 owner / scraper 连接**。LQ-T6 已完成（migration 007）。

## 9. 决策记录

| # | 决策（Product Owner 2026-11-06） |
|---|---|
| LQ-D1 | 第一阶段只读取 SFO 分表 `uAaPvG`（覆盖 DMS SFO01、SFO02）；其他站点之后逐个验证再加入 |
| LQ-D2 | 镜像语义（第 5 节）；读取 / 表头失败不改库；拒绝行不当作删除 |
| LQ-D3 | 价格 0 不是正常报价，拒绝并记录原因 |
| LQ-D4 | 地图 hover 和线路档案继续只显示 0–1 lb 首票价格（维持 RQ-D9） |
| LQ-D5 | 「是否使用第二票半价」不影响首票；本阶段只保存原值，不改变 M–S 续票价格计算规则 |
| LQ-D6 | 无法匹配的线路行（如 `SFO02-002`）不导入，报告原因，不自动替换线路 |

## 10. 验收标准

- **LQ-AC1** migration 006 只增加 `route_quotation_lines.second_parcel_half_price_raw`，并把行唯一约束改为 `(import_id, route_id, postal_code, effective_from)`；现有视图、reader 权限不变；迁移测试覆盖。
- **LQ-AC2** 表头识别与单元格解析（纯函数，输入为二维单元格数组）实现第 6 节；测试覆盖每一种拒绝 / 警告 / 跳过；「总表」结构判为表头无效。
- **LQ-AC3** 镜像同步计划（纯函数）实现第 5 节；测试覆盖新增、不变、替换、删除作废、拒绝行保护（可识别 / 不可识别）、表内重复、他来源冲突、大幅减少中止、`unchanged`。
- **LQ-AC4** 写库执行：单事务 + advisory lock；作废原因正确；作废行保留；结果在 `v_route_quotation_current` 中正确反映（测试库，以 owner 连接测试）。
- **LQ-AC5** Lark client：取 token（缓存 + 提前刷新）、查工作表、读范围（`valueRenderOption=UnformattedValue&dateTimeRenderOption=FormattedString`）；错误按阶段分类；超时；任何输出不含凭据。用假 HTTP 测试。
- **LQ-AC6** `npm run quotes:lark-check`：输出连接是否成功、工作表标题 / 行数、表头是否有效、数据行数；不输出价格和凭据。
- **LQ-AC7** `npm run quotes:sync-lark -- --dry-run`：用 reader 连接读取 DMS 当前线路（报价表不可读时视为无在用行并提示），输出计划统计和拒绝 / 警告清单（行号、线路、邮编、原因），不写库。非 dry-run 必须有 `NC_DB_QUOTATION_URL`，否则拒绝运行。
- **LQ-AC8** Worker 定时同步默认关闭（`LARK_QUOTATION_SYNC_MINUTES=0`）；开启后串行、不重叠；失败保留上次数据并写状态文件；3100 数据状态显示最近成功时间和最近结果。
- **LQ-AC9** `npm test` 全部通过；`git diff --check` 通过；不新增依赖。

## 11. 分阶段任务

| 任务 | 内容 | 执行者 | 依赖 / 停止条件 |
|---|---|---|---|
| LQ-T0 | Lark 后台配置、表格授权、本机 `.env` | Product Owner / ChatGPT | **2026-11-06 完成**（交接文档第 9 节） |
| LQ-T1 | migration 006 + 表头识别 / 单元格解析 + 镜像同步计划（纯函数）及测试（LQ-AC1–AC3） | Codex | — |
| LQ-T2 | 写库执行：读取本来源在用行、执行计划、单事务、advisory lock（LQ-AC4） | Codex | LQ-T1 |
| LQ-T3 | Lark client + `quotes:lark-check` + `quotes:sync-lark`（含 `--dry-run`）（LQ-AC5–AC7） | Codex | LQ-T2 |
| LQ-T4 | Worker 定时同步（默认关闭）+ 状态文件 + 3100 数据状态显示（LQ-AC8） | Codex | LQ-T3 |
| LQ-T5 | 正式库执行 005 / 006 / 007、首次同步、开启定时、服务重启 | Product Owner 批准后执行 | **另行授权**：正式 migration、服务重启、开启定时 |
| LQ-T6 | 创建 `nc_quotation` / `nc_test_quotation` 角色（管理员）+ migration 007 写入角色权限及测试 + `.env` 配置 | 管理员 + Codex | **另行授权**：角色创建；migration 007 必须在测试角色存在后才能加入仓库（否则所有 DB 测试的迁移会失败） |

## 12. 实现记录（Implementation Notes）

- LQ-T1（2026-11-06）：新增 migration 006，仅增加可空 `second_parcel_half_price_raw text`；未改视图、权限或 migration runner，未在正式库执行。
- `lark-sheet-parse.js` 和 `quotation-sync-plan.js` 均为纯函数。解析器的 `headerRowIndex` 为 JavaScript 0 基数组索引，`dataStartRow` / `sheetRow` 为表格 1 基行号（SFO 分别为 2 / 4 / 4 起）。表头错误 `detail` 返回缺少或不唯一的必需列代码数组。
- 计划的 `inserts` / replacement `insert` 使用数据库 snake_case 字段，另带 `sheetRow` 供后续执行层写入 `source_row`；价格保留 `first` / `additional` 对象。`unchanged` 返回 `{ sheetRow, line_id }`，`removals` 返回 `{ line_id, voidReason }`。拒绝 / 警告不含价格；`counts.plannedRemovals` 保留结果中止前的候选删除数。
- 新增已验证 SFO / 总表表头 fixture，以及使用合成价格的解析 / 计划测试；报价 DB 测试覆盖新列、reader 隔离和四个现有视图的完整列列表。现有 `refresh-migration.test.js`、`district-db.test.js`、`warehouse-db.test.js` 的迁移版本断言加入 006，runner 的 BEGIN / COMMIT 次数由 5 改为 6。
- 不涉及 HTTP、写库执行层、Worker、前端或依赖变更。保留工作区既有修改；`server/test/index.js` 只追加两个测试 import，原 language-switch import 保留。未偏离本任务需求和验收标准。
- LQ-T1 review r1（2026-11-06）：拒绝行仅在线路名称 trim 后非空且邮编为 5 位数字时按对应线路 + 邮编保护旧行；否则跳过本次全部删除作废并警告 `removals_skipped`，拒绝报告保留邮编原值；补充 4 / 6 位错误邮编及合法邮编价格为 0 的回归测试。

### LQ-T2（2026-11-06）

- 新增 `quotation-sync-db.js`：读取来源范围内未作废行及 14 个价格、其他来源的有效键；在同一事务内获取来源 advisory lock、重新读取、生成计划，先作废再插入。dry-run、rejected、aborted_mass_removal、unchanged 均回滚且不新增导入记录；作废更新行数不是 1 时回滚并报告并发修改，其他数据库错误统一为 `quotation_sync_failed`，不传播驱动错误中的价格或连接信息。
- 抽出 `server/src/db/active-route-profiles.js`，供现有线路档案数据源及同步执行层共同读取 `v_active_routes`。邮编来源是 active snapshot 的 `profile.postal_codes`，不是 snapshot ZIP 表或 `v_route_detail_zips`；只读 reader 可调用 `readActiveRoutes`。`readScopeLines` 的 bigint `line_id` 保持 pg 默认字符串，`route_id` / 价格转 Number，日期在 SQL 中转 text，空结束日期保持 null；读回后与同内容表格比对为 unchanged。
- 按任务补充授权修改 006：先在 `createTestDb` 测试库确认旧约束名为 `route_quotation_lines_import_id_route_id_postal_code_key`，再明确 DROP 并新增 `quotation_import_route_zip_day_key`（四字段）。005、部分唯一索引、现有视图、角色权限及迁移执行器均未改动，未执行正式库迁移。
- 新增 `quotation-sync-db.test.js` 并追加测试注册；使用 `createTestDb` 随机 schema、owner 写入和合成表格，验证首次导入 / 14 个价格、幂等读回、替换历史、同次导入多个生效日期、删除后回退 / 无报价、其他来源隔离、拒绝保护、删除比例阈值、dry-run、作废后价格插入失败完整回滚及错误脱敏。现有报价迁移测试补充新唯一约束、不同日期允许、同键拒绝及原部分唯一索引仍生效。
- 未改解析 / 计划纯函数、HTTP、CLI、Worker、前端或依赖；保留其他任务既有未提交改动。没有 `REQUIREMENTS.md`，按本 Approved spec 和任务 brief 实现。
- 验证：报价 DB 专项测试 10/10 通过；`npm.cmd test` 全量 743/743 通过，0 失败、0 跳过（含真实测试库）；`git diff --check` 通过。项目没有 lint / build 命令。本轮无前端修改，未进行浏览器人工检查；现有 DB 数据源、API、地图及交互的自动回归测试通过。未运行 `npm run db:migrate`、未访问非测试数据库、未创建角色、未提交 / 推送 / 部署或写入凭据。

### LQ-T3（2026-11-06）

- 新增 `lark-config.js`、`lark-client.js`、`lark-sync.js`、`lark-cli.js` 和两个薄 CLI 入口。配置统一 `/open-apis`，Secret 为不可枚举属性；HTTP 使用内置 fetch 和超时信号，token 仅内存缓存、提前 5 分钟刷新，失效码最多重试一次。错误只保留阶段、类别、HTTP 状态和数字错误码，不传播响应 msg 或底层异常。
- 按工作表元数据动态读取完整范围（支持 AD 等多字母列，超过 5000 行拒绝）；复用原解析器、计划和单事务执行层。dry-run 不开启写事务，当前线路使用 reader，scope 优先使用专用 writer 读取；42501 / 42P01 时使用空 scope 并提示 `scope_unavailable`。摘要仅返回计数、拒绝 / 警告、时间及元数据，不返回价格或来源 token。
- `quotes:lark-check` 不连接数据库；`quotes:sync-lark` 非 dry-run 在缺少 `NC_DB_QUOTATION_URL` 时于任何连接之前拒绝运行，不回退其他角色。命令输出警告代码统计和前 20 条警告，完整拒绝清单；数据库失败只输出 `quotation_sync_failed` 和 SQLSTATE。按 brief 补充授权，执行层脱敏错误保留合法五位 SQLSTATE，不附带原 message / detail / cause。
- 新增三个测试模块并注册，覆盖假 fetch 请求、缓存 / 刷新 / 单次重试、分类 / 超时 / 哨兵脱敏、范围 / 表头失败、只读降级、命令连接选择和拒绝回退；测试库集成覆盖 reader 无报价基表权限的 dry-run 和 owner 写入。未访问真实 Lark、非测试数据库，未查看或修改 `.env`；无 migration、依赖、Worker 或前端改动，保留工作区其他修改。
- 验证：专项 11/11 通过；最终 `npm.cmd test` 全量 754/754 通过，0 失败、0 跳过；`git diff --check` 通过。PowerShell 阻止 `npm.ps1`，使用 `npm.cmd` 运行同一 test script。项目无 lint / build 命令；本任务无 UI 修改，未运行浏览器人工预览或真实 Lark CLI 联调。

### LQ-T4（2026-11-06）

- 新增 `quotation-sync-scheduler.js`、`quotation-sync-job.js` 和 `quotation-sync-status.js`。调度使用 setTimeout 链，首次延迟 60 秒，之后从每次完成时起计算间隔；失败继续，停止后不再调度。超出 Node 单次 timeout 上限的间隔分段等待。默认未设置 / 0 不创建调度器，不读取 Lark 凭据；非法分钟数和 JSON 模式禁用且仅记录固定说明。
- 按 task brief 末尾澄清，任务只连接专用 `NC_DB_QUOTATION_URL`，不连接 reader，也不回退其他角色；保留 LQ-T1–T3 的 writer 同事务读取及失败回滚行为。每次尝试原子写入 runtime 的 `quotation-sync-status.json`，只有 completed / partial / unchanged 更新 last_success。状态及日志按结果代码、字段和值白名单投影，不包含拒绝 / 警告明细、价格、凭据或原始错误消息；数据库错误仅保留可用的合法 SQLSTATE。
- Worker 增加 `quotation_sync: true` capability 和 GET `/api/quotation-sync/status`，返回 enabled / interval_minutes / status，文件不存在时 status 为 null；关闭服务时停止调度。未增加手动触发 API，未改只读 server 入口和 capabilities。
- 新增独立 `web/quotation-sync-status.js` 并加入静态资源白名单；复用现有时间格式、样式和每分钟状态刷新，覆盖关闭 / 无历史 / 请求失败及所有结果中文文案。`web/data-status.js` 仅接入 import（第 2 行）、实例（第 63 行）、capabilities（第 246–248 行）、刷新（第 261 行）和 dispose（第 265 行），保留原有 language-switch 改动；未改 styles.css。
- 新增四个测试模块并注册：假时钟调度、假 Lark / writer 单次任务、Worker 启停与状态 API、页面 capability 隔离及全部结果文案。两个现有 Worker capabilities 精确比较断言补充 quotation_sync 字段，其他既有未提交改动保留。
- 浏览器冒烟使用现有 Playwright + headless Chromium，对共享数据状态组件的 Worker / readonly 两种 capability 完全拦截请求并提供合成响应；最终两者通过，无 console / page errors。初次冒烟脚本缺少 difficulty.js 拦截，补齐后又发现 PowerShell 管道把中文断言转换为问号，改为 Unicode 转义后通过。这是组件级浏览器验证，未替代完整地图 / 线路页面人工预览和 Product Owner 签字。
- 部署文档待另行补充：`LARK_QUOTATION_SYNC_MINUTES`（默认 0，仅 DATA_SOURCE=db 启用，非法值禁用）；启用所需 `LARK_OPEN_API_BASE`、`LARK_APP_ID`、`LARK_APP_SECRET`、`LARK_QUOTATION_SPREADSHEET_TOKEN`、`LARK_QUOTATION_SHEET_ID`、`LARK_QUOTATION_MAX_REMOVAL_RATIO`、`NC_DB_QUOTATION_URL`。本轮未改 docs/deployment.md、依赖、migration、角色或凭据，未开启真实同步、未重启 / 部署服务、未访问真实 Lark 或非测试数据库。
- 检查：新增专项 6/6 通过；最终 `npm.cmd test` 全量 760/760 通过，0 失败、0 跳过（包含既有测试库集成测试）；`git diff --check` 通过。首轮全量 759/760，唯一失败为 warehouse-setup 的旧 capabilities 精确比较断言，补充新字段后全量通过。项目无 lint / build 命令。LQ-AC8 的实现及自动验证完成，UI 仍待人工预览签字；LQ-AC9 满足。

### LQ-T6（2026-11-06）

- 新增 migration 007：quotation 角色仅获 schema USAGE、`v_active_routes` SELECT、`route_quotation_imports` / `route_quotation_lines` / `route_quotation_prices` SELECT 与 INSERT、`route_quotation_lines(voided_at, void_reason)` 列级 UPDATE，以及 `route_quotation_lines_id_seq` USAGE。同步实际只读取 `v_active_routes`，不授予 `v_route_detail_zips` 或 `quotation_weight_bands` 权限；不改其他角色或 migration 001–006。
- migration runner 新增默认 `nc_quotation` 的 `quotationRole` 和转义标识符占位符；CLI 继续使用默认值。测试 helper 新增专用 `nc_test_quotation` 客户端、数据库和身份校验及跳过条件，迁移传入测试角色。
- 现有首次导入、unchanged、替换历史、删除作废及价格回退用例改用 quotation 客户端执行，reader 验证报价视图。新增权限用例验证禁止操作返回 42501、其他四角色不能写报价、实际序列名及仅 USAGE。refresh-migration / district-db / warehouse-db 的版本列表加入 007，runner BEGIN / COMMIT 次数从 6 调整为 7。
- 未查看或修改凭据、未访问真实 Lark、未执行正式 migration、未创建角色、未改 Worker / 前端 / 依赖，未提交、推送、部署或重启服务。
- 验证：`npm.cmd test` 全量 761/761 通过，0 失败、0 跳过，包含专用 quotation 角色的真实测试库用例及 CLI / 调度连接选择回归；`git diff --check` 通过。项目无 lint / build 命令；本任务无 UI 改动，未运行浏览器预览。

### LQ-T5（2026-11-06，Product Owner 授权后由 Claude 执行）

- 正式库（`nc_ops`）执行前核对：已应用 001–004；`nc_quotation` 登录角色已存在，非超级用户、无 CREATEROLE / CREATEDB / BYPASSRLS、无角色成员关系。`npm run db:migrate` 应用 005 / 006 / 007，无错误。
- 迁移后核对：报价 4 张基表、4 个视图、`route_quotation_lines_id_seq` 存在；`second_parcel_half_price_raw text` 可空；唯一约束 `quotation_import_route_zip_day_key (import_id, route_id, postal_code, effective_from)` 及部分唯一索引 `one_quote_per_key_day` 存在。`nc_quotation` 仅有 `v_active_routes` SELECT、三张报价表 SELECT / INSERT、`route_quotation_lines(voided_at, void_reason)` UPDATE、序列 USAGE；无 DELETE / TRUNCATE、无 `quotation_weight_bands` 写权限。scraper / reader / warehouse / district 对报价表无任何写权限；reader 仅有 4 个报价视图 SELECT。`NC_DB_QUOTATION_URL` 实际登录身份为 `nc_quotation`。
- 本机 `.env` 增加 `LARK_QUOTATION_SPREADSHEET_TOKEN`、`LARK_QUOTATION_SHEET_ID=uAaPvG`、`LARK_QUOTATION_SYNC_MINUTES=60`；未设置 `LARK_OPEN_API_BASE`，使用默认 `https://open.larkenterprise.com`（连通）。`.env` 中代码不读取的旧变量 `LARK_BASE_URL` 已按 Product Owner 2026-11-06 决定删除，其他 Lark 配置未改。
- `quotes:lark-check`：连接成功，表头有效，269 数据行。dry-run 与 LQ-T0 验证一致：新增 261、拒绝 8（`SFO02-002` `route_not_found`，表格第 25–32 行）、作废 0、警告 8（`half_price_flag_unexpected`，SFO02-027 / SFO02-053 第 221–228 行）。
- 首次正式同步：`partial`，导入记录 1 条（`source='lark_sheet'`，`imported_by='lark-sync'`），261 行 × 14 价格 = 3654 条价格，覆盖 SFO01 / SFO02 52 条线路；当前 0–1 lb 首票 $1.55–$2.20，无 0 或空价格，无未来报价。随后 dry-run 及 Worker 首次定时同步（22:22Z）均为 `unchanged`（261 不变），验证幂等。
- UI 核对：3000 线路档案 SFO02 16 / 16 条单价；SFO01 31 条单价、5 条区间（如 SFO01-036 `$1.70–$1.85`）、`SFO01-002`（表中无报价）显示 `—`；价格详情显示 14 档价格、生效 / 结束日期和备注；地图 hover SFO01-004 / 94502 显示 `$1.85`，SFO01-002 / 94619 显示 `—`。3000 只读服务未重启（RQ-T2 API 早已加载，前端静态文件实时读取）。
- Worker：确认无运行中的刷新后停止 3100 Node 进程，由 `run-service.ps1 -Name worker` 守护在 5 秒后自动重启；capabilities 含 `quotation_sync: true`，`/api/quotation-sync/status` 为 `enabled: true, interval_minutes: 60`。3100 数据状态显示「报价同步 · 定时：每 60 分钟 · 最近成功：2026-11-06 14:22 PST · 最近一次：无变化 · 拒绝行数：8」。
- Product Owner 2026-11-06 确认功能及 UI。`SFO02-002` 8 行和 V 列 8 行备注文字由表格维护方修正后交给定时同步自然处理，不手工修改数据库（LQ-D6、LQ-Q10）。LQ-Q6 / Q7 保持 open，不阻塞当前功能。
