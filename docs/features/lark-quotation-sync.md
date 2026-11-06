# Lark 报价表同步 / Lark Quotation Sync（LQ）

- **状态：** Draft（2026-11-06）。只有方案，未实现、未授权实现。不修改 Lark 应用权限，不部署，不重启服务，不在正式库执行 migration。
- **上游：** `docs/features/route-quotation.md`（RQ）。本功能是 RQ 第 12 节 **RQ-T4（导入入口）** 的具体化：把数据来源从「手动 xlsx 文件」换成「Lark 表格」。RQ 的数据库（migration 005）、当前价格规则（RQ 第 4.2 节）、API（RQ-T2）、地图 hover / 线路档案 / 价格详情（RQ-T3）全部复用，不另建价格缓存或第二套展示。
- **相关文档：** `docs/data-schema.md` 第 12 节、`docs/deployment.md`（环境变量、角色）、`docs/open-questions.md`「Lark 报价同步」、配置交接 `docs/workflow/lark-quotation-handoff.md`。
- **不做：** 聊天机器人、消息事件订阅、长连接 / 回调、AI 模型、自动回复、续票显示到主界面、电子围栏附加费、写回 Lark。

---

## 1. 目标

后端定时读取 Lark 价格表，按 Route + ZIP 写入现有报价表，地图 hover、线路档案和价格详情自动显示当前首票价格。读取失败时保留上次成功数据；未找到报价显示 `—`，**永远不显示为 0**。

## 2. 架构结论

```text
Lark Sheets API（应用身份 tenant_access_token，只读）
   → Lark client（取 token、读表，凭据只在后端环境变量）
   → 解析 / 校验（表头映射、日期、数值、空值；RQ 第 8 节）
   → 匹配 DMS 当前 Route（v_active_routes，精确 route_name → route_id）
   → 写入 route_quotation_imports / lines / prices（行级部分导入）
   → 现有视图 v_route_quotation_* → 现有 API → 现有 UI
```

- **只需要定时调用 Sheets 读取接口。** 不需要机器人能力、消息事件（`im.message.receive_v1`）、事件回调地址或长连接：需求是后端主动拉取，不接收 Lark 推送。当前后台「长连接 Connection failed」是因为没有程序在线，与本功能无关。
- 运行位置：**Worker（3100，公用电脑本机）**。Worker 已由 `scripts/services/` 在登录时常驻启动，持有写库凭据；只读 server（3000 / readonly.env）不接触 Lark 凭据和写入角色。
- 不需要新增 npm 依赖：Node 内置 `fetch` 调用 HTTP JSON 接口，不解析 xlsx。

## 3. 现状核对（2026-11-06）

| 部分 | 现状 | 本功能 |
|---|---|---|
| 数据库 | migration 005 已提交（`6c8cf85`），**正式库未执行**；reader 只读视图 | 复用；新增 migration 006 写入角色 |
| 当前价格规则 | RQ 4.2（洛杉矶自然日、有效期、最新生效优先、同日冲突拒绝） | 复用，不改 |
| API | RQ-T2 已提交（`f8bc03b`）：`current_first_0_1lb_price`、详情接口、降级 | 复用；可选增加同步状态字段（LQ-T4） |
| 地图 hover / 线路档案 / 详情 | RQ-T3 完成并预览签字，**待提交确认** | 复用，不改 |
| 导入校验 | RQ 第 8 节已设计（行级部分导入、幂等重导），未实现 | 本功能实现 |
| 写入角色 | 未建（RQ 第 4.3 节延后到 RQ-T4） | LQ-T1 |
| Worker | `server/src/worker/worker.js`，无定时任务机制 | LQ-T4 增加可配置定时同步 |
| Legacy ZIP 价格表 `nc-ops-console-main/data/price_adjustments.csv` | 旧站点使用 | 不动 |

## 4. 匹配规则

地图数据粒度：一个 polygon = DMS 当前 snapshot 中某 Station 下某 Route 的一个 ZIP（`station + route_id + postal_code`）；DSP（`dsp_name`）是 Route 级 DMS 字段。

