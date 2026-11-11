# DMS 每日自动刷新（Auto Refresh，AR）

状态：**Approved**（Product Owner 2026-11-11 批准需求与方案；**尚未授权进入实现**）

## 1. 目标

每天固定时间自动运行一次 DMS 抓取，更新 Dashboard 数据，不需要有人手动点击“更新数据”。同时为线路历史（`docs/features/route-history.md`）提供每天稳定的数据点。

## 2. Product Owner 决定（2026-11-11）

| # | 决定 |
|---|---|
| A1 | **授权每天自动访问 DMS**，范围为全部片区（`all`，按 `config/districts` 中未 `scrape_disabled` 的站点，目前 52 个）。**取代 `docs/features/dms-refresh.md` 中“只在用户点击时运行，不定时刷新”的规则**（该文件已加注）。仍然不持续轮询 DMS。 |
| A2 | 时间：**每天 17:00（America/Los_Angeles）**。时间、时区、范围都是 Worker 配置项。 |
| A3 | 失败通知：**只在看板上提示**，不发 Lark 等外部消息。 |
| A4 | 登录规则不变：登录过期立即停止，不自动登录、不重试、不绕过（`dms-refresh.md` 第 5 节 AC4）。 |

## 3. 现状与复用（Claude 2026-11-11 检查）

- Worker（`server/src/worker/worker.js`，127.0.0.1:3100）已有：刷新启动（`POST /api/refresh` → spawn `dms-scrape-stations.js --scope … --trigger ui --new-run --progress-file …`）、`scrape.lock` 存活检查、`refresh-progress.json` 进度、`/api/refresh/status`（含 `needs_login`）、刷新范围 `all` / `district:<id>`（`server/src/batch/refresh-plan.js`）。
- Worker 已有定时任务先例：Lark 报价同步（`LARK_QUOTATION_SYNC_MINUTES`，串行、状态写入 runtime 目录的 JSON，3100 数据状态显示一行）。
- 每个站点成功后单独激活 snapshot；run 中途停止时，已完成站点的数据保留。
- 实测成功率（`scrape_runs`）：UI 刷新完成 10 次 / 停止 15 次。停止原因：`capture:NeedsLoginError` 6、`list:SelectorError` 4、`capture:SelectorError` 3、`switch:StationSwitchError` 2。50–52 个站点的全量尝试都没有一次跑完。13 个站点约 5 分钟，最多约 1,300–1,500 次请求；全量估计 20–30 分钟。

## 4. 方案

### 4.1 位置：Worker 内的调度器（不用 Windows 计划任务）

和手动刷新共用同一条启动路径（锁、进度、状态、needs_login），只有一处状态，不会互相冲突。Worker 由现有 `start-services.ps1` 守护。

### 4.2 运行规则

1. **触发**：每天 17:00（配置 `AUTO_REFRESH_TIME=17:00`、`AUTO_REFRESH_TZ=America/Los_Angeles`；未设置或 `off` 时关闭）。仅 `DATA_SOURCE=db` 时生效。
2. **按片区依次运行**：从 `all` 展开为各片区，依次以 `district:<id>` 启动（每个片区一个 run，`trigger = 'schedule'`）。一个片区失败不影响后面的片区。
3. **重试**：片区以非登录原因停止（`SelectorError`、`StationSwitchError`、进程异常退出等）时，全部片区跑完后，等 15 分钟重试失败的片区；最多重试 2 轮。重试间隔和次数为配置常量。
4. **登录过期**：任何片区遇到 `NeedsLoginError` 时，立即停止当天剩余的所有片区，不重试；看板显示现有的“需要重新登录”提示。
5. **冲突**：到点时有手动刷新正在运行（或锁存活），本轮推迟，每 5 分钟检查一次，最晚推迟到 19:00；仍然繁忙就放弃，并记录 `skipped_busy`。自动刷新进行中时，手动刷新照常返回 409（现有行为）。
6. **补跑**：Worker 在 17:00 之后、当天 23:00 之前启动（例如电脑睡眠或重启），并且今天还没有自动刷新的记录时，启动后 2 分钟补跑一次。23:00 之后不补跑。
7. **防重复**：在 runtime 目录写 `auto-refresh-status.json`（原子写入），记录当天的日期、每个片区的状态和 run_id、重试轮次、最终结果。同一天只跑一轮（含重试）。
8. **日志**：开始、每个片区的结果、重试、跳过、结束，各写一行到 `worker.log`（复用现有 log）。

