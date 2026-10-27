# Central DB / Shared Dashboard MVP

- **状态：** In progress。P0 / P1 / P2 已通过 Product Owner review（P2 于 2026-10-08 通过）；P3 已授权（2026-10-08），设计见第 22 节
- **Product Owner 确认：** 2026-10-07
- **相关文档：** `docs/features/multi-station.md`、`docs/features/district.md`、`docs/features/route-detail.md`、`docs/tech-debt.md`、`docs/open-questions.md`

---

## 1. 目标

目前项目是“本地 Dashboard + 本地 runtime JSON + Playwright 抓 DMS”，只有运行抓取的人能看到最新数据。

MVP 要做到：

- 办公室一台**固定的公用电脑**是唯一的 DMS 抓取节点；只有在这台电脑上能点“刷新”。
- 抓取结果写入**中央数据库**（PostgreSQL，P2 起）。
- 其他组员电脑通过**局域网只读**访问 Dashboard / API。
- 多人同时浏览**不产生任何 DMS 请求**。
- 抓取过程中旧数据照常可读；新数据只有在完整性检查通过后才生效；失败不覆盖上一次成功的数据。

## 2. 范围

**MVP 做：** 本节和第 3–14 节描述的内容，分 P0–P3 实施（第 15 节）。

**MVP 不做（已确认推迟）：** 登录、SSO、用户账号、操作人审计、远程触发刷新、权限管理页面、云部署、“完整重抓 ZIP Detail”的选项、数据过期标黄阈值、历史版本清理任务、指标拆成独立的 SQL 字段、schema v2、route_id 改成按 Station 区分。

**不变的规则：**

- DMS 抓取安全规则全部保留：Station / Route 严格串行、Route 间隔约 2 秒、Station 间隔约 15 秒、请求上限、遇到 429 / 5xx / session 失效 / 校验失败立即停止、不自动重试。
- DMS 当前的 Route 列表仍是 active Route 的唯一来源。
- route_id 暂定全局唯一（TD5）；`schema_version` 继续为 1。

## 3. 架构

```text
公用电脑
├─ PostgreSQL（P2 起）        只监听 localhost:5432
├─ Worker（P3）               只监听 127.0.0.1:<WORKER_PORT>（默认 3100）
│    抓取 + 本机刷新控制 + 同一套前端（显示刷新面板）
│    持有：DMS storageState、DB writer 账号
└─ Read-only Server（P3）     监听局域网 <PORT>（默认 3000）
     只读 API + 同一套前端（不显示刷新面板）
     持有：DB reader 账号；不加载 server/src/dms/*，不持有 DMS session
其他组员电脑 → http://<公用电脑名>:3000
```

- 数据流方向不变：DMS / browser automation → transform → store → API → frontend（`CLAUDE.md` 第 5.1 节）。
- 同一个代码仓库提供两个入口：`npm run server`（只读）和 `npm run worker`（P3 新增）。
- ZIP 边界（`geo/`）、底图（runtime `basemap/`）、`config/districts.json` 仍以文件形式存在，不进数据库。
- **以后搬迁：** 数据库和只读 Server 可以整体搬到服务器（导出导入数据 + 修改连接串），Worker 留在公用电脑。届时数据库要改为允许 Worker 所在 IP 通过 TLS 连接。

## 4. 只有本机能抓取的边界

不靠隐藏按钮，而是以下几层叠加：

| # | 机制 | 防住什么 |
|---|---|---|
| B1 | 数据库只监听 `localhost`，Windows 防火墙不开放 5432（P2 / P3） | 其他电脑无法连接数据库，也就无法写入 |
| B2 | Read-only Server 进程不 import `server/src/dms/*`，没有任何刷新接口；`POST /api/refresh` 在这个进程里不存在（返回 404） | 局域网能访问到的进程里，根本没有触发抓取的代码 |
| B3 | Worker 只监听 `127.0.0.1` | 其他电脑连不上 Worker |
| B4 | Worker 的写操作接口校验 `Host` 和 `Origin` 必须是 `http://127.0.0.1:<WORKER_PORT>`，并要求带自定义 header `X-NC-Refresh: 1`；只接受 JSON 请求体 | 公用电脑浏览器里打开的其他网页借浏览器伪造请求（CSRF），以及 DNS rebinding 攻击 |
| B5 | DMS storageState 继续存放在仓库外的本机路径（沿用现有 `checkStatePath` 规则），不进数据库，不进 repo | 别人复制 repo 也拿不到登录状态 |
| B6 | DB writer 账号只写在公用电脑本地的 `.env`（P2） | 其他电脑没有写入凭据 |

前端通过**当前页面所在服务**的 `GET /api/capabilities` 判断能力：Worker 返回 `{ "refresh": true }`，Read-only Server 返回 `{ "refresh": false }`。**不根据客户端 IP 推测是不是本机。**

说明：组员用自己的 DMS 账号直接访问 DMS，或者在自己电脑上运行 repo 里的脚本，本系统拦不住，只能靠 DMS 账号权限和团队规则。本系统保证的是：这样抓到的数据写不进中央数据库，Dashboard 也不会因此多发任何 DMS 请求。

## 5. 刷新范围与可抓取的 Station

### 5.1 配置

`config/districts.json` 为每个 District **新增一个可选字段** `scrape_disabled`（P3 实施）。`schema_version` 仍为 1，不写这个字段时行为和现在一样。

```json
{
  "id": "denver",
  "stations": ["DEN01", "CYS01", "GJT01", "...", "BZN01"],
  "scrape_disabled": { "GJT01": "not_in_dms_menu", "BZN01": "not_in_dms_menu" }
}
```

- key 必须是该 District `stations` 中已有的 Station。
- value 是跳过原因，取以下枚举之一：

| 枚举 | 前端显示 |
|---|---|
| `not_in_dms_menu` | DMS 中没有此 Station |
| `no_permission` | 无权限 |
| `disabled` | 已停用 |

- **可抓取 Station** = 配置中的 Station 减去 `scrape_disabled` 中的 Station。
- 没有 snapshot 的 Station（例如 PIH01），只要没被禁用，就照常抓取。

### 5.2 刷新范围

点击“刷新”后弹出范围选择：

- **刷新全部**：所有 District 的可抓取 Station。
- **单个 District**：该 District 的可抓取 Station。

District 列表来自 `config/districts.json`，**前端不硬编码**。

选择范围后显示确认信息：本次范围、要处理的 Station（按配置顺序），以及会跳过的 Station 和原因。用户确认后才开始。

处理顺序：按 District 在配置中的顺序，每个 District 内按 `stations` 的顺序。

`unassigned`（有 snapshot 但不在配置中的 Station）**不参与**刷新。

### 5.3 命令行

`npm run dms:scrape-stations` 不传 `--stations` 时的默认列表（`config.js` 的 `defaultStationOrder`，北加州 9 站）在 MVP 中保持不变，以兼容现有用法。Worker 不使用这个默认列表，而是按第 5.2 节算出 Station 列表后通过 `--stations` 显式传入。P3 完成后，TD3 的“两份 Station 列表”问题对刷新按钮来说就解决了。

## 6. 每个 Station 的刷新内容

沿用现有 `dms:scrape-stations` 的逻辑，**不改变业务规则**：

1. 重新抓取该 Station 当前的全部 Route 列表（分页，每页 100 条）。
2. Route Profile 全部更新：整站一个新的 snapshot，新 snapshot 里只有当前 DMS 列表中的 Route。
3. ZIP Detail：`completeRouteDetail` 判定为完整的缓存直接跳过，缺失或不完整的才抓取。不提供 `--refresh`（完整重抓）选项。
4. 每次点击刷新都**新建一个 run**（相当于传 `--new-run`），不续跑上一次的 run。因为完整的 Detail 缓存会自动跳过，所以失败后再点一次的代价很小。

## 7. Station 生效语义

**原则：** 一个 Station 抓完 → 通过完整性检查（`checkStationIntegrity`）→ 该 Station 的新 snapshot 才生效。按 Station 各自生效；已经生效的 Station 不会因为后面的 Station 失败而回滚。

| 数据 | JSON 模式（现在 → P1） | DB 模式（P2 起） |
|---|---|---|
| Route Profile snapshot | **P1 修正：** 完整性检查通过后才原子写入 `route-profiles.json`。修正前是先写入再检查，检查失败时新 snapshot 已经生效 | 新版本先写成 `pending`，检查通过后，在一个短事务里切换当前版本指针 |
| Route Detail | 维持现状：每条 Route 抓取成功后立即原子写入，并且立即可读 | 每条 Detail 立即写成一个新版本（不改写旧版本），但只有被当前生效的 snapshot 引用后才对读者可见 |

JSON 模式下，Route Detail 的立即生效是已知的过渡状态。Product Owner 已确认保留；JSON 退役后自然消失。

## 8. 失败行为与状态

### 8.1 Station 状态

复用现有 run state 的状态名，并新增 `skipped`：

| 状态 | 含义 | 前端显示 |
|---|---|---|
| `pending` | 尚未开始 | 等待中 |
| `in_progress` | 正在抓取 | 更新中 |
| `completed` | 完整性检查通过，新 snapshot 已生效 | 成功 |
| `stopped` | 失败或中断；该 Station 保留上一次成功的数据 | 失败（附 `stop_reason`） |
| `skipped` | 配置为不可抓取，没有被尝试（P3） | 跳过（附原因） |

`limited`（`--max-routes-per-station`）只在命令行测试时出现，Worker 不会产生这个状态。

run 停止后，排在后面、没有处理到的 Station 保持 `pending`，前端显示为“未执行”。

### 8.2 Run 状态

- `running`：进行中。
- `completed`：所有目标 Station 都是 `completed` 或 `skipped`。
- `stopped`：因失败或中断结束。此时可能已有部分 Station 生效，前端分别列出成功、失败、跳过、未执行的 Station。

### 8.3 失败规则

- 任何失败都按现有规则**立即停止整个 run**（不跳过失败的 Station 继续往下抓，因为 429 / 5xx / session 问题往往影响后续所有 Station）。
- 失败的 Station 保留上一次成功的数据；已经生效的 Station 不回滚。
- 失败信息只写入 run 记录（`stop_reason` 格式为 `phase:ErrorType`，沿用 `safeType` 白名单），不写入业务数据。
- **运行中意外不可用的 Station**（例如菜单项消失、切站失败）：仍按现有安全规则停止，该 Station 记为 `stopped`。原因是程序无法可靠地区分“没有权限”和“DMS 页面变化 / session 异常”。确认是权限问题后，在 `scrape_disabled` 中配置，以后就会被跳过。（见 open questions CD-Q1）

## 9. 同一时间只有一个 run

| 层 | 机制 | 阶段 |
|---|---|---|
| L1 | Worker 进程内的互斥锁：有 run 在跑时，`POST /api/refresh` 返回 409 | P3 |
| L2 | runtime 目录下的锁文件 `scrape.lock`（以独占方式创建，内容为 pid、run_id、started_at；pid 已不存在时视为失效锁，可以清除）。`dms:scrape-stations` 命令行也获取同一个锁，防止命令行和按钮同时跑 | P3 |
| L3 | 数据库层：`scrape_runs` 上建“status = running 时唯一”的部分唯一索引 | P2 |

前端按钮的 disabled 只是方便用户，不承担防护。

## 10. UI

### 10.1 所有电脑（Read-only Server 和 Worker 都显示，P3）

页面顶部数据状态条，固定显示“数据来自 DMS 抓取，**非实时**”，以及：

- 最后成功更新时间（各 Station 生效 snapshot 的 `fetched_at` 中最新的一个），可以展开按 District / Station 查看各自的时间。
- 有 run 在进行时：“正在更新（公用电脑），当前显示的是上次成功的数据”。
- 最近一次 run 是 `stopped` 时：“最近一次更新失败（时间），显示的是之前成功的数据”。
- 最近 N 次 run 的历史记录（只读）。