| 维度 | 规则 |
|---|---|
| 线路 | 表格「线路」原值 → 在 DMS active snapshot 中**精确**匹配 `route_name`，得到唯一 `route_id` 和 Station。找不到 / 多个 → 拒绝该行，不模糊匹配（RQ-D14） |
| 邮编 | 表格「邮编」→ 5 位字符串；与 `route_id` 组成报价键。地图 polygon 按 `route_id + postal_code` 取价（已实现） |
| 站点 | 表格「站点」只保存原值（样例中写法不统一：`OAR` / `SFO02`），Station 一律由线路解析 |
| DSP | 表格「转运中心/DSP」（列名待验证）保存原值。与 DMS `dsp_name` 写法不同（DMS 如 `SFO-AAS`，报价模板如 `SFO02-AAS`），**不参与匹配**；不一致只记警告（RQ-Q4） |
| 有效日期 | RQ 4.2：`生效日期 <= 洛杉矶当日 <= 结束日期`，结束日为空长期有效；同键多条取生效日期最新；同键同生效日期内容不同 → 冲突 |

## 5. 同步语义（需 Product Owner 确认，LQ-Q1）

RQ 原设计面向「增量变更文件」（每份文件只含变更行）。Lark 表格更可能是**持续维护的总表**，会被原地修改、删除行。两种语义：

| | A. 增量（RQ 现设计） | B. 镜像总表（建议用于 Lark） |
|---|---|---|
| 表格中某行内容被修改（同线路 + 邮编 + 生效日期） | 判为冲突，拒绝；需人工作废旧行 | 作废旧行（原因 `lark_replaced`），写入新行 |
| 表格中某行被删除 | 旧报价继续有效直到结束日期 | 作废该行（原因 `lark_removed`），地图恢复为更早的有效报价或 `—` |
| 历史 | 保留 | 保留（作废行不删除） |

建议 **B**，并加保护：

- 只有在本次读取**成功且表头校验通过**时才执行镜像；任何读取 / 表头失败都不改动数据库（保留上次成功数据）。
- 某行校验失败时，不作废该键之前的有效行（保留上次成功值），只在错误清单中报告。
- 若本次有效行数比上次成功同步减少超过阈值（建议 20%，可配置），整次同步中止并报告，防止误删 / 筛选视图导致大面积清空。
- 同一次读取内同键重复（同线路 + 邮编 + 生效日期）→ 重复的各行全部拒绝，不挑选。

采用 B 需要修改 RQ 第 8 节和 RQ-D13 的适用范围（仅 `lark_sheet` 来源），属于需求变更，确认后再写入 RQ spec。

## 6. 数据处理规则

| 情况 | 处理 |
|---|---|
| 读取失败（网络、token、权限、表格 / 工作表不存在、超时） | 不写数据库；记录同步状态（时间、阶段、错误码）；地图继续显示上次成功数据 |
| 表头不匹配 | 整次中止（文件级错误），同上 |
| 表格未变化 | Sheets 读取结果带 `revision`；与上次成功同步的 revision 相同则跳过，不新增导入记录（实现时验证该字段） |
| 线路在 DMS 中找不到 | 拒绝该行，列入错误清单 |
| 邮编不是 5 位 | 拒绝该行 |
| 价格单元格为空 / 非数字 / 负数 / 超过两位小数 | 拒绝该行；**空值永远不转成 0** |
| 价格单元格为 0 | 待确认（LQ-Q4）；确认前接受但记警告 |
| 日期无法解析（如 `11/1/20217`）/ 结束早于生效 | 拒绝该行 |
| 报价已过结束日期 | 照常保存为历史；当前价格规则自动不显示 |
| 地图 ZIP 没有当前报价 | 显示 `—`（已实现） |
| 邮编在报价中、但不在该线路当前 DMS ZIP 中 | 保存并警告（切线可能先于 DMS 更新） |

日期读取：Sheets v2 读取接口支持 `valueRenderOption` / `dateTimeRenderOption` 参数。实现时用一次真实读取确认日期返回形式（序列号或格式化字符串），再固定解析方式，不猜。

## 7. 更新时间与状态

- 每次同步尝试记录：开始 / 结束时间、结果（`completed` / `partial` / `rejected` / `unchanged` / `fetch_failed`）、错误阶段与错误码（不含凭据、不含响应原文）、revision、行数统计。成功 / 部分成功写入 `route_quotation_imports`（`source='lark_sheet'`，`source_ref` 含 spreadsheet token、sheet id、revision）；读取失败只写运行状态（Worker runtime 目录或状态表，LQ-T4 定）。
- 页面：价格详情已有「报价更新于」（当前报价行的导入时间）。另在 3100 数据状态 / 3000 只读状态中显示「报价最近成功同步时间」和「最近一次同步失败原因」（LQ-T4）。

