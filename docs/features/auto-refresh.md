# DMS 每日自动刷新（Auto Refresh，AR）

状态：**Approved — 已实现（DB-T1、AR-T1–T3，2026-11-11），待上线（AR-T4：正式库 migration 008、配置、重启 Worker，需 Product Owner 确认）和 UI 签字**

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

- **AR-T3（2026-11-11）**：Worker 增加 `capabilities.auto_refresh: true`；在现有 `web/data-status.js` 中加入自动刷新状态行，沿用报价同步的首次加载及 60 秒轮询，显示 Pacific 上次 / 下次时间、中文结果、成功片区数和最多 3 个失败片区及中文原因。只读服务没有该 capability，不请求 Worker 状态接口。DB 数据源新增 `readScheduleRuns({ since })`，只经 `v_runs` 查询近期 schedule run 和 completed 恢复记录；`summarizeAutoRefresh` 纯函数按最近 48 小时、Pacific 最近日期和片区最后一次尝试汇总，后续同片区 / all 范围成功会清除失败。`/api/freshness` 的 DB `run.auto_refresh` 返回汇总或 null；JSON 模式保留 `run: null`。自动失败提示优先于通用失败提示，登录过期用现有登录提示，running 保留正在更新提示；更新记录的“来源：每日自动”通过测试确认。
  - 验证：新增 fake DOM 状态文案 / 提示优先级 / 轮询 / 只读隐藏 / 更新记录测试、汇总纯函数与 HTTP 组装测试，以及使用 `createTestDb` 的读取方法测试。`node --test server/test/`（不加载 `.env`）共 819 项：762 通过、55 跳过、2 失败；失败仍为 CD-AC30 / CD-AC31 强制要求未配置的 `NC_TEST_DB_*`，新增 DB 测试同样因缺配置跳过，待 Claude 本机完整验证。`git diff --check` 通过；项目无 lint / build 命令。使用现有 Playwright 和合成临时数据启动临时随机端口 API，验证 Route Profile / Route Map 自动刷新状态行、更新记录弹窗及 Leaflet 容器，浏览器 pageerror 为 0；未验证真实 DMS 数据。没有新增前端文件、import 路径或依赖，没有访问 DMS、读取 `.env` / 正式 runtime、重启服务、提交或推送。
  - 本地预览：在现有服务运行时打开 `http://127.0.0.1:3100/` 或 `http://127.0.0.1:3100/map` 检查 Worker 状态行，打开 `http://127.0.0.1:3000/` 或 `http://127.0.0.1:3000/map` 检查只读失败提示和更新记录；真实状态取决于已配置的调度器与 DB 记录。此次没有改变配置或重启服务，若现有进程尚未加载改动，需由获授权人员另行安排；UI 仍待 Product Owner 预览签字。

- **AR-T2 第 1 轮修复（2026-11-11）**：定时运行和启动补跑携带计划日期，跨日或达到 23:00 时仅记录 `auto_refresh_missed` 并安排下一次；登录过期保留本轮已有失败结果，仅标记尚未运行的片区；重启收尾仅修改 `pending` 片区，保留已有失败原因；损坏 JSON 或缺少日期 / 片区数组的状态记录 `auto_refresh_status_invalid` 后按无记录继续调度，读取 I/O 错误仍关闭调度。新增 4 项回归测试（含首轮 / 重试轮登录停止、睡眠跨日 / 截止及无效状态形状），原有 12 项断言未改，定向测试 16/16 通过；全量测试仍仅 CD-AC30 / CD-AC31 因缺少 `NC_TEST_DB_*` 失败，`git diff --check` 通过。