### 10.2 只在公用电脑显示（`capabilities.refresh === true`）

- “刷新”按钮 → 范围选择 → 确认信息（第 5.2 节）→ 开始。
- run 进行中时按钮 disabled。
- 进度面板显示：run 状态、当前 District / Station、Station X / N、当前 Route X / N（第一页列表加载后才知道总数 N）、开始时间，以及已完成、跳过、失败的 Station。结束时显示成功或失败结束、结束时间和失败原因。
- 发现需要重新登录 DMS 时（`NeedsLoginError`）：提示到公用电脑上运行 `npm run dms:login`。

## 11. API 草案（P3）

| 接口 | Worker | Read-only Server |
|---|---|---|
| 现有只读接口（`/api/route-profiles`、`/api/route-map*`、`/api/districts`、`/api/route-details`、静态文件） | ✓ | ✓ |
| `GET /api/capabilities` | `{refresh:true}` | `{refresh:false}` |
| `GET /api/freshness`：各 Station 生效数据的时间，以及最近 run 的摘要 | ✓ | ✓ |
| `GET /api/runs?limit=N`：run 历史（已脱敏） | ✓ | ✓ |
| `GET /api/refresh/scope`：District 列表、可抓取 / 跳过的 Station 及原因 | ✓ | ✗（404） |
| `POST /api/refresh`，请求体 `{scope:"all"}` 或 `{scope:"district", district:"<id>"}` | ✓（受 B4 保护） | ✗（404） |
| `GET /api/refresh/status`：当前 run 的进度 | ✓ | ✗（用 `/api/freshness` 代替） |

Worker 以**子进程**方式启动现有 CLI（`dms-scrape-stations.js --stations … --new-run`）。这样直接复用现有安全逻辑，Playwright 崩溃也不会拖垮 Worker 的 HTTP 服务。进度通过 runtime 目录下的状态文件或 stdout 传回 Worker，具体在 P3 设计。

## 12. JSON → DB 迁移

1. **P2：** 新建数据库 schema；用导入工具把现有 `route-profiles.json` 和 `route-details.json` 导入为来源标记为 `import` 的版本，保留原来的 `fetched_at`。导入**只读** JSON，不修改 JSON 文件。
2. **P2：** 只读 API 新增环境变量 `DATA_SOURCE=json|db`（默认 `json`）。
3. **P2：** 对照测试：在同一份数据上，`json` 和 `db` 两种来源下每个只读接口的输出必须完全一致。
4. **P2–P3：** 抓取时双写：先按 JSON 模式写入（现有行为），再写入数据库；两边各自独立判断成功或失败，并分别记录。
5. **P3 稳定后：** 只读 Server 切到 `DATA_SOURCE=db`。
6. **P4（以后）：** 观察约 2 周，或至少 10 次成功刷新后，再决定是否停止写 JSON。旧 JSON **不删除**。

## 13. PostgreSQL schema 草案（P2 时细化）

关系类字段单独建列，指标先放 `jsonb`（还原现有对象结构，保证对照测试能逐字节一致；以后需要 SQL 报表时再拆成独立字段）。

```sql
districts(id text PK, name_zh, name_en, sort_order)               -- 从 districts.json 同步
stations(code text PK, district_id FK NULL, sort_order,
         scrape_disabled_reason text NULL,
         active_snapshot_id FK NULL)                               -- 当前版本指针

scrape_runs(run_id uuid PK, trigger text,                          -- 'ui' | 'cli' | 'import'
            scraper_id text, app_version text,                     -- 配置的标签和 git commit，不存主机名、用户名、IP
            status text, scope jsonb, requested_stations text[],
            started_at, finished_at, prod_api_requests int, request_cap int,
            stop_reason text, original_station_restored bool)
  UNIQUE INDEX ON scrape_runs((true)) WHERE status = 'running'
scrape_run_stations(run_id FK, station_code, PK(run_id, station_code),
            status, skip_reason, route_total, success_count, cached_count, failed_count,
            request_count, started_at, ended_at, stop_reason,
            integrity jsonb, snapshot_id FK NULL)

station_snapshots(id bigserial PK, station_code FK, run_id FK,
            status text,                                           -- pending | active | superseded | rejected
            fetched_at, source_total int, created_at, activated_at)
snapshot_routes(snapshot_id FK, route_id bigint, PK(snapshot_id, route_id),
            route_name text, profile jsonb,                        -- 现有 row 对象（含 raw、parse_errors）
            detail_version_id FK NULL, UNIQUE(snapshot_id, route_name))
snapshot_route_zips(snapshot_id, route_id, postal_code char(5), PK(snapshot_id, postal_code))

route_detail_versions(id bigserial PK, route_id bigint, station_code, run_id FK,
            fetched_at, detail jsonb)                              -- 现有 route detail 对象
```

**角色：**

- `nc_scraper`：只在公用电脑使用；对 runs、snapshots、detail 相关表有 INSERT 权限，对状态列和指针列有 UPDATE 权限；没有 DELETE，没有建表改表权限。
- `nc_reader`：只能 SELECT 只读视图（`v_active_*`、`v_station_freshness`、`v_runs`）；视图不暴露 raw。
- 建表和迁移由管理员手动执行，MVP 不单独设维护角色。

**一个 Station 的写入流程：**

1. 新建 `pending` 状态的 snapshot。
2. 每条 Route 的 Detail 抓到后，立即写入一个新的 `route_detail_versions`。
3. 列表读完后写入 `snapshot_routes`（同时链接对应的 Detail 版本：本次新抓的，或沿用的完整缓存）。
4. 完整性检查。
5. 检查通过后，执行一个短事务：旧版本改为 `superseded`，新版本改为 `active`，`stations.active_snapshot_id` 指向新版本。
6. 失败时，新版本改为 `rejected`，旧的生效版本不受影响。

## 14. 回退策略

| 阶段 | 回退方式 |
|---|---|
| P1 | 只是调整了写入顺序（完整性检查之后才写 snapshot），JSON 格式和 schema 没变；回退即 git revert 这次代码改动，不需要处理数据 |
| P2 | `DATA_SOURCE=json` 立即回到读 JSON；JSON 一直在写，没有缺口；数据库可以清空后重新导入 |
| P3 | 停止 Worker，照旧使用命令行抓取；Read-only Server 可以退回只监听 `127.0.0.1` |
| 数据错误 | DB 模式下，把指针改回上一个 `superseded` 版本（管理员手动执行 SQL） |

## 15. 阶段

| 阶段 | 内容 | 验收 | 是否访问 DMS |
|---|---|---|---|
| **P0** | 本 spec；整理 open questions；确认 P1 的改动范围 | Product Owner review | 否 |
| **P1** | 把批处理的写入时机抽成一个最小接口（JSON 实现）；改为完整性检查通过后才写 snapshot | CD-AC1–CD-AC10 | 否 |
| **P2** | 安装 PostgreSQL、新增 `pg` 依赖（**需要 Product Owner 另行批准**）；建表、角色、视图；导入工具；DB 实现的写入接口；`DATA_SOURCE` 开关；双写；对照测试 | 第 16.2 节 | 小规模真实验证：1–2 个小 Station，带 `--max-routes-per-station 1` |
| **P3** | Worker、刷新 UI、run 锁、数据状态条、run 历史、`scrape_disabled` 配置、Read-only Server 监听局域网、防火墙、用 Task Scheduler 开机自动启动（PostgreSQL、Worker、Read-only Server） | 第 16.3 节 | 一次正常的真实刷新 |
| P4 | 停止写 JSON（满足第 12 节条件后再决定） | — | — |

## 16. 验收标准

### 16.1 P1

- **CD-AC1** Station 完整性检查失败时，`route-profiles.json` 的**字节内容**完全不变（使用真实的文件 store 和临时目录测试）；该 Station 为 `stopped`，`stop_reason` 匹配 `integrity:IntegrityError`，退出码为 1；后续 Station 不再处理。
- **CD-AC2** 完整性检查通过时，该 Station 的 snapshot 被新内容替换，其他 Station 的 snapshot 保持不变（真实 store 测试）。
- **CD-AC3** Route Detail 仍然在每条 Route 抓取成功后立即写入。现有事件顺序测试（`capture → save → delay …`）不做修改且通过。
- **CD-AC4** 请求顺序、Route 2 秒 / Station 15 秒的间隔、Station 切换、请求上限，以及遇到 429 / 5xx / 401 / 校验失败 / SIGINT 时停止的行为都不变。相关现有测试**不修改断言**且全部通过。事件序列中 `snapshot:<station>` 的位置不变（在该 Station 最后一个 `save` 之后、`delay:15000` 之前）。
- **CD-AC5** 写入前的保护保持不变：写 Detail 和写 snapshot 的原子 rename 之前，仍会确认当前 Station 正确，并检查是否收到中断信号。
- **CD-AC6** 新增**一个**小模块，提供批处理需要的写入动作：开始 run、写 Route Detail、完整性检查通过后让 Station snapshot 生效、结束 run（以及现有的 run state / Station summary 写入）。`runStationsBatch` 现有的依赖注入参数（`saveDetail`、`saveSnapshot`、`writeBatch`、`readState` 等）继续可用，测试 fixture 不需要整体改写。
- **CD-AC7** 不修改以下内容：`server/src/dms/*`、`server/src/transform/*`、`server/src/batch/station-integrity.js` 的判定逻辑、`config.js` 的默认值、JSON 文件格式、`schema_version`、cache 跳过逻辑、`dms-scrape-route-details.js` / `dms-scrape.js` / `dms-scrape-route-detail.js`、API 和前端。
- **CD-AC8** 写 snapshot 时 store 失败：该 Station 为 `stopped`，`stop_reason` 匹配 `store:StoreError`，旧文件保持不变。
- **CD-AC9** 现有测试中**唯一允许修改**的断言：`MS failed final integrity stops before next station` 中的 `h.saves` 从 `['SFO01']` 改为 `[]`，因为这正是本次要修正的行为。其他现有断言一律不改。
- **CD-AC10** `npm test` 全部通过；`git diff --check` 没有输出。`docs/features/multi-station.md` 中描述写入顺序的段落（第 5 节第 3 条、第 5.4 节）同步更新为“完整性检查通过后才写入”；本 spec 的实现记录也要补上。

### 16.2 P2（草案，开始 P2 前细化）

- 导入后，`DATA_SOURCE=json` 和 `DATA_SOURCE=db` 下所有只读接口的输出完全一致。
- 用测试替身模拟一个 Station 中途失败：读者看到的仍是旧版本，新版本为 `rejected`。
- 同时启动两个 run，第二个被数据库唯一索引拒绝。
- `nc_reader` 账号执行 INSERT / UPDATE / DELETE 全部失败，读基础表也失败。
- 双写情况下，JSON 的行为与 P1 完全一致。

### 16.3 P3（草案）

- 另一台电脑：能看 Dashboard；`capabilities.refresh` 为 false，看不到刷新面板；`POST /api/refresh` 返回 404；连不上 Worker 端口和 5432 端口。
- 公用电脑：刷新范围来自配置；确认信息中正确列出要处理和要跳过的 Station；连点只启动一个 run；命令行和按钮不能同时跑；run 进行中时进度面板显示正确。
- 用错误的 `Origin` / `Host`，或缺少 `X-NC-Refresh` header 发 POST，返回 403。
- `scrape_disabled` 中的 Station 显示为跳过，不会切换过去。
- 模拟失败：失败的 Station 保留旧数据，已经生效的 Station 不回滚，失败原因显示正确。
- 数据状态条和 Last Updated 在所有电脑上都显示。
- 用 Task Scheduler 开机自动启动 PostgreSQL、Worker、Read-only Server；重启电脑后不需要人工操作就能访问。
- 一次正常的真实刷新成功完成。

## 17. 风险与安全