## 8. 凭据与安全

- App ID / App Secret、spreadsheet token、sheet id 只放在**公用电脑 repo 根目录 `.env`**（已 gitignore，Worker 读取）。不放 `readonly.env`、前端、日志、Git、交接文本、命令行参数。
- 建议变量名（占位）：

  ```text
  LARK_OPEN_API_BASE=https://open.larkenterprise.com
  LARK_APP_ID=<在本机 .env 填写>
  LARK_APP_SECRET=<在本机 .env 填写，不要粘贴到聊天>
  LARK_QUOTATION_SPREADSHEET_TOKEN=<表格 token>
  LARK_QUOTATION_SHEET_ID=<工作表 id>
  LARK_QUOTATION_SYNC_MINUTES=0          # 0 = 关闭定时同步，只允许手动
  NC_DB_QUOTATION_URL=<nc_quotation 写入角色连接串>
  ```

- tenant_access_token 只保存在进程内存，按返回的有效期提前刷新；日志只记录错误码和阶段，不记录 token、Secret、请求头。
- 只申请只读表格权限；不申请编辑权限、不写回 Lark。
- 写库使用独立角色 `nc_quotation`：只允许 INSERT 报价表、UPDATE 行的作废列、SELECT `v_active_routes` 和报价基表（用于比对）；不给 scraper / reader / warehouse 任何报价写权限。

## 9. 待确认问题

见 `docs/open-questions.md`「Lark 报价同步」LQ-Q1 至 LQ-Q8。

## 10. 验收标准（实现阶段）

- **LQ-AC1** migration 006 只新增 `nc_quotation` 角色权限，不改表结构；reader 权限不变。
- **LQ-AC2** 导入核心（与来源无关，输入为二维单元格数组）实现第 4–6 节规则和 RQ 第 8 节；测试覆盖每一种拒绝 / 警告 / 跳过 / 冲突 / 镜像作废 / 大幅减少中止。
- **LQ-AC3** Lark client：取 token、查工作表、读范围；错误按阶段分类（凭据 / 权限 / 文档未授权 / 工作表不存在 / 网络）；任何输出不含凭据。用假 HTTP 测试。
- **LQ-AC4** `quotes:lark-check` 只读检查命令：输出连接是否成功、工作表标题和行数、表头是否匹配，不输出价格数据和凭据。
- **LQ-AC5** `quotes:sync-lark` 手动同步命令，支持 `--dry-run`（只校验、不写库），输出统计和错误清单。
- **LQ-AC6** Worker 定时同步默认关闭（`LARK_QUOTATION_SYNC_MINUTES=0`），开启后串行执行、不重叠；失败保留上次数据并记录状态。
- **LQ-AC7** 页面显示最近成功同步时间和最近失败原因；未匹配价格显示 `—`，不显示 0。
- **LQ-AC8** `npm test` 全部通过；不新增依赖。

## 11. 分阶段任务

| 任务 | 内容 | 执行者 | 依赖 / 停止条件 |
|---|---|---|---|
| LQ-T0 | Lark 后台配置、表格授权、本机 `.env` 填写（见交接文档） | Product Owner / 管理员（可由 ChatGPT 协助后台操作） | 修改应用权限需 Product Owner 执行或批准 |
| LQ-T1 | migration 006：`nc_quotation` 角色权限 + 测试 | Codex | 测试库需先由管理员创建 `nc_test_quotation` 角色（权限操作，停止条件） |
| LQ-T2 | 导入核心：表头映射、单元格解析、校验、Route 匹配、部分导入 / 幂等 / 镜像、写库事务 | Codex | LQ-T1；LQ-Q1、LQ-Q2 回答 |
| LQ-T3 | Lark client + `quotes:lark-check` + `quotes:sync-lark --dry-run` | Codex | LQ-T2；真实表头核对需 LQ-T0 完成 |
| LQ-T4 | Worker 定时同步（默认关闭）+ 同步状态记录 + 页面显示同步时间 / 失败原因 | Codex | LQ-T3 |
| LQ-T5 | 正式库执行 005 / 006、创建 `nc_quotation`、首次同步、开启定时 | Product Owner 批准后执行 | 正式 migration、角色、服务重启均为停止条件 |