- **AR-T2（2026-11-11）**：新增 `server/src/worker/auto-refresh-scheduler.js`，提供 `autoRefreshConfig` 和可注入时钟、定时器、launcher、片区读取器的 `createAutoRefreshScheduler`。按配置片区顺序串行调用共享 launcher，支持两轮失败重试、登录立即停止、繁忙等待及截止放弃、启动补跑、同日防重复和当天中断记录收尾；状态通过 `writeFileAtomic` 写入 runtime 的 `auto-refresh-status.json`。用 `Intl.DateTimeFormat` 搜索目标本地日期 / 时间对应的 UTC 分钟，不写死时区偏移；定时器长延迟分段。导出重试、繁忙检查、计划时间后两小时截止、23:00 补跑截止及两分钟补跑延迟常量。Worker 启动时仅在配置启用且 DB 模式创建调度器，关闭时取消等待，不终止子进程；新增 `GET /api/auto-refresh/status`，关闭时返回 `{ enabled: false }`。`.env.example` 保持默认关闭。新增 12 项测试并注册到 `server/test/index.js`，涵盖调度规则、两个夏令时切换日、启动 / 完成异常、生命周期与 HTTP 状态接口；测试仅使用临时目录和假 launcher。定向测试 12/12 通过；按 brief 执行 `node --test server/test/`（不加载 `.env`）：810 项中 754 通过、54 跳过、2 失败，失败为现有 CD-AC30 / CD-AC31 缺少强制要求的 `NC_TEST_DB_*`，待本机补跑 DB 检查。项目无 lint / build 命令。未修改前端、需求或验收标准，未读取 `.env` 或正式 runtime，未访问 DMS、抓取、执行迁移、重启服务或提交 / 推送。

- **AR-T1（2026-11-11）**：新增 `createRefreshLauncher`，集中管理范围预览、启动预留、锁检查、启动进度、子进程及日志转发；Worker 的刷新接口复用 launcher，并通过 `server.refreshLauncher` 暴露给后续调度器。`status()` 提供 `{ busy, progress }`，HTTP 状态投影仍由 Worker 结合最近 DB run 完成。`start({ scope, trigger })` 接受 `ui` / `schedule`，成功返回 `done`；退出或 `error` 后读取最终进度，缺失、不可读或仍在运行时返回 `stopped` / `process:Exited`；`error` 事件的 `exit_code` 为 `null`。CLI 解析、最近抓取查询和更新记录来源映射已支持 `schedule`。新增 launcher、CLI trigger 和 DB 最近 run 测试，未修改现有 Worker 测试断言。按 brief 使用 `node --test server/test/`（不加载 `.env`）：798 项中 742 通过、54 跳过、2 失败；失败为现有 CD-AC30 / CD-AC31 强制要求 `NC_TEST_DB_*` 配置，DB 集成验证待本机补跑。未访问 DMS、未运行真实抓取、未重启服务或执行迁移。

### AR-T4 — 上线（2026-11-11，Product Owner 批准第 1–3 步）

- 正式库备份：`pg_dump -Fc --schema=nc` → `%LOCALAPPDATA%\nc-ops-console\runtime-data\backups\nc-before-008-2026-11-11T23-49-16-172Z.dump`（753 KB，含 18 张表数据，已用 `pg_restore --list` 核对）。
- `npm run db:migrate`：001–007 skipped，008 applied。reader 读取 `v_route_history_daily`：1,888 行、12 个日期、533 条 Route（2026-10-07 至 2026-11-05）。
- repo `.env` 新增 `AUTO_REFRESH_TIME=17:00`、`AUTO_REFRESH_TZ=America/Los_Angeles`（未显示其他内容）。
- 15:51 停止 Worker / 只读服务的 Node 进程，守护脚本 5 秒后自动重启。`/api/auto-refresh/status`：enabled，`next_run_at` 2026-11-12T01:00Z（= 11-11 17:00 PST）；3000 `/api/route-history` 返回真实历史。
- 上线时发现最近一次 run（2026-11-10）以 `capture:NeedsLoginError` 停止：首次 17:00 运行前需要 `npm run dms:login`，否则会以 `needs_login` 停止。
- 待办：观察首次 17:00 运行并记录结果（AR-AC8）。