- 公用电脑是单点：关机、睡眠或 Windows 更新重启时，Dashboard 不可用。Product Owner 已确认这台电脑可以一直开机、不睡眠。
- 能物理接触公用电脑的人，都能接触到数据库文件、`.env` 和 DMS storageState。不做账号体系是已接受的前提，风险等级与现状相同。
- 公用电脑上的 repo、runtime 目录和数据库数据目录**都不要放在 OneDrive 等同步目录下**（`checkRuntimeDir` 已经会发警告）。
- 局域网内的任何人都可以不登录直接查看数据（CD-Q3）。
- 硬盘损坏：业务数据可以重新抓回来，但会丢失历史版本和 run 记录（P3 设每日导出备份，CD-Q4）。

## 18. 对现有功能的影响

- P1 只改变批处理中“写 snapshot 和完整性检查”的先后顺序。正常成功的情况下，产出的文件和以前完全一样。
- 单站命令（`dms:scrape`、`dms:scrape-route-detail`、`dms:scrape-route-details`）、地图、Route Profile 页面、Tableau 导出都不受影响。

## 19. Open questions

见 `docs/open-questions.md` 中的“Central DB / Shared Dashboard”一节。

## 20. Codex 任务与实现记录

| 任务 | 内容 | 状态 |
|---|---|---|
| CD-T1（P1） | 抽出批处理写入接口（JSON 实现），改为完整性检查通过后再写 snapshot | Product Owner review 通过（2026-10-07） |
| CD-T2（P2） | 建表脚本、db:migrate、DB 连接配置与真实数据库角色 / 权限测试 | Claude review 通过；待 Product Owner review |
| CD-T3（P2） | DB sink、JSON / DB 双写、Station 生效事务、Detail 链接、run 唯一性与 db:abandon-run | Claude review 通过；待 Product Owner review |
| CD-T4（P2） | JSON 导入、DB 数据源、DATA_SOURCE 开关、API 去 raw 与 fixture 对照测试 | Claude review 通过（第 1 轮修复：db:parity 的默认路径）；待 Product Owner review |
| CD-T5（P3） | scrape_disabled、刷新范围、批处理新参数、锁文件、进度文件、migration 002 | 实现待 review；DB 验证被本机 PostgreSQL 不可连接阻塞 |
| CD-T6（P3） | Worker、安全校验与状态恢复；Read-only Server 局域网保护；capabilities / freshness / runs | 实现待 review；467/467 测试通过，DB 测试 0 skipped |
| CD-T7（P3） | 两页共用数据状态条、更新记录、刷新确认与进度、登录过期提示 | 实现待 review；474/474 测试通过，0 skipped；待 Product Owner 预览确认 |
| CD-T8（P3） | 登录启动、服务守护、安全停止、Task Scheduler 注册脚本与部署文档 | 实现待 review；四脚本语法通过，474/474 测试通过，0 skipped；未执行部署 |

### P2 本机验证记录（Claude，2026-10-07）

- **正式库：** `db:migrate` 执行结果为 applied，再执行一次为 skipped。用 reader 账号查基础表被拒绝（42501）。
- **导入：** `db:import-json` 导入了 19 个 Station、154 条 Route、155 个 detail 版本；第二次执行时拒绝（“已导入过”）。导入前后 `route-profiles.json` 和 `route-details.json` 的 sha256 完全一致。
- **真实数据对照（`db:parity`）：** 共 873 个请求，结果 873/873 一致。其中 districts 1、stations 1、profiles 19、maps 19、district_maps 2、details 155（包括历史 route 831）、zips 668、errors 8。导入后和两次真实 DMS 运行后各对照一次，都完全一致。
- **真实 DMS（`DB_DUAL_WRITE=1`）：**
  - DMS session 已过期，所以前两次运行都以 `capture:NeedsLoginError` 停止，每次 6 个请求。DB 中这两次 run 都记为 stopped，指针没有变化，也没有遗留 running 状态的 run（相当于在真实环境中验证了失败路径）。Product Owner 重新执行 `dms:login` 后再继续。
  - **MFR01**（`--new-run`）：结果为 completed，2 条 Route 都使用缓存，Station 21 个请求，整批 58 个请求（上限 124），原 Station 已恢复。DB 中 snapshot 2（json_import）改为 superseded，新的 snapshot 20（origin 为 dms）生效，两条 Route 仍链接原来导入的 detail 版本 121 / 127，没有新增 detail 版本。JSON 和 DB 的 `fetched_at` 一致。
  - **RDG02**（`--refresh --max-routes-per-station 1 --new-run`）：结果为 limited，新抓 1 条 Detail，Station 38 个请求，整批 75 个请求（上限 124），原 Station 已恢复。新的 detail 版本 156（origin 为 dms）从 pending 改为 committed，并被 RDG02-003 链接；RDG02-002 链接原来导入的 154。snapshot 3 改为 superseded，snapshot 21 生效。
  - 整个过程中没有 429、5xx 或 session 失效（登录过期那两次除外）。
- `DATA_SOURCE=db` 实际启动 server 后，读到的是新数据，`/api/route-profiles` 中没有 `raw`，District 地图返回 200。

### CD-T1 实现记录（Implementation Notes）— 2026-10-07

- 新增 `server/src/batch/batch-sink.js`：最小 JSON 写入接口，包含 startRun、writeState、writeStationSummary、writeRouteDetail、activateStationSnapshot 和 finishRun；复用现有注入的 store。beforeCommit 在原子 rename 前执行，保护失败不会 rename。
- 修改 `server/bin/dms-scrape-stations.js`：写入经由 sink；Station 尾部按 transform → integrity → store → finishStation 执行。检查失败不写 snapshot，也不更新内存 snapshots。Detail 逐条立即写入，limited 模式仍在检查通过后写 snapshot。
- 修改 `server/test/multi-station-batch.test.js`：仅将指定完整性失败测试的 h.saves 断言改为 []；其他既有断言不变。
- 新增 `server/test/batch-sink.test.js` 并注册到 `server/test/index.js`：8 项测试覆盖真实 store 的完整性失败字节保留、成功替换与其他 Station 保留、rename 失败时旧文件保留；sink 动作委托和两种业务写入的 beforeCommit 顺序及失败阻止 rename。
- 同步 `docs/features/multi-station.md` 的流程及第 5.4 节，使单页流程与新顺序一致。
- 验证：`npm.cmd test`（与 npm test 同一脚本）417/417 通过；`git diff --check` 无差异错误。package.json 无 lint / build 脚本。仅测试 doubles 和临时合成数据，未访问真实 DMS、未安装依赖、未提交或部署。

---

### CD-T2 实现记录（Implementation Notes）— 2026-10-07

- 新增 `server/db/migrations/001_central_db.sql`：8 张业务表、两个部分唯一索引、5 个只读视图，以及 scraper / reader 的最小权限；Detail 按 committed_at、id 降序选择，视图过滤 raw、capacity_raw、import_digest，run options 只保留 refresh / max_routes_per_station / new_run。
- `server/src/db/connection.js` 从环境变量读取连接配置，以固定中文错误隐藏连接内容；通过转义标识符设置 search_path。`migrate.js` 用 pg.escapeIdentifier 替换 schema / 角色占位符，在单个事务中执行 schema、schema_migrations 和 migration，事务级 advisory lock 防止并发迁移；已执行版本跳过。
- 新增 `npm run db:migrate`，固定 nc / nc_scraper / nc_reader，只输出版本和结果。本次未对正式库执行该命令。
- 测试辅助工具仅允许 nc_ops_test，使用随机临时 schema 和 nc_test_* 角色，结束时清理；DB 测试覆盖真实权限、所有列 UPDATE 范围、CHECK、唯一索引、重复迁移、事务回滚与视图过滤 / 版本排序。无测试配置时明确 skipped，不使用 DB mock。
- `.env.example` 仅新增空值变量与说明；npm test 加载本地 .env；未修改现有 JSON store、批处理、API、前端及既有测试断言。
- 验证：`npm.cmd test` 420/420 通过（原有 417 项 + 新增 3 项），0 skipped；DB 专项测试 3/3 通过，实际使用 PostgreSQL 测试库；不加载 .env 时 2 项 DB 测试明确以“未配置 NC_TEST_DB_*”跳过。`git diff --check` 无空白错误（默认 Git 配置有 LF/CRLF 提示；按 cr-at-eol 检查无输出）。对 Git 跟踪与未忽略文件的凭据扫描未发现本地 DB 连接串或密码，扫描仅输出结果。项目无 lint / build 命令；未进行浏览器手工预览、真实 DMS 验证或正式库写入。

### CD-T3 实现记录（Implementation Notes）— 2026-10-07

- 新增 `server/src/db/batch-db-sink.js`，通过注入连接函数支持正式 scraper 与临时测试 schema；run 使用 UUID，app_version 读取 git 短哈希，失败为 null。startRun 失败不会在 finishRun 中更新不存在的 run；已有 running run 的错误包含 id / started_at 与 abandon 命令提示。
- Detail 与 ZIP 在单独事务内写入 pending 版本；Station 先复用 `completeRouteDetail` 选择最新合格版本，再一次性写入不可修改的 routes / ZIP。生效事务锁住 run、Station 与 snapshot，切换指针、提交 Detail 并写入 run Station 的 snapshot_id；失败回滚后单独标记 rejected，记录固定错误类型。
- 新增 `server/src/batch/dual-batch-sink.js`，每个动作先 JSON 后 DB，保留 JSON 返回值。DB 错误用固定中文 `DbStoreError` 包装；诊断只接收固定消息，不遍历驱动 cause。`runStationsBatch` 通过 `DB_DUAL_WRITE=1` 接入，默认仍只写 JSON；processed / fresh 集合透传，phase 保留。finishRun 的 DB 失败会以 stopped / DbStoreError 更新 JSON 汇总并返回 1；已生效 Station 不回滚。
- 新增 `db:abandon-run`：UUID 与明确确认参数校验后，仅把 running 更新为 abandoned，日志隐藏驱动错误。db:migrate 只额外输出符合五位白名单的 SQLSTATE；未执行正式库 migration 或 abandon 命令。
- 测试使用合成数据和 `createTestDb` 随机 schema，以真实测试 scraper / reader 权限验证唯一性、pending / rejected 可见性、Detail 缓存 / fresh / limited 链接、hook 与 SQL 错误回滚、双写各动作失败、旧指针保留及后续 Station 失败不回滚先前 Station。既有测试断言未修改。
- 技术选择：ordinal 使用输入数组的零基顺序；rejected_reason 对未知或 SQL 错误归一为 Error，完整性错误为 DbIntegrityError；不记录驱动文本。DB 数据源读取属 CD-T4，本任务仅验证视图。
- 验证：`npm.cmd test` 434/434 通过，0 skipped（既有 420 项 + 新增 14 项）；`git -c core.safecrlf=false diff --check` 无输出，新增文件语法检查通过。项目无 lint / build 命令。未访问真实 DMS、未安装依赖、未写正式库、未修改 .env，未提交 / 推送 / 部署。

### CD-T4 实现记录（Implementation Notes）— 2026-10-07

- 第 1 轮修复：db:parity CLI 复用 API 的 defaultGeoDir 和现有 defaultDistrictsPath，允许路径及测试依赖注入；失败提示仅附错误类型和符合白名单的错误码，新增不连接正式库、不读取真实 runtime 的默认路径、退出码与安全日志回归测试，对照逻辑不变。