### 4.3 状态显示（只在看板上提示）

- 3100 Worker 页面：在数据状态区显示“自动刷新：上次 <时间> <结果>（成功 N / 失败 M 个片区）· 下次 <时间>”。失败时显示片区名称和中文原因。
- 3000 看板（只读）：在现有提示条规则中增加一种：**当天的自动刷新失败或部分失败时**，显示一行提示（例如“今天 17:00 自动更新部分失败：南加州片区（页面结构异常），其余片区已更新”）。登录过期继续使用现有提示。只读服务通过 DB 中的 `scrape_runs`（`trigger='schedule'`，经 `v_runs`）判断，不读取 Worker 的 runtime 文件。
- “更新记录”弹窗中，自动刷新的 run 标为“自动”，手动的标为“手动”。

## 5. 数据与迁移

- 新增 migration `008`（和 `route-history.md` 合并为一个文件）：`scrape_runs.trigger` 的 CHECK 增加 `'schedule'`；`v_runs` 已包含 `trigger`，不变。
- 正式库执行 migration 是停止条件：Codex 只在测试库验证；正式库由 Claude 在 Product Owner 确认后执行，执行前用 `pg_dump` 备份。

## 6. 验收标准

- **AR-AC1** 手动刷新和自动刷新共用同一个启动函数；手动刷新的行为、HTTP 响应和现有测试不变。
- **AR-AC2** 到配置时间后按片区依次启动，每个片区一个 `trigger='schedule'` 的 run；时间、时区、关闭开关可配置；非 DB 模式不启动。
- **AR-AC3** 非登录原因失败的片区在全部跑完后重试，最多 2 轮；登录过期立即停止当天剩余片区，不重试。
- **AR-AC4** 有手动刷新时推迟，到 19:00 仍繁忙就放弃并记录；同一天不重复运行；17:00–23:00 之间启动的 Worker 会补跑。
- **AR-AC5** `auto-refresh-status.json` 原子写入；Worker 重启后能正确判断当天是否已运行。
- **AR-AC6** 3100 显示上次 / 下次和结果；3000 在当天自动刷新失败或部分失败时显示提示，成功时不显示；更新记录区分自动 / 手动。
- **AR-AC7** 用假时钟和假 spawn 的单元测试覆盖：按时触发、片区顺序、重试、登录停止、推迟 / 放弃、补跑、防重复、跨午夜。不在测试中访问真实 DMS。
- **AR-AC8** 上线后观察第一次真实 17:00 运行，并记录结果（Claude）。

## 7. 风险

- **DMS 登录过期**：过期后每天都会失败，直到有人运行 `npm run dms:login`。需要观察 session 的有效期。
- **工作时间运行**：17:00 是工作时间。IT 的许可前提是“不影响 DMS 正常运行”。全量刷新约数千次请求、20–30 分钟，按片区串行执行，不并发。抓取会切换 DMS 页头的站点并在结束时恢复；**如果 17:00 有人用同一个 DMS 账号操作页面，页头站点可能被切换**（见 open questions）。
- **公用电脑**：必须开机、不睡眠、用户保持登录（CD-Q5）；抓取使用有界面的浏览器。
- **内存**：2026-11-11 观察到可用内存偏低；刷新会额外启动 Chromium。

## 8. 任务拆分

| 任务 | 内容 | 授权 |
|---|---|---|
| DB-T1 | migration 008（与 RH 合并）：`'schedule'` trigger + 历史视图 / 索引 / 权限；测试库验证 | 实现授权；正式库执行另需确认 |
| AR-T1 | 把 Worker 的启动逻辑抽成 `startRefresh({ scope, trigger })`，POST 与调度器共用；行为不变 | 实现授权 |
| AR-T2 | 调度器（4.2 全部规则）+ `auto-refresh-status.json` + 配置 + 测试 | 实现授权 |
| AR-T3 | 3100 / 3000 状态显示、更新记录“自动 / 手动”标记 | 实现授权；UI 预览签字 |
| AR-T4 | 上线：正式库 migration、`.env` 配置、重启 Worker / 只读服务、观察首次 17:00 运行、更新 `docs/deployment.md` | **每一步需 Product Owner 确认**（migration、服务重启） |

## 9. 实现记录（Implementation Notes）

（待填写）
