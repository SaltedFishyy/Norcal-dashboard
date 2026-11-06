# Lark 报价表同步 / Lark Quotation Sync（LQ）

- **状态：** Approved（Product Owner 2026-11-06）。已授权实现 LQ-T1 至 LQ-T4（开发、测试、可审核结果）。**未授权**：正式库 migration、数据库角色创建、部署、服务重启、开启定时同步（LQ-T5、LQ-T6 另行授权）。
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

`route_quotation_lines` 增加一列 `second_parcel_half_price_raw text`（可空，保存 V 列 trim 后原值；空单元格为 NULL）。不改其他表、不改现有视图、不改角色权限。理由：Product Owner 要求保存原值（LQ-D5），且 006 尚未在任何正式环境执行。

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
- 在 LQ-T6 之前，正式同步命令（非 dry-run）在缺少 `NC_DB_QUOTATION_URL` 时直接拒绝运行，**不回退到 owner / scraper 连接**。

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

- **LQ-AC1** migration 006 只增加 `route_quotation_lines.second_parcel_half_price_raw`；现有视图、reader 权限不变；迁移测试覆盖。
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