- 新增 `json-import.js` / `db-import-json.js`：两个源文件各读取一次，以相同字节做校验、sha256 和导入；复用 Profile reader、Detail batch reader 和地图行校验。仅导入路径允许旧行缺少 postal_codes；地图校验默认行为不变。SERIALIZABLE 事务与 schema 范围 advisory lock 串行化导入，不扩大 scraper 权限；失败整体回滚。保存完整 profile、Detail / ZIP 原值，历史 Route 也导入，按 route_id / station 链接，ordinal 为零基输入顺序。
- 新增 JSON / DB 数据源，API 默认仍为 JSON；DB reader 使用 pg.Pool，新连接用转义标识符设置 search_path，只查视图，每次读取用 REPEATABLE READ READ ONLY 事务保持多条查询一致，结束归还连接。连接 / 查询错误统一为固定 DataSourceUnavailableError；API 映射 503。Route Detail 字段投影由两种来源共用，Profile API 在统一出口删除 raw。
- `server` 命令保持原样并监听 127.0.0.1；DATA_SOURCE 非法或 reader 配置无效时固定中文报错，退出 1；增加来源日志。新增 db:parity，在同一进程的两个 loopback 随机端口比较完整 HTTP status / JSON，只输出各类数量及不一致路径，任何差异返回 1，清理服务器与连接池。
- 新增测试模块及合成 fixture：反向 Station 顺序、102 条 Route 的多页列表、多个 ZIP、历史 Route、unassigned District、四类 ZIP 状态、404 / 400、事务回滚 / 源文件字节不变、旧行缺 ZIP、pending / rejected 隔离、503、安全启动失败和故意不一致检测。测试使用 createTestDb 的 nc_ops_test 随机 schema，无真实 runtime 数据。
- 唯一调整的既有断言：`server/test/t6.test.js:49`，T6 health / snapshot preservation 测试的 Profile API 预期 rows 去掉 raw。其余既有断言不变。未改需求或验收标准；正式数据导入、真实数据对照与 DMS 验证留给 Claude review 后执行。
- 验证：`npm.cmd test` 442/442 通过，0 skipped（既有 434 项 + CD-T4 新增 8 项）；实际使用 nc_ops_test，fixture HTTP 对照全部一致，故意差异返回 1。`git -c core.safecrlf=false diff --check` 无输出；普通 `git diff --check` 退出 0，仅有仓库现有 LF/CRLF 转换提示，无空白错误。新增 JS 的 node --check 与空白检查通过；对 Git 跟踪 / 未忽略文件的带密码 PostgreSQL URL 扫描为 0（不读取 .env）。package.json 无 lint / build 脚本；未进行浏览器手工预览，未读取真实 runtime、访问 DMS、写正式库、安装依赖或提交 / 推送 / 部署。

### CD-T5 实现记录（Implementation Notes）— 2026-10-08

- 增加可选 scrape_disabled 的校验与 Denver 的 GJT01 / BZN01 禁用原因；readDistricts 和既有 API 输出保持原结构。范围解析与 planRefresh 为纯函数，严格采用配置顺序，不处理 unassigned。
- 批处理新增 --scope / --trigger / --progress-file；配置跳过项进入 JSON summary 和 DB scope。未指定新参数时保留默认九站、请求顺序、间隔、上限、缓存和熔断逻辑。
- scrape.lock 使用 wx 排他创建；存活检测可注入；保守保留损坏或无法确认的锁。失败竞争不写 run state / progress，不创建 DB run，不访问 DMS；finally 按 pid + started_at 释放自己拥有的锁。
- 进度使用 writeFileAtomic，开始、Station 开始/结束、每条 Route（包括缓存）、结束均写入；写失败只输出固定警告。只保存状态字段与安全 stop_reason，不保存 URL、原始数据或错误文本。
- migration 002 增加 ui 与 scope，重建 v_runs（白名单 options、scope、counts；排除 json_run_id / app_version / import_digest）。skipped 数取 scope.skipped 的长度，其他状态取 scrape_run_stations；scraper 的 UPDATE 列权限保持不变，reader 继续只读视图。正式库 migration 未执行。
- 技术兼容：migrate 每个版本单独事务、按文件版本排序，通过 onResult 回调报告各版本；保留 P2 的首个版本返回值，因此原有迁移断言无需修改。测试 fixture 注入锁替身，新增独立测试在临时目录验证真实文件锁。
- 检查：定向测试 54/54 通过，原有断言未改；npm.cmd test 共 457 项，436 通过、21 失败、0 skipped。21 项均在连接测试 DB 时失败（固定提示“数据库连接失败，请检查本地配置和数据库服务。”）；pg_isready 显示 localhost:5432 - no response。未启动 PostgreSQL、未修改 .env、未访问真实 DMS、未安装依赖、未写正式库或提交/推送/部署。DB 权限、SQL 实际执行与双写需 PostgreSQL 恢复后重新验证；package.json 没有 lint / build 脚本。git diff --check 退出 0，仅有 LF/CRLF 转换提示；git -c core.safecrlf=false diff --check 无输出。已检查 138 个跟踪/未忽略文件，带密码 PostgreSQL URL 为 0（不读取 .env，不打印匹配值）。

### CD-T6 实现记录（Implementation Notes）— 2026-10-08

- 新增独立 Worker 入口与模块，复用 createApiServer / createRequestHandler。监听地址固定 127.0.0.1；所有请求先校验 Host，POST 依次校验 Origin、自定义 header、Content-Type、1 KB JSON 和范围计划。扩展 handler 声明 methods，既有只读接口仍仅允许 GET；Read-only Server 不注册刷新接口。
- 子进程启动函数可注入，使用约定的 scope / trigger ui / new-run / progress-file 参数，不传 refresh、limited 或 headless；stdout / stderr 按行加 [scrape] 前缀。Worker 不 import DMS 模块、不复制抓取逻辑。
- 互斥在异步读取锁之前预占；存活锁及损坏/无法确认的锁保守拒绝，失效锁清除后可启动。启动前原子写入进度标记，保证尚未写进度的子进程崩溃也可在重启后识别。状态结合子进程、锁、进度与 reader 的最近 cli/ui run；无存活进程的 running 进度映射为 stopped / process:Exited。DB run 更新于进度时采用较新的记录。
- 共用 freshness 模块读取经过现有校验的配置，保留 readDistricts 输出；涵盖无 snapshot 的配置 Station 和 unassigned。JSON run 为 null。DB 新增 readRuns / readLastScrapeRun；公共 run 响应明确投影顶层、scope、skipped 和 counts，过滤视图额外字段；stop_reason 仅保留 phase:ErrorType 格式。
- Read-only Server 新增 LISTEN_HOST，只接受 IPv4 或 localhost；非 loopback 要求 DB 且拒绝 writer/owner/DMS 环境变量，再通过 has_table_privilege 检查 INSERT 权限，失败关闭连接并拒绝启动。默认本机日志保持不变；import 遍历测试验证入口无法到达 DMS / Worker / Playwright / child_process。
- 检查：npm.cmd test（PowerShell 的 npm.ps1 被执行策略禁止，使用同一 npm 脚本的 .cmd 入口）467/467 通过，0 failed / skipped；既有 457 项断言未修改。最后的响应脱敏调整再次通过新增定向测试 10/10。真实 DB 验证只使用 nc_ops_test 随机临时 schema，scraper 被拒绝、reader 可实际启动 LAN 服务。git -c core.safecrlf=false diff --check 无输出。package.json 未配置 lint / build。
- 本任务未修改 web/、业务数据或 DB schema；未访问真实 DMS、未启动真实抓取子进程、未安装依赖、未读取或修改 .env 内容、未写正式库、未提交/推送/部署。前端刷新面板及 UI 登录提示仍属于 CD-T7。
- 凭据模式扫描：146 个跟踪及未忽略文本文件未发现带密码 PostgreSQL URL、私钥或高置信度 token/password 字面量，扫描排除 .env 内容。原始 git diff --check 退出 0，仅输出工作区既有 LF/CRLF 转换提示；关闭 safecrlf 提示后无输出。

### CD-T7 实现记录（Implementation Notes）— 2026-10-08

- 新增 `web/data-status.js`，由 `web/index.html` 和 `web/map.html` 以本地 module 加载。共用状态条显示 notice、Last Updated（沿用 formatUpdated，title 保留 ISO）、District / Station 明细与禁用原因；60 秒获取 freshness，失败保留原内容。JSON 后备模式不显示 freshness run 文案。
- 更新记录通过 `/api/runs?limit=20` 获取；District 中文名取 `/api/districts`，缺失时回退 id。刷新按钮仅在 capabilities.refresh 严格为 true 后创建，范围选择排除 unassigned；preview 确认后才 POST，使用约定 JSON 和 X-NC-Refresh header。403 / 400 只显示固定错误，不读取错误响应正文，不自动重试 POST。
- Worker 进度从 status 接口恢复，以 2 秒定时获取；结束后停止轮询并重新获取 freshness。数据更新采用“数据已更新，点击重新加载”按钮，由用户重新加载当前页面，避免打断地图选择或画像浏览。首次加载历史结束状态不误报当前页面数据已更新。
- 对话框使用原生 dialog / Esc 与焦点恢复；更新中刷新按钮 disabled，关闭进度后焦点返回可用的“查看更新进度”按钮，且后台轮询不会再次弹出已关闭的对话框。所有动态内容使用 createElement / textContent，不添加外部资源或依赖。
- 后端唯一改动是 `server/src/api/static-files.js` 共享白名单新增 `/data-status.js`（text/javascript）；没有更改后端业务逻辑或既有测试断言。新增 `server/test/data-status.test.js` 并注册到现有测试入口，使用合成 DOM / API / timer doubles。
- 检查：npm.cmd test 共 474/474 通过，0 failed / skipped（原有 467 项保留）；项目没有 lint / build 脚本。Chromium 通过临时 loopback 静态服务与合成 API 验证两页在 1440 / 390 宽度下无横向溢出和 JS 异常，更新记录与确认对话框可 Esc 关闭并恢复焦点。首次浏览器检查因 PowerShell 管道中文编码导致定位器超时，改用 ASCII 定位器后四种组合全部通过。git diff --check 退出 0，仅有工作区原有 LF/CRLF 转换提示；关闭 safecrlf 提示后无输出。
- 未访问真实 DMS、未启动真实 Worker 或抓取、未安装依赖、未写凭据或正式库，未提交 / 推送 / 部署。UI 尚待 Product Owner 预览签收；真实刷新与局域网验证仍按 CD-T8 后的部署流程进行。

### CD-T8 实现记录（Implementation Notes）— 2026-10-08

- 第 1 轮修复：三个服务脚本的 RepoRoot 默认值改为 null，在主体内使用 PSScriptRoot / MyInvocation 路径回退计算；注册脚本同步使用该目录回退。stdout / stderr 显式按 UTF-8 解码，保留 UTF-8 日志写入；部署文档补充 readonly.env 文件自身读权限及 icacls 检查提示。四脚本 Parser.ParseFile 和 powershell.exe -NoProfile -ExecutionPolicy Bypass -File <script> -? 均通过（退出码 0），未启动 / 停止服务或注册任务；npm.cmd test 474/474 通过、0 skipped；git diff --check 退出 0（仅原有换行提示），git -c core.safecrlf=false diff --check 无输出，六个任务文件另做空白检查通过。
- 新增 `scripts/services/{run-service,start-services,stop-services,register-tasks}.ps1` 与中文 `docs/deployment.md`。不修改 Node、前端、需求或验收标准；保留工作区已有改动。
- 启动入口使用带用户 SID 的 Global Mutex 防止同用户跨会话重复运行；通过 pg_isready 检查数据库，pg_ctl 非阻塞启动后最多等待 60 秒，持续重试；每 60 秒恢复退出的守护进程。Task Scheduler 当前用户登录触发、Interactive / Limited、隐藏窗口、IgnoreNew、失败每分钟重启、无限执行时间；注册仅保存配置，不启动任务，不提权。
- 守护使用 ProcessStartInfo 显式工作目录与 env 文件；readonly 不读 repo .env，并清除继承的 NC_DB_* / NC_TEST_DB_* / DMS_* 与相关配置、NODE_OPTIONS。缺少 readonly.env、端口占用、数据库未就绪时每 60 秒检查；退出重试为 5 / 15 / 60 秒，运行超过 10 分钟后重置。ReadLineAsync 同时排空 stdout / stderr，在 PowerShell 主 runspace 写逐行时间戳日志，避免双管道阻塞与无 runspace 回调。
- worker / readonly / services 日志超过 10 MB 时在下一次写入前滚动，保留 .1；PostgreSQL 日志只在 pg_ctl status 确认 cluster 停止后的启动前滚动，避免 Windows 打开文件移动失败。未配置或修改 PostgreSQL 原生轮转。
- 停止脚本用现有 Node 配置解析实际 runtime（只输出目录）；活 PID 或无法确认的 scrape.lock 保守拒绝，显式 Force 才允许中断。先捕获当前用户、当前脚本路径对应进程的后代，再停止任务和 supervisor / guardian / 服务及批处理 Node；复核创建时间与命令行防 PID 复用，不批量终止其他 Node。IncludePostgres 可额外 fast stop；任务保留注册，注销下次登录仍可启动。
- 文档包括三个进程与访问边界、两个 env、首次部署、Task Scheduler、Private / Domain 防火墙、可信网络、电源与登录要求、交互式 DMS 登录、正式刷新命令、abandon / 残留锁、日志、手动 PostgreSQL 启动、内存事故、loopback JSON 回退限制及 R-P3-1 / TD7。脚本端口探测固定为部署约定 3100 / 3000；更改端口需同步维护脚本与部署配置。
- 检查：Windows PowerShell Parser.ParseFile 对四个脚本均无语法错误；npm.cmd test 474/474 通过，0 failed / skipped，包含真实测试库检查；package.json 无 lint / build 命令。普通 git diff --check 退出 0，仅有原有 LF/CRLF 提示；禁用 safecrlf 提示后无输出。新增文件另做空白检查。新增脚本静态检查未发现写死的凭据或 OneDrive 绝对路径。
- 未执行脚本的服务管理入口，未注册 / 删除任务、启动 / 停止服务、改变防火墙 / 网络 / 电源；未读取或输出 .env 内容、写凭据、访问真实 DMS、部署、提交或推送。CD-AC35 运行验收和 CD-AC36 真实验证留给 Claude review 后执行，语法检查不证明登录自启已经通过。

## 21. P2 详细设计（Product Owner 2026-10-07 授权）

本节细化第 12、13、16.2 节；有出入时以本节为准。

### 21.1 本节新确认的决定（Product Owner 2026-10-07）

- **D-P2-1 两边都不返回 raw：** `/api/route-profiles` 返回的每一行不再包含 `raw`，JSON 和 DB 两种数据源都一样（`parse_errors` 保留）。前端没有用到 `raw`，页面不受影响。`route-profiles.json` 文件里仍然保存 `raw`；Tableau 导出直接读文件，不受影响。
- **D-P2-2 DB 写入失败时停止整个 run：** 双写中只要 DB 写失败，就按 store 失败处理，立即停止 run。`stop_reason` 沿用失败时实际所处的 phase，并以 `:DbStoreError` 结尾，例如 `store:DbStoreError`、`switch:DbStoreError`（2026-10-07 澄清）。DB 的当前版本指针不变。这个 Station 的 JSON 可能已经更新，而 DB 还是旧版本；两边暂时不一致，run 记录里写明 DB 失败，下一次成功刷新后两边会重新对齐。
- **D-P2-3 PostgreSQL 采用便携版：** 不装 Windows 服务，以当前用户身份用 `pg_ctl` 运行，不需要管理员权限。P3 再用 Task Scheduler 实现开机启动（第 21.2 节）。

### 21.2 环境（Claude 已于 2026-10-07 在本机完成）

- PostgreSQL 17.11：
  - 安装来源：EDB 官方安装器，带有效的 EnterpriseDB 数字签名，SHA256 与 winget 清单一致。只用 `--extract-only` 解出文件，没有执行安装。
  - 与 EDB 免安装包中 `bin` 目录下 69 个 exe / dll 的哈希逐一比对，完全一致。
- 安装位置：
  - 程序：`%LOCALAPPDATA%\nc-ops-console\pgsql`
  - 数据：`%LOCALAPPDATA%\nc-ops-console\pgdata`
  - 日志：`%LOCALAPPDATA%\nc-ops-console\logs\postgres.log`
  - 都不在 repo、OneDrive 或 runtime 目录下。
- 网络与认证：`listen_addresses = 'localhost'`，端口 5432；认证方式 `scram-sha-256`；没有新增任何防火墙规则（已检查 5432 和 postgres 相关规则均为 0 条）。
- 超级用户名为 `nc_admin`（不使用默认的 `postgres`），只在人工维护时使用，应用不使用。
- 密码：所有密码随机生成，保存在 `%LOCALAPPDATA%\nc-ops-console\secrets\`（目录权限只给当前用户）。连接串写在 repo 根目录的 `.env` 中（已被 gitignore，不提交）。
- 启动和停止（P3 之前手动执行）：
  - 启动：`"%LOCALAPPDATA%\nc-ops-console\pgsql\bin\pg_ctl.exe" -D "%LOCALAPPDATA%\nc-ops-console\pgdata" -l "%LOCALAPPDATA%\nc-ops-console\logs\postgres.log" start`
  - 停止：把上面命令中的 `start` 换成 `stop`。

| 数据库角色 | 属性 | 用途 |
|---|---|---|
| `nc_owner` | LOGIN，非 superuser，无 CREATEDB / CREATEROLE；是 `nc_ops` 的 owner | 人工执行建表脚本（migration） |
| `nc_scraper` | LOGIN；只有 `nc_ops` 的 CONNECT 权限，其余权限由建表脚本授予 | 批处理双写、JSON 导入 |
| `nc_reader` | LOGIN；只有 `nc_ops` 的 CONNECT 权限，只授予对视图的 SELECT | 只读 API |
| `nc_warehouse` | LOGIN；只有 `nc_ops` 的 CONNECT 权限，`warehouses` 的有限 CRUD 由 migration 003 授予 | 只给 Worker（3100）使用 |
| `nc_test_warehouse` | LOGIN；只有测试库 `nc_ops_test` 的 CONNECT 权限，有限 CRUD 由 migration 003 授予 | 自动化测试 |
| `nc_test_owner` / `nc_test_scraper` / `nc_test_reader` | 同上，但对应测试库 `nc_ops_test` | 自动化测试 |

`.env` 中的变量：`DATA_SOURCE`（默认 `json`）、`NC_DB_OWNER_URL`、`NC_DB_SCRAPER_URL`、`NC_DB_READER_URL`、`NC_TEST_DB_OWNER_URL`、`NC_TEST_DB_SCRAPER_URL`、`NC_TEST_DB_READER_URL`。`.env.example` 只列出变量名，不写入真实值。

依赖：`pg` 固定版本 8.23.0（发布于 2026-08-08；8.23.1 发布不满两周，所以不用）。

### 21.3 建表脚本（migration）

- 文件：`server/db/migrations/001_central_db.sql`（新目录）。用 `npm run db:migrate` 执行（以 `nc_owner` 身份运行；程序只读取连接串，不输出连接串）。
- 所有对象放在 schema `nc` 中，不使用 `public`。
- 脚本参数化 schema 名、scraper 角色名、reader 角色名，这样测试可以使用临时 schema 和测试角色。参数由执行脚本的程序用 `pg` 的标识符转义函数代入，不拼接未经转义的字符串。
- 用一张 `schema_migrations(version, applied_at)` 表记录已执行的版本，重复执行时跳过，不会重复建表。

**表**（关系字段单独成列，指标放 jsonb）：

```sql
stations(code text PK CHECK (code ~ '^[A-Z]{3}\d{2}$'),
         active_snapshot_id bigint NULL FK → station_snapshots(id),
         created_at timestamptz)

scrape_runs(id uuid PK, trigger text CHECK IN ('cli','json_import'),
            json_run_id text NULL,          -- 对应 station-batch-state.json 中的 run_id
            app_version text NULL,          -- 运行时的 git commit 短哈希，取不到时为 null
            status text CHECK IN ('running','completed','stopped','abandoned'),
            requested_stations text[], options jsonb,   -- refresh / max_routes_per_station / new_run
            started_at timestamptz, finished_at timestamptz NULL,
            prod_api_requests int NULL, request_cap int NULL,
            stop_reason text NULL,          -- 只能是 'phase:ErrorType' 格式
            original_station_restored boolean NULL,
            import_digest text NULL)        -- 导入时两份 JSON 文件内容的 sha256
  UNIQUE INDEX one_running_run ON scrape_runs ((true)) WHERE status = 'running'

scrape_run_stations(run_id FK, station_code text, PK(run_id, station_code),
            status text,                    -- 沿用 run state：pending | in_progress | completed | limited | stopped
            route_total int NULL, success_count int, cached_count int, failed_count int,
            request_count int NULL, started_at, ended_at NULL, stop_reason text NULL,
            integrity jsonb NULL, snapshot_id bigint NULL)

station_snapshots(id bigserial PK, station_code FK, run_id FK,
            status text CHECK IN ('pending','active','superseded','rejected'),
            origin text CHECK IN ('dms','json_import'),
            fetched_at text,                -- 原样保存 JSON 中的字符串，保证对照测试逐字一致
            source_as_of text NULL, source text, total int,
            created_at, activated_at NULL, superseded_at NULL, rejected_reason text NULL)
  UNIQUE INDEX one_active_per_station ON station_snapshots (station_code) WHERE status = 'active'

snapshot_routes(snapshot_id FK, route_id bigint, ordinal int, route_name text,
            profile jsonb,                  -- 完整的 row 对象（包括 raw、parse_errors、postal_codes）
            detail_version_id bigint NULL FK,
            PK(snapshot_id, route_id), UNIQUE(snapshot_id, ordinal), UNIQUE(snapshot_id, route_name))

snapshot_route_zips(snapshot_id, route_id, postal_code text CHECK (postal_code ~ '^\d{5}$'), ordinal int,
            PK(snapshot_id, route_id, postal_code), UNIQUE(snapshot_id, postal_code))
            -- 写入时必须与 profile.postal_codes 完全一致

route_detail_versions(id bigserial PK, route_id bigint, station_code text, run_id FK,
            origin text CHECK IN ('dms','json_import'),
            status text CHECK IN ('pending','committed'),
            fetched_at text,
            detail jsonb,                   -- route detail 对象中除 zips 以外的部分（包括 capacity_raw、parse_errors）
            created_at, committed_at NULL)

route_detail_zips(detail_version_id FK, ordinal int, postal_code text NULL,
            zip jsonb,                      -- 完整的 zip 对象（包括 raw）
            PK(detail_version_id, ordinal))
```

`districts` 不进数据库：两种数据源都直接读 `config/districts.json`，对照测试天然一致。等以后真正需要时再加。

**只读视图**（`nc_reader` 只有这些视图的 SELECT 权限；视图以 owner 身份执行查询）：

| 视图 | 内容 |
|---|---|
| `v_active_snapshots` | 每个 Station 当前生效的 snapshot：station_code、fetched_at、source_as_of、source、total |
| `v_active_routes` | 当前生效 snapshot 的所有 Route，按 ordinal 排序，`profile - 'raw'` |
| `v_route_details` | 每个 route_id **最新一个 committed** 的 detail 版本，detail 部分去掉 `capacity_raw` |
| `v_route_detail_zips` | 上面那个版本的 ZIP，`zip - 'raw'` |
| `v_runs` | run 历史：去掉 `import_digest`，`options` 只保留白名单字段 |

**权限：**

- `nc_scraper`：
  - 所有表：SELECT。
  - `stations`、`scrape_runs`、`scrape_run_stations`、`station_snapshots`、`snapshot_routes`、`snapshot_route_zips`、`route_detail_versions`、`route_detail_zips`：INSERT。
  - UPDATE 只开放下面这些列（2026-10-07 Claude 补全；CD-T2 时 Codex 指出原来写的“状态和计数列”不够明确）：
    - `stations`：`active_snapshot_id`
    - `scrape_runs`：`status`、`finished_at`、`prod_api_requests`、`request_cap`、`stop_reason`、`original_station_restored`
    - `scrape_run_stations`：除主键 `run_id`、`station_code` 外的**所有列**（`status`、`route_total`、`success_count`、`cached_count`、`failed_count`、`request_count`、`started_at`、`ended_at`、`stop_reason`、`integrity`、`snapshot_id`）。这些都是运行元数据，在 run 中途会多次更新
    - `station_snapshots`：`status`、`activated_at`、`superseded_at`、`rejected_reason`
    - `route_detail_versions`：`status`、`committed_at`
    - 其他列（例如 `station_snapshots.fetched_at`、`snapshot_routes.*`、`route_detail_versions.detail`）一律**不开放** UPDATE，写入后不能修改
  - 序列：USAGE。
  - **没有** DELETE、TRUNCATE、DDL 权限。
- `nc_reader`：只有视图的 SELECT 权限；基础表没有任何权限。
- 两个角色都没有 `nc` schema 的 CREATE 权限。

### 21.4 数据库写入接口（`createDbBatchSink`）与双写

- 新增一个数据库版写入接口，动作和 P1 的 JSON 版完全一样。另新增一个双写接口，把两者组合起来：
  - 每个动作**先写 JSON，再写 DB**。
  - DB 抛出的任何错误统一包装成 `DbStoreError`（加入 `safeType` 白名单），然后按 D-P2-2 停止 run。
- 开关：环境变量 `DB_DUAL_WRITE=1`，并且必须配置 `NC_DB_SCRAPER_URL`。开启后，在 `phase='store'` 阶段、访问 DMS 之前先连接 DB 并创建 run，失败就直接停止，不产生任何 DMS 请求。不开启时，行为和 P1 完全一样。
- 只有 `dms:scrape-stations` 做双写。旧的单 Station 命令（`dms:scrape`、`dms:scrape-route-detail`、`dms:scrape-route-details`）在 P2 期间仍然只写 JSON（见风险 R-P2-2）。

| 动作 | DB 中做什么 |
|---|---|
| startRun | INSERT 一条 `scrape_runs`（status=running）。如果已有 running 的 run，唯一索引会拒绝，报错信息包含那个 run 的 id 和 started_at |
| writeStationSummary / writeState | 对 `scrape_run_stations` 执行 INSERT，如果已存在就 UPDATE 状态和计数 |
| writeRouteDetail | 一个事务：INSERT `route_detail_versions`（status=pending）和 `route_detail_zips`；COMMIT 前调用 `beforeCommit` |
| activateStationSnapshot | 见第 21.5 节 |
| finishRun | 更新 `scrape_runs` 的 status、finished_at、计数和 stop_reason |

**DB 失败的影响范围**（2026-10-07 澄清，依据已确认的“按 Station 独立生效、已成功的不回滚”）：

- 在某个 Station 的生效事务提交**之前**失败：这个 Station 的 DB 指针保持旧版本；新 snapshot 如果已经写入，标为 rejected。
- 已经生效的 Station（包括当前 Station 已生效、但之后写汇报信息时失败的情况）**不回滚**，新数据保留。
- 生效之后、写 `scrape_run_stations` 汇报信息或 `finishRun` 时失败：run 停止，退出码为 1。DB 中这个 Station 的汇报状态可能还停在 in_progress，或者 run 还停在 running（需要执行 `db:abandon-run`），但 snapshot 已经生效，数据是一致的。
- JSON 一侧的 run state / summary 由现有的失败处理逻辑写入。如果在 finishStation 期间失败，JSON summary 可能把这个 Station 记为 stopped，而它的 snapshot 实际已经生效。这种情况和 P1 中 JSON summary 写入失败时的行为一样。

**卡在 running 的 run：** 如果进程崩溃，run 会一直停在 running，挡住后续所有 run。新增 `npm run db:abandon-run -- <run_id>`：只能把 `running` 改成 `abandoned`，执行前要求操作人确认当前确实没有抓取在运行。P3 会改为由锁文件自动检测。

### 21.5 Station 生效流程（DB 版）

（2026-10-07 修订：CD-T3 时 Codex 指出，`snapshot_routes` 不允许 UPDATE，所以“先写 routes、再补链接”行不通。现改为先选出 Detail 版本，再一次性写入。只调整技术步骤顺序，最小权限不变。）

1. **选出每个 Route 要链接的 Detail 版本**（只读查询，不写入）：在该 route_id 的版本中，按新到旧（`id` 降序）取第一个能通过 `completeRouteDetail(detail, row, { allowZipMismatch: 本次新抓的 Route })` 的版本，pending 和 committed 都算。这里复用 `station-integrity.js`，不另写一套规则。
   - 本次处理过的 Route（新抓的和沿用缓存的）**都必须**找到合格版本，否则抛出 `DbIntegrityError`。这属于 DB 和 JSON 不一致（例如还没导入），会停止 run。此时还没有写入 snapshot，所以没有要标为 rejected 的记录。
   - 没有处理到的 Route（`limited` 模式下被跳过的）：有合格版本就链接，没有就设为 null。
2. **写 pending snapshot**（单独一个事务）：
   - 如果 `stations` 中还没有这个 Station，先插入。
   - INSERT `station_snapshots`（status=pending），以及 `snapshot_routes`（按列表顺序写 ordinal，`detail_version_id` 填第 1 步选出的版本）和 `snapshot_route_zips`。
3. **生效**（短事务，COMMIT 前调用 `beforeCommit`）：
   - 确认这个 snapshot 仍是 pending，并且 run 仍是 running；
   - 旧的 active 版本改为 superseded；新版本改为 active；
   - `stations.active_snapshot_id` 指向新版本；
   - 新版本链接到的 detail 版本改为 committed；
   - 这个 run 的 `scrape_run_stations.snapshot_id` 写入新版本。
4. **任何一步失败**：
   - 新版本改为 `rejected`，`rejected_reason` 只写错误类型（这一步单独执行，再失败也忽略）；
   - 当前版本指针不变；
   - 错误继续抛出，按 D-P2-2 停止 run。

PostgreSQL 默认的 READ COMMITTED 隔离级别保证：读者要么看到完整的旧版本，要么看到完整的新版本。pending 或 rejected 的 snapshot，以及 pending 的 detail 版本，不会出现在任何只读视图里。

### 21.6 JSON 导入（`npm run db:import-json`）

- 以 `nc_scraper` 身份执行。只读取 `route-profiles.json` 和 `route-details.json`，**不修改、不删除** JSON 文件。
- 导入前先用现有的 reader / 校验函数检查两个文件，任一不合法就整体拒绝，什么都不写。
- **只允许导入一次：** 只要数据库里已有任何 snapshot 或 detail 版本，就拒绝导入并提示原因。这样不会把较旧的 JSON 覆盖到较新的 DB 上。同一份内容重复执行时，报告“已导入过”（按 `import_digest` 判断）。整个导入放在一个事务里，要么全部写入，要么全部不写。
- 导入内容：
  - 新建一条 run（trigger 为 `json_import`、status 为 completed、`import_digest` 为两份文件内容的 sha256；`started_at` / `finished_at` 是导入时的真实时间）。
  - 每个 Station 一个 snapshot：origin 为 `json_import`，status 直接设为 active，`fetched_at`、`source_as_of`、`source`、`total` 原样保留。
  - `route-details.json` 中的每条记录导入为一个 detail 版本：origin 为 `json_import`，status 为 committed，`fetched_at` 原样保留。不在任何 snapshot 中的历史 Route（例如 route 831）也照样导入。
  - snapshot 中的 Route 链接到同一 route_id 并且 station 相同的 detail 版本；没有的就设为 null。
- 不伪造任何时间。

### 21.7 只读 API 支持两种数据源（`DATA_SOURCE=json|db`）

- `server/src/api/server.js` 改为依赖一个数据源对象，提供 4 个方法：`readRouteProfiles()`、`getStationSnapshot(station)`、`getRouteDetail(routeId)`、`readRouteDetailsForMap()`。
  - JSON 实现：包装现有的文件读取函数。
  - DB 实现：用 `nc_reader` 账号查视图，**拼出和 JSON 版完全一样的对象结构**。
- `route-map.js`、`districts-file.js`、`app.js` 的业务逻辑两种数据源共用，不复制。
- 默认 `DATA_SOURCE=json`。值不是 `json` / `db`，或者 `db` 模式下缺少 `NC_DB_READER_URL` 时，启动失败并给出明确提示。
- 错误语义保持一致：
  - 没有任何生效数据 → `SnapshotNotFoundError`
  - Station 不存在 → `StationNotFoundError`
  - Route Detail 不存在 → `RouteDetailNotFoundError`
  - **新增：** 只在 DB 模式下、数据库连不上时返回 503 `data_source_unavailable`。这是唯一已知的 API 差异，只在故障时出现。
- `readRouteDetailsForMap` 的 status：JSON 版保持原样；DB 版在有 committed 的 detail 版本时返回 `ok`，没有时返回 `none`。
- `app.js` 的 `/api/route-profiles` 返回每一行时去掉 `raw`（D-P2-1），两种数据源走同一段代码。
- 读取方式：每个请求从连接池取连接、查询后归还；不在服务端缓存数据。数据量小，不需要缓存。

### 21.8 测试

- `npm test` 的脚本改为 `node --env-file-if-exists=.env --test server/test/`。
- 需要 DB 的测试读取 `NC_TEST_DB_*`。没有配置时这些测试显示为 **skipped**，并在测试名称中注明原因。Claude 在 review 时会确认它们没有被跳过。
- 每个 DB 测试文件使用自己随机命名的临时 schema（例如 `nc_t_<随机串>`），先执行建表脚本，结束时删除。这样文件之间并行运行也互不影响。
- 覆盖的内容见第 21.10 节 P2 验收标准。

### 21.9 真实 DMS 小规模验证（全部测试通过后才做）

| 次序 | Station | 参数 | 验证什么 | 预计 /prod-api/ 请求数 |
|---|---|---|---|---|
| 1 | MFR01（2 条 Route，Detail 缓存都完整） | `--stations MFR01 --new-run` | 重抓列表；所有 Detail 都沿用缓存；DB 中生成新 snapshot 并切换指针；Detail 链接到导入的版本 | 约 5–15（切站 + 列表） |
| 2 | RDG02（2 条 Route） | `--stations RDG02 --refresh --max-routes-per-station 1 --new-run` | 新抓 1 条 Detail，产生 pending → committed 的 detail 版本；另一条链接旧版本；状态为 limited；指针切换 | 约 25–40（切站 + 列表 + 1 条 Detail） |

- 合计约 30–55 个请求，远低于单次 run 的上限。
- 每次 run 结束后检查：JSON 已更新；DB 中有对应的 run 记录和生效的 snapshot；`DATA_SOURCE=db` 时 API 能读到新数据，并且和 `DATA_SOURCE=json` 的输出一致；没有 429、5xx 或 session 问题；原 Station 已恢复。
- “完整性检查失败时指针不切换”只用自动化测试验证，不在真实 DMS 上故意制造失败。

### 21.10 P2 验收标准（取代第 16.2 节）

- **CD-AC11** 建表脚本能在空 schema 上执行，重复执行时跳过；表、索引、视图、权限与第 21.3 节一致。
- **CD-AC12** `nc_reader`：对任何表执行 INSERT / UPDATE / DELETE 都失败；读基础表失败；视图中查不到 raw 和 capacity_raw。
- **CD-AC13** `nc_scraper`：执行 CREATE TABLE / ALTER / DROP / TRUNCATE / DELETE 都失败；第 21.3 节列出的 INSERT 和 UPDATE 可以成功。
- **CD-AC14** 同一时间只能有一个 running 的 run，第二个被数据库拒绝；`db:abandon-run` 只能把 running 改为 abandoned。
- **CD-AC15** pending 和 rejected 的 snapshot、pending 的 detail 版本，在只读视图和 DB 数据源中都读不到。
- **CD-AC16** 生效成功：指针切换，旧版本变为 superseded，被链接的 detail 版本变为 committed。在生效事务内部抛错（包括 `beforeCommit` 抛错）时：当前版本不变，新版本变为 rejected。
- **CD-AC17** Detail 链接复用 `completeRouteDetail`：缓存跳过的 Route 链接到已有的合格版本；本次处理过的 Route 找不到合格版本时，抛出 `DbIntegrityError` 并且指针不变。
- **CD-AC18** 双写：DB 任意一步失败都会停止 run，`stop_reason` 以 `:DbStoreError` 结尾；**正在生效的那个 Station** 的 DB 指针保持旧版本；JSON 行为与 P1 相同（范围见第 21.4 节“DB 失败的影响范围”）。不开启 `DB_DUAL_WRITE` 时，行为与 P1 完全相同，现有测试断言一律不改。
- **CD-AC19** JSON 导入：保留 `fetched_at`、`source` 等原始字段；导入后的当前版本等于 JSON 中的数据；第二次执行被拒绝；JSON 不合法时整体拒绝且不写入任何数据；导入不修改 JSON 文件。
- **CD-AC20** 对照测试：用同一份数据（测试 fixture，以及本机真实 runtime JSON 导入后的数据），在 `DATA_SOURCE=json` 和 `db` 下比较以下接口的完整 JSON 响应（`deepStrictEqual`），必须一致：`/api/districts`、`/api/route-map/stations`、每个 Station 的 `/api/route-profiles`、每个 route_id 的 `/api/route-details`（包括不在当前 snapshot 中的历史 Route）、每个 Station 的 `/api/route-map`、每个 District 的 `/api/route-map/district`、抽样 ZIP 的 `/api/route-map/zip`（包括 covered、multi_station、uncovered、out_of_range 几种情况），以及 404 / 400 等错误响应。比较本机真实数据的脚本只在本地运行，不提交真实数据。
- **CD-AC21** `/api/route-profiles` 两种数据源都不返回 `raw`（D-P2-1），这是唯一修改的现有断言；前端测试不需要修改。
- **CD-AC22** `npm test` 全部通过，DB 测试没有被跳过；`git diff --check` 没有输出；`.env.example` 中没有真实密码；repo 中没有任何连接串或密码。
- **CD-AC23** 真实 DMS 小规模验证（第 21.9 节）通过：没有 429、5xx 或 session 问题。

### 21.11 风险（P2）

- **R-P2-1** PostgreSQL 目前是手动用 `pg_ctl` 启动的，电脑重启后不会自动运行；P3 用 Task Scheduler 解决。
- **R-P2-2** 旧的单 Station 命令只写 JSON。用了它们之后，DB 会落后于 JSON，直到下一次 `dms:scrape-stations` 刷新同一个 Station。P2 / P3 期间请只使用 `dms:scrape-stations`。
- **R-P2-3** D-P2-2 可能造成一个 Station 的 JSON 和 DB 暂时不一致；当前读的是 JSON，所以对使用者没有影响。
- **R-P2-4** 进程崩溃后，run 会一直停在 running，需要手动执行 `db:abandon-run`（P3 改为锁文件自动处理）。

### 21.12 Codex 任务拆分

| 任务 | 内容 | 验收 |
|---|---|---|
| CD-T2 | 建表脚本、`db:migrate`、DB 连接配置、`.env.example`、npm test 脚本、DB 测试辅助工具，以及角色和权限测试 | CD-AC11–13、CD-AC22（部分） |
| CD-T3 | DB 写入接口、双写接口、生效事务、Detail 链接、`db:abandon-run`、run 唯一性 | CD-AC14–18 |
| CD-T4 | JSON 导入、DB 数据源、`DATA_SOURCE` 开关、去掉 raw、对照测试 | CD-AC15、19–21 |
| （Claude） | 导入本机真实数据、比较真实数据的对照结果、真实 DMS 小规模验证 | CD-AC20、23 |

---

## 22. P3 详细设计（Product Owner 2026-10-08 授权）

本节细化第 9–11、15 节；有出入时以本节为准。P2 的设计（第 21 节）继续有效。

### 22.1 进程、端口与配置

| 进程 | 监听地址 | 命令 | 配置来源 | 持有的凭据 |
|---|---|---|---|---|
| PostgreSQL | `localhost:5432` | `pg_ctl`（第 21.2 节） | `pgdata` | — |
| Worker | **固定** `127.0.0.1:<WORKER_PORT>`（默认 3100；只能改端口，不能改地址） | `npm run worker`（新增 `server/bin/worker.js`） | repo 的 `.env` | DMS storageState、`NC_DB_SCRAPER_URL`（只传给子进程）、`NC_DB_READER_URL` |
| Read-only Server | `LISTEN_HOST:PORT`（默认 `127.0.0.1:3000`；局域网部署时设为 `0.0.0.0:3000`） | `node --env-file=<readonly.env> server/bin/server.js` | **单独的** `%LOCALAPPDATA%\nc-ops-console\config\readonly.env` | 只有 `NC_DB_READER_URL` |

- `readonly.env` 只包含 `DATA_SOURCE=db`、`NC_DB_READER_URL`、`LISTEN_HOST`、`PORT`，以及可选的 `RUNTIME_DATA_DIR`。它放在 repo 外，由 Claude 在部署时创建。部署时 Read-only Server **不使用** repo 的 `.env`，所以它的进程环境中没有 scraper / owner 凭据，也没有 DMS 配置。
- repo `.env` 按 Product Owner 2026-10-08 的决定设置：`DB_DUAL_WRITE=1`、`DATA_SOURCE=db`。抓取继续同时写 JSON 和 DB；JSON 继续写，不删除。
- `npm run server`（本机开发用）仍然读取 `.env`，并且默认只监听 `127.0.0.1`，行为不变。
- **Read-only Server 启动时的保护（`LISTEN_HOST` 不是 loopback 地址时强制执行）：**
  - 必须是 `DATA_SOURCE=db`；
  - 环境中出现 `NC_DB_SCRAPER_URL`、`NC_DB_OWNER_URL`、`DMS_BASE_URL`、`DMS_STATE_PATH` 中任何一个，就拒绝启动；
  - 连接 DB 后执行 `SELECT has_table_privilege('scrape_runs','INSERT')`，结果为 true（说明用了有写权限的账号）就拒绝启动。
  - 拒绝时只输出固定的中文提示，退出码为 1。
- 说明：Worker 和 Read-only Server 以同一个 Windows 用户运行。上面的隔离是**进程配置层面**的：Read-only Server 不加载、不持有写入能力。它不是操作系统层面的权限隔离（同一个用户理论上能读到 `.env` 文件）。这符合 MVP“公用电脑物理可信”的前提。

### 22.2 代码边界

- Read-only Server（`server/bin/server.js`）在静态 import 关系上**不能**到达 `server/src/dms/`、`server/src/worker/`、`server/bin/dms-*`、`playwright`，也不能用到 `child_process`。用测试从入口文件出发遍历 import 关系来验证。
- Worker 的代码放在 `server/src/worker/`，只由 `server/bin/worker.js` 引入。Worker 复用 `createApiServer` 和 `createRequestHandler` 提供只读接口和静态文件，再额外加上自己的接口；只读 API 的业务逻辑不复制。
- 抓取逻辑不复制：Worker 用 `child_process.spawn(process.execPath, ['--env-file-if-exists=.env', 'server/bin/dms-scrape-stations.js', ...])` 启动现有命令，`cwd` 为 repo 根目录，不使用 shell。

### 22.3 `scrape_disabled` 与刷新范围

- `config/districts.json` 的每个 District 可以带一个可选字段：`"scrape_disabled": { "<CODE>": "<reason>" }`。
  - reason 只能是：`not_in_dms_menu`（DMS 中没有此 Station）、`no_permission`（无权限）、`disabled`（已停用）。
  - key 必须属于这个 District 的 `stations`，否则整个配置视为无效，抛出 `DistrictConfigInvalidError`。
  - `schema_version` 仍为 1；Station 属于哪个 District 不变；`readDistricts` 和 `/api/districts` 的输出**不变**。
- 本次配置：Denver District 写入 `"scrape_disabled": { "GJT01": "not_in_dms_menu", "BZN01": "not_in_dms_menu" }`（依据 `district.md` 中 2026-10-07 的记录）。
- 新增纯函数 `planRefresh({ config, scope })`（放在 `server/src/batch/refresh-plan.js`）：
  - `scope` 为 `{ type: 'all' }` 或 `{ type: 'district', district: '<id>' }`；`district` 不存在时抛出错误。
  - 返回 `{ scope, stations: [{ code, district }], skipped: [{ code, district, reason }] }`。
  - 顺序：District 按配置顺序，District 内按 `stations` 顺序。
  - `unassigned` 的 Station 不参与。
- **`dms:scrape-stations` 新增参数：**
  - `--scope all` 或 `--scope district:<id>`：读取 `config/districts.json`，用 `planRefresh` 算出 Station 列表。不能和 `--stations` 同时使用，否则拒绝执行。
  - `--trigger ui|cli`：默认 `cli`，写入 DB run 的 trigger。
  - Worker 固定传 `--scope … --trigger ui --new-run`，**不传** `--refresh`、`--max-routes-per-station`、`--headless`。浏览器沿用已验证过的有界面模式。
  - 不传 `--scope` 时，行为与现在完全一样，`defaultStationOrder` 不变。
- 跳过的 Station 不会被切站或访问。它们记录在 run 的 scope 中（DB 的 `scrape_runs.scope.skipped`，JSON 的批次 summary 中的 `skipped_by_config`），状态显示为 `skipped`。运行中出现的未知错误**不会**变成 skipped，仍按现有规则停止。

### 22.4 同一时间只有一个 run（三层）

1. **Worker 进程内的互斥锁**：已有子进程在运行时，`POST /api/refresh` 返回 409 `refresh_in_progress`，不排队，也不启动第二个进程。
2. **锁文件 `<runtimeDir>/scrape.lock`**：由 `dms:scrape-stations` 自己获取（无论是 Worker 启动的还是从命令行启动的）。
   - 用 `wx` 方式创建，内容为 `{ pid, started_at, trigger }`。
   - 锁文件已存在时：如果记录的 pid 仍然存活（`process.kill(pid, 0)` 成功），就以 `config:LockedError` 停止，退出码为 1，不访问 DMS；如果 pid 已经不存在，视为失效锁，删除后重试一次。
   - 在 `finally` 中只删除**自己创建的**锁文件。
   - Worker 在启动子进程之前也会检查这个锁，有锁就直接返回 409。
3. **DB 的 `one_running_run` 唯一索引**（P2 已完成）。

### 22.5 进度文件与 Worker 状态

- `dms:scrape-stations` 在设置 `--progress-file <path>` 时写入进度文件（原子写）。Worker 固定传 `<runtimeDir>/refresh-progress.json`。
- 进度文件内容：`{ run_id, scope, started_at, updated_at, phase, station, district, station_index, station_total, route_index, route_total, completed, skipped, failed, finished_at, status, stop_reason }`。
  - 写入时机：开始；每个 Station 开始和结束；每条 Route 开始处理时；结束。
  - 不写 URL、错误内容或 DMS 原始数据。
- `GET /api/refresh/status`（只有 Worker 提供）按以下来源组合出当前状态，**不依赖 Worker 或前端的内存**：Worker 的子进程状态、锁文件、进度文件，以及 DB 中最近一次 run（通过 reader 视图读取）。
  - `state`：`idle`（还没有任何 run）、`running`、`completed`、`stopped`。
  - 同时返回进度文件中的字段，以及 `needs_login`（stop_reason 以 `:NeedsLoginError` 结尾时为 true）。
  - 刷新页面后，会从这个接口重新读取状态。
- Worker 重启时，如果锁文件对应的 pid 仍然存活，仍然报告为 running。

### 22.6 Worker 接口与安全检查

| 接口 | 说明 |
|---|---|
| 现有只读接口和静态文件 | 与 Read-only Server 相同（`DATA_SOURCE` 来自 `.env`） |
| `GET /api/capabilities` | `{ "refresh": true }` |
| `GET /api/refresh/preview?scope=all` 或 `?scope=district:<id>` | 返回 `planRefresh` 的结果：要处理的 Station、要跳过的 Station 和原因 |
| `POST /api/refresh` | 请求体 `{ "scope": "all" }` 或 `{ "scope": "district:<id>" }`。成功返回 202 和 status；已有 run 返回 409；校验失败返回 403 / 400 |
| `GET /api/refresh/status` | 第 22.5 节 |

- **所有 Worker 请求**都必须通过 `Host` 检查：`Host` 只能是 `127.0.0.1:<port>` 或 `localhost:<port>`，否则返回 403。这是为了防止 DNS rebinding。
- **`POST /api/refresh` 还要满足：**
  - `Origin` 只能是 `http://127.0.0.1:<port>` 或 `http://localhost:<port>`；
  - 必须带 `X-NC-Refresh: 1`；
  - `Content-Type` 必须是 `application/json`；
  - 请求体不超过 1 KB，`scope` 合法。
  - 任何一项不满足，返回 403 或 400，**不启动任何子进程**。
- Worker 启动日志明确输出：`Worker: http://127.0.0.1:<port>（仅本机 localhost-only）`。

### 22.7 Read-only Server 新增的只读接口（两个 server 都提供）

- `GET /api/capabilities`：Read-only Server 返回 `{ "refresh": false }`。
- **`GET /api/freshness`**：
  ```json
  {
    "source": "db",
    "notice": "数据来自 DMS 抓取，非实时",
    "global": { "newest_fetched_at": "...", "oldest_fetched_at": "..." },
    "districts": [ { "id": "...", "newest_fetched_at": "...", "oldest_fetched_at": "...", "stations_with_data": 0, "station_count": 0 } ],
    "stations":  [ { "code": "...", "district": "...", "fetched_at": "...", "scrape_disabled": null } ],
    "run": {
      "running": false,
      "last": { "status": "...", "trigger": "...", "started_at": "...", "finished_at": "...", "stop_reason": "...", "needs_login": false }
    }
  }
  ```
  - Station 级的时间取当前生效 snapshot 的 `fetched_at`；District 级和全局取其中最新和最旧的值。
  - `run.last` 取最近一次 trigger 为 `cli` 或 `ui` 的 run，不算 json_import。
  - JSON 模式（后备）：`fetched_at` 从 `route-profiles.json` 读取，`run` 为 `null`。
- **`GET /api/runs?limit=20`**（limit 范围 1–50，默认 20）：每项包括 `id`、`trigger`、`status`、`started_at`、`finished_at`、`scope`（type / district / skipped 列表）、`counts`（completed / limited / stopped / skipped / pending 各多少个 Station）、`stop_reason`（`phase:ErrorType` 格式）、`prod_api_requests`。
  - **不返回**：json_run_id、app_version、import_digest、原始错误、主机名、用户名、IP、URL。
  - JSON 模式下返回 `{ runs: [], source: 'json' }`。

### 22.8 Migration 002（`server/db/migrations/002_refresh.sql`）

- `scrape_runs.trigger` 的 CHECK 约束增加 `'ui'`。
- `scrape_runs` 新增 `scope jsonb NULL` 列。
- 重建 `v_runs`：增加 `scope`，以及从 `scrape_run_stations` 聚合出来的各状态 Station 数；继续不包含 import_digest、json_run_id、app_version；`options` 仍只保留白名单字段。
- 权限保持最小：scraper 可以在 INSERT 时写入 scope，但**不开放**对 scope 的 UPDATE；reader 仍然只能查视图。
- migrate 程序要支持按版本依次执行（001 → 002），已经执行过的跳过。

### 22.9 前端（同一套页面，`index.html` 和 `map.html` 都要改）

- **所有电脑**：页面顶部的数据状态条（来自 `/api/freshness`，每 60 秒刷新一次）：
  - 固定文案“数据来自 DMS 抓取，非实时”；
  - Last Updated（全局最新时间），可以展开查看各 District / Station 的时间；
  - 正在更新时显示“公用电脑正在更新数据，当前显示的是上次成功的数据”；
  - 最近一次 run 是 stopped 时显示“最近一次更新失败（时间），当前显示的是上一次成功的数据”；
  - 页面上有“更新记录”入口，查看 `/api/runs`。
- **只有 `capabilities.refresh === true` 时**才显示“刷新数据”按钮：
  1. 选择范围：全部，或 `/api/districts` 中的某个 District；
  2. 确认页：用 `/api/refresh/preview` 显示要处理和要跳过的 Station 及原因，并提示“只使用 dms:scrape-stations；不要用旧的单 Station 命令做正式刷新”；
  3. 用户确认后 POST，带上 `X-NC-Refresh: 1`。
  - 进度面板每 2 秒轮询 `/api/refresh/status`，显示：状态、开始时间、当前 District / Station、Station X / N、Route X / N、当前阶段、已完成 / 跳过 / 失败的 Station、最后错误（stop_reason）。
  - running 时按钮 disabled。
  - `needs_login` 时显示：“DMS 登录已过期，请在公用电脑打开终端执行 npm run dms:login，登录完成后重新刷新。”
- 所有文本都用 `textContent` 渲染，不引入外部资源，不使用 `innerHTML` 插入数据。

### 22.10 开机启动、日志与部署

- **启动脚本**：`scripts/services/start-services.ps1`：
  1. PostgreSQL 没在运行时，用 `pg_ctl start` 启动，然后用 `pg_isready` 等待最多 60 秒；
  2. 依次启动 Worker 和 Read-only Server 的守护循环。每个守护循环在子进程退出后按 5 秒、15 秒、60 秒逐级延长间隔，重新启动，并一直重试。
  - 日志写入 `%LOCALAPPDATA%\nc-ops-console\logs\{postgres,worker,readonly,services}.log`，按大小滚动。
- **Task Scheduler**：用 `scripts/services/register-tasks.ps1` 为当前用户注册任务 `NC Ops Console Services`。
  - 触发器为“当前用户登录时”，不需要管理员权限，运行时不弹出窗口。
  - 设置失败后自动重启，并禁止同时运行多个实例。
  - 说明：“开机但没有用户登录”的情况需要“开机时运行（不管用户是否登录）”，这需要管理员权限和保存的 Windows 密码，而且有界面的浏览器无法在没有登录的会话中运行。所以 MVP 采用“登录时启动”，并要求公用电脑设置自动登录或保持登录。见 CD-Q5。
- **防火墙**（需要管理员；由 Product Owner 在管理员 PowerShell 中执行 Claude 提供的命令）：只新增一条入站规则，**TCP 3000，Profile 为 Private,Domain**；不开放 3100 和 5432。
- **电脑睡眠**（只写进部署文档，不由代码修改）：屏幕可以关闭；插电时睡眠设为“从不”。
- **部署文档**：新增 `docs/deployment.md`，内容包括：架构、两个 env 文件、启动和停止、日志位置、Task Scheduler、防火墙、睡眠设置、`npm run dms:login`（必须在交互式终端中执行）、禁止用旧的单 Station 命令做正式刷新、`db:abandon-run` 的用法，以及 PostgreSQL 的手动启动方法。

### 22.11 P3 验收标准

- **CD-AC24** Worker 只监听 `127.0.0.1`；没有任何配置可以让它监听 0.0.0.0；启动日志中有 localhost-only。
- **CD-AC25** `GET /api/capabilities`：Worker 返回 true，Read-only Server 返回 false；Read-only Server 上没有 `POST /api/refresh`、`/api/refresh/*`，请求这些路径返回 404。
- **CD-AC26** Worker 的 Host / Origin / `X-NC-Refresh` / Content-Type / scope 检查：任何一项失败都返回 403 / 400，并且子进程启动次数为 0。
- **CD-AC27** 同时发两个刷新请求，第二个返回 409；锁文件能挡住“命令行 + Worker”同时运行；失效锁会被清除；DB 的唯一约束继续有效。
- **CD-AC28** `scrape_disabled` 的配置校验正确；`planRefresh` 对全部和单个 District 的结果正确；跳过的 Station 不会被切站；preview 显示原因；`/api/districts` 的输出不变。
- **CD-AC29** 进度文件和 `/api/refresh/status`：模拟 Worker 重启或页面刷新后，状态能恢复；`needs_login` 时 UI 显示约定的文案。
- **CD-AC30** `/api/freshness`、`/api/runs` 的字段符合第 22.7 节；不包含禁止返回的字段（用测试扫描响应中的 key）。
- **CD-AC31** Read-only Server 的保护：非 loopback 监听时，环境中有 scraper / owner / DMS 变量就拒绝启动，用有写权限的 DB 账号也拒绝启动；import 关系检查通过（第 22.2 节）。
- **CD-AC32** 前端：只有 Worker 显示刷新入口；范围选择、确认页、进度和错误文案正确；两个页面都有“非实时”提示和 Last Updated。
- **CD-AC33** Migration 002 可以在 001 之后执行，重复执行时跳过；P2 的权限测试全部继续通过。
- **CD-AC34** `npm test` 全部通过（P2 的 444 项不受影响），DB 测试没有被跳过；`git diff --check` 没有输出。
- **CD-AC35** 部署：Task Scheduler 任务已注册；注销并重新登录（或重启）后，PostgreSQL、Worker、Read-only Server 自动运行；防火墙只开放 3000（Private / Domain）。
- **CD-AC36** 真实验证：用 Worker UI 对一个小 Station 做一次正式刷新（不传 limited 参数）；JSON 和 DB 双写成功，DB 指针切换，进度显示正确，`DATA_SOURCE=db` 的页面立即读到新数据；用另一台电脑验证局域网只读访问（能看 Dashboard，没有刷新入口，3100 和 5432 连不上）。

### 22.12 Codex 任务拆分

| 任务 | 内容 | 验收 |
|---|---|---|
| CD-T5 | `scrape_disabled` 配置、`planRefresh`、批处理的 `--scope` / `--trigger` / `--progress-file`、锁文件、migration 002 | CD-AC27（锁文件部分）、CD-AC28、CD-AC33 |
| CD-T6 | Worker（接口、安全检查、互斥锁、子进程、状态）；Read-only Server 的 `LISTEN_HOST`、保护和 capabilities；`/api/freshness`、`/api/runs`；import 关系测试 | CD-AC24–27、CD-AC29–31 |
| CD-T7 | 前端：数据状态条、更新记录、刷新入口、范围选择、确认页、进度、登录过期提示 | CD-AC32 |
| CD-T8 | `scripts/services/*.ps1`、`docs/deployment.md` | CD-AC35（脚本部分） |
| （Claude） | `.env` / `readonly.env`、执行 migration 002、注册任务、提供防火墙命令、真实验证 | CD-AC35、CD-AC36 |

### 22.13 风险与技术债（P3）

- **R-P3-1** 这台电脑当前的 Wi-Fi 网络配置文件是 **Public**（2026-10-08 Claude 检查）。只对 Private / Domain 开放时，在 Public 网络下其他电脑访问不到。见 CD-Q6。
- **R-P3-2** repo 目前在 OneDrive 目录下（`Desktop\Norcal-dashboard`）。第 17 节要求公用电脑上的 repo 不放在同步目录中。如果本机就是公用电脑，以后应把 repo 迁到同步目录之外。见 CD-Q7。
- **R-P3-3** 每次刷新约有 40 个请求的固定开销（P2 实测）；刷新全部（17 个可抓取 Station）大约需要 10–20 分钟（含 Station 间隔）。
- **TD6** run 中有 Station 为 limited 时，run 仍记为 completed（这是现有行为）。Worker 不传 limited 参数，所以不会出现这种情况；暂时不改。
