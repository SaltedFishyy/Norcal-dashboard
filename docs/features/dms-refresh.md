# DMS Data Refresh（DMS 数据刷新）— Architecture / Spec

- Status: **Draft v3**（加入 Phase 1 登录方案和开发顺序调整；待 Product Owner 确认，**未授权实现**）
- 更新：2026-09-30
- 相关：`AGENTS.md` 第 4.4、13、14、15、16 节；`docs/data-schema.md` 第 8 节；`docs/open-questions.md`

---

## 0. 已确认的前提与决定

| # | 决定（Product Owner 2026-09-30） |
|---|---|
| 架构 | `nc-ops-console-main/` 是 prototype / legacy implementation，暂时保留作参考，不限制新架构。批准新增 `package.json`、`server/` 和新 frontend/backend 架构所需的永久依赖。不做无关的大规模重写。等新版本稳定并完成迁移后，再决定是否删除 legacy |
| 访问许可 | IT 已同意，前提是不影响 DMS 正常运行。使用 Product Owner 本人正常登录后的 session |
| 数据接口 | 目前没有 API。第一阶段用 Playwright。以后如果有正式 API、导出接口或只读数据库，优先迁移过去 |
| 范围 | 按 Station 刷新（例如 `SFO01`、`MFR01`，是 Station 不是 Route），抓取所选 Station 下的路区画像（route profile） |
| 历史 | 不做历史分析。只保存每个 Station 最新一次成功的 snapshot 和 Last Updated。**已被取代（Product Owner 2026-11-11）：** 被替换的 snapshot 全部保留，线路档案增加 7 / 30 天历史，见 `docs/features/route-history.md` |
| 使用者 | 第一阶段主要在本机使用，但架构不能写死成单用户；现在不做账号 / 权限系统，也不做复杂部署 |
| 频率 | 只在用户点击 “Refresh from DMS / 更新数据” 时运行。不定时刷新，不持续轮询 DMS。**已被修改（Product Owner 2026-11-11）：** 增加每天 17:00（America/Los_Angeles）一次全量自动刷新，见 `docs/features/auto-refresh.md`；仍不持续轮询 |
| 仓库 | `SaltedFishyy/Norcal-dashboard` 是 private，不开 public GitHub Pages。不再往旧仓库放内部数据。credentials、cookies、session、tokens 绝不提交 |
| 登录方案 | Phase 1 不做在线登录系统，也不做账号密码自动登录。用 Playwright storageState：第一次手动登录后保存 session state 到本地文件，之后 scraper 直接复用（第 5 节） |
| 开发顺序 | 先验证 scraper 链路，再接完整 frontend/backend（第 11 节）。第一阶段要证明这条链路稳定：手动登录一次 → 保存 session state → 选择 Station → 抓完整 Route Profile → 输出标准化 JSON |

---

## 1. 目标

用户在 dashboard 上选择一个或多个 Station，点击 “Refresh from DMS / 更新数据”，系统用 Product Owner 的 DMS 登录态**逐个 Station** 抓取路区画像，标准化后保存为最新 snapshot，页面显示这些数据和每个 Station 的 Last Updated。

---

## 2. 第一阶段数据范围

一行代表**一个 Station 下的一条 Route**（Route 级粒度）。

| 字段 | 内部字段名 | 说明 |
|---|---|---|
| Station | `station` | 如 `SFO01`，字符串 |
| Route ID | `route_id` | DMS `roadAreaId`，**Route 的稳定唯一标识（首选）**（D9，2026-09-30） |
| Route Name | `route_name` | 保留 DMS 原值；**不从中解析 Station** |
| DSP / Fleet Name | `dsp_name` | 保留 DMS 原值 |
| Pickup Volume | `pickup_volume` | **领件量**（DMS `receiptQty`），保留原值。不要叫 Daily Volume；统计窗口未知，不猜测（D6） |
| PPH | `pph` | DMS 原值，不自己计算、不补缺失值 |
| First-mile Distance | `first_mile_distance` | DMS 原值（`firstOrderMileage`），单位 mile |
| Address Type Distribution | `address_type_distribution` | DMS `receiveAddressType[]`：地址类型 → 占比 |
| Route Difficulty | `route_difficulty` | DMS 系统难易度 `roadAreaDifficulty`（另存 code）。**只存 DMS 提供的值，系统不自己计算**（`AGENTS.md` 第 13 节）。前端默认展示这个值（D4b） |
| Route Difficulty（人工） | `route_difficulty_manual` | DMS 人工难易度 `roadAreaDifficultyManual(Name)`，空值为 `null`（D4b） |
| Last Updated | `fetched_at`（Station 级） | 该 Station 本次成功抓取的时间。如果 DMS 页面上显示了数据截至时间，另存为 `source_as_of` |

规则：

- **Station / Route 关联：** `station` 取用户在 DMS 中选择并抓取时的真实 Station。即使 Route Name 形如 `SFO02-042`，也不通过字符串解析判断它属于哪个 Station。唯一标识首选 `route_id`（DMS `roadAreaId`，D9）；`station + route_name` 继续保存，用于展示和一致性校验，不再作为首选唯一标识。
- 缺失值存 `null`，不补值。
- 每个字段保留 DMS 原始文本（`raw` 字段）。数值解析失败时保留原文并标记，不猜测。
- 字段定义和单位确认后写入 `docs/data-schema.md` 第 8 节。

---

## 3. 现有实现复用（已检查）

| 内容 | 位置 | 复用方式 |
|---|---|---|
| Station 选择 chip 的交互和样式 | legacy `index.html`（`#station-chips`、`.chiplist`） | 新页面沿用同样的多选交互和视觉风格 |
| 视觉体系：字体、颜色变量、侧边栏布局 | legacy `index.html` `<style>` | 提取为新前端的共享 CSS，外观保持一致 |
| Route 面板的信息组织（按 Station 列出 Route、主要 DSP） | legacy `#route-panel` / `renderRoutePanel()` | 作为路区画像表格的参考 |
| 地图、ZIP → Route 的对应关系、ZIP 边界 | legacy `#mapdata`、`#zipgeo`、`#mapmain` | **第一阶段不用。** 第二阶段做“路区画像上地图”时复用 |
| Legacy 页面整体 | `nc-ops-console-main/` | 由新 server 以 `/legacy/` 路径原样提供，便于对照，不修改 |

记录（本 spec 不处理）：

- Legacy HTML 已内嵌 Station / DSP / ZIP 的 volume 和 price 数据。仓库是 private，按内部项目处理。
- Legacy 数据里 SFO01 下的 route 名是 `SFO02-042` 这类格式，与 Station 代码不一致。DMS 的 Route Name 能否和 legacy route 对应，第二阶段接地图前需要确认（D5）。

---

## 4. 架构

### 4.1 总览

```text
Product Owner 本机
┌───────────────────────────────────────────────────────────────┐
│ Browser: web/（新前端）   /legacy/（旧静态站，只读参考）       │
│        │ HTTP（只请求本地 server，不直接访问 DMS）             │
│        ▼                                                       │
│ server/（Node.js，默认只监听 127.0.0.1）                       │
│   api/        REST 接口                                        │
│   jobs/       刷新任务：lock、cooldown、按 Station 串行执行    │
│   dms/        Playwright collector + session 管理（只读）      │
│   transform/  DMS 原始数据 → 标准化行（纯函数，可测试）        │
│   store/      snapshot 存储接口（第一阶段用 JSON 文件实现）    │
└───────────────────────────────────────────────────────────────┘
        │ Playwright（一个浏览器、一个页面，串行）
        ▼
      GOFO DMS
```

### 4.2 目录

```text
Norcal-dashboard/
  package.json            新增（已批准）
  .env.example            配置项示例，只写占位值
  server/
    src/api/  src/jobs/  src/dms/  src/transform/  src/store/  src/config.js
    bin/                  命令行入口：dms-login、dms-scrape（T1–T5 阶段使用）
    test/                 使用 node:test（Node 自带，不另加测试框架）
    test/fixtures/        清理过的 DMS 页面样本（不含 cookie / token）
  web/                    新前端（T7）
  nc-ops-console-main/    legacy，保持不动
```

T1–T5 的 scraper 代码直接写在 `server/src/dms/`、`server/src/transform/`、`server/src/store/` 中，通过 `server/bin/` 的命令行脚本运行（如 `npm run dms:login`、`npm run dms:scrape -- --station SFO01`）。T6 的 backend API 复用同一批模块，不重写。

### 4.3 技术选择

| 项 | 选择 | 理由 |
|---|---|---|
| Runtime | Node.js（本机已有 v24，要求 ≥ 20） | 已批准；Playwright 官方支持 |
| HTTP | Node.js 内置 `http`（Product Owner 2026-10-01：优先内置模块，不新增 Express；需要新增永久依赖时先请示） | 不增加依赖；当前只读 API 足够 |
| 浏览器自动化 | Playwright（只装 Chromium） | 已批准 |
| 前端 | 原生 HTML / CSS / ES modules，由 server 直接提供，**不引入 bundler** | 功能简单，与 legacy 同一套技术，不需要构建步骤。以后复杂度上来（例如接入地图、多页面）再评估 Vite 等工具 |
| 测试 | `node:test` | 不增加依赖 |

### 4.4 为以后多人使用保留的空间（现在不实现）

Phase 1 只做本机单人使用。下面的分层和 store / session 抽象为多人使用保留了升级路径，但未来团队部署仍可能需要调整 authentication、session ownership、permissions、concurrency 和 deployment，这些现在都不提前实现。

- 所有 DMS 访问都走 `SessionProvider` 接口。第一阶段只有一个实现：读取本地 storageState 文件，标识为 `default`。以后可以按用户区分 session，或换成正式 API 凭据。
- `store/` 只暴露 `getLatest(station)` / `saveStationSnapshot(station, rows, meta)` 这类接口。以后换数据库只改实现，不改 API。
- Refresh lock 和 cooldown 是**全局的**（保护 DMS），不按用户区分。多人使用后仍是全局一把锁。
- 前端只通过 API 取数据，不假设 server 在本机，以后可以部署到内部主机。
- `HOST` 默认 `127.0.0.1`。改成对外监听需要先加认证，并做单独评审。

---

## 5. DMS Session 安全

Phase 1 方案：**Playwright storageState**。不做在线登录系统，不做账号密码自动登录。

1. **第一次运行（login bootstrap）：** `npm run dms:login` 启动一个**有界面**的 Playwright 浏览器，打开 DMS 登录页，由 Product Owner 手动登录（包括 SSO / MFA）。确认已登录后，把 storageState 保存到本地文件。
2. **后续抓取：** scraper 读取这个 storageState 文件创建浏览器上下文，复用已登录状态访问 DMS，不需要每次输入账号密码。
3. **不保存账号密码。** 代码、配置、`.env`、仓库中都没有 DMS 账号或密码。
4. **本地路径（D7 已决定：不允许被 OneDrive 同步）：**

   | 用途 | 默认路径（Windows） | 配置项 |
   |---|---|---|
   | Session | `%LOCALAPPDATA%\nc-ops-console\playwright\.auth\dms-state.json` | `DMS_STATE_PATH` |
   | Runtime data | `%LOCALAPPDATA%\nc-ops-console\runtime-data\` | `RUNTIME_DATA_DIR` |

   - 默认路径基于 `LOCALAPPDATA` 环境变量，可以通过配置覆盖。
   - 仓库内不创建任何实际的 session、cookie 或 runtime data 文件。
   - 启动时检查路径：**session 路径落在仓库内 → 直接拒绝运行**；runtime data 路径落在仓库内，或任一路径位于明显的同步目录（如路径中包含 `OneDrive`、`Dropbox`、`Google Drive`、`iCloud`）→ 输出 warning。
   - `.gitignore` 仍保留 `playwright/.auth/`、`runtime-data/`、`.env`、`*.storageState.json`，作为额外保护。
5. **storageState 是否足够保持登录，由 T1 实际验证**（保存 → 关闭 → 重新打开仍是登录状态）。如果不够，再与 Product Owner 讨论 persistent profile，现在不提前实现。
6. **过期处理：** 检测到跳转到登录页或登录失效时，立即停止，提示“请重新运行 dms:login”，**不自动重试、不猜测、不绕过登录**。
7. **Session 不外泄：** 日志、输出 JSON、失败记录、API 响应中都不能出现 cookie、token 或 storageState 内容。日志只记录 URL 的路径部分（去掉 query string）。
8. **只读：** scraper 只访问配置中白名单列出的 DMS 页面，不点击任何提交、保存、删除、派单类按钮。**例外：** Product Owner 2026-11-03 批准 scraper 点击语言下拉切换为中文。这可能会修改该账号在 DMS 的语言偏好；除此之外仍然只读。
9. **清除：** 删除 `dms-state.json` 即退出（T6 之后可在页面上提供 “Clear DMS session”）。

10. **界面语言：** DMS 必须是中文界面；检测到英文界面时，自动通过右上角语言下拉切换一次中文；切换失败才以 `DmsLanguageError` 停止。登录浏览器和 scraper context 使用 `zh-CN`，登录后直接按 Enter；英文界面由抓取流程自动切换（LANG2）。

`DMS_BASE_URL` 等 DMS 地址放在 `.env`，不写死在代码里。`.env.example` 只写占位值。

---

## 6. 刷新任务与 DMS 负载控制

T1–T5 阶段由 Product Owner 手动运行命令行抓取，视同“用户点击更新”。下面的保护措施（锁、串行、熔断、请求数上限）从 T3 / T5 起就生效，不等到接 backend 后才加。命令行阶段用文件锁（lock file）防止同时运行多个抓取；cooldown 同样生效，开发测试时可在 Product Owner 知情下调低。

### 6.1 流程（T6 / T7 接入 backend 后）

```text
用户选择 Station → 点击 Refresh
→ POST /api/refresh { stations: ["SFO01","MFR01"] }
   ├─ 正在运行 → 409 Conflict（附当前任务状态）
   ├─ cooldown 中 → 429（附剩余秒数）
   ├─ session 无效 → 409 needs_login
   └─ 接受 → 202 { jobId }
→ 任务按 Station 顺序逐个执行：打开 → 读取 → 标准化 → 保存该 Station 的 snapshot
→ Station 之间等待 stationDelay
→ 全部完成 → 记录结束时间，进入 cooldown
```

前端在任务进行中每几秒请求一次 `GET /api/refresh/status`，**请求的是本地 server，不是 DMS**，任务结束即停止。

### 6.2 保护措施（默认值都是技术参数，不是业务规则，全部可配置）

| 参数 | 默认值 | 说明 |
|---|---|---|
| `REFRESH_COOLDOWN_SECONDS` | 300 | 上一个任务结束后多久才能再次刷新（全局） |
| `STATION_DELAY_SECONDS` | 5 | Station 之间的间隔 |
| `MAX_STATIONS_PER_JOB` | 10 | 单次任务的 Station 上限 |
| `STATION_TIMEOUT_SECONDS` | 120 | 单个 Station 的超时时间 |
| `MAX_RETRIES_PER_STATION` | 0 | 默认不重试 |
| `MAX_PAGE_LOADS_PER_STATION` | 待 T2 摸底后设定 | 超过即停止，防止翻页或抓取失控 |

- **单任务锁：** 同一时间只能有一个刷新任务。锁在 server 内存中；server 重启后锁自然释放，但 cooldown 从上次任务结束时间计算（持久化）。
- **单浏览器、单页面、串行执行**，不并发。
- **熔断：** 遇到 DMS 返回 429 / 5xx、明显变慢或出现异常页面时，**停止整个任务**（剩余 Station 标记为 `skipped`），不继续冲击 DMS。
- **负载评估（满足“可能明显增加 DMS 负担时要停下来报告”）：**
  - T2 摸底时记录抓一个 Station 需要的页面加载 / 请求次数，交 Product Owner 确认后才写 collector。
  - **T2 是受控探索，不做大规模批量抓取。** 出现以下任一情况，立即停止扩大测试范围，先向 Product Owner 汇报，再决定 collector 方案：
    - 每个 Route 都需要单独打开 / 请求；
    - 单个 Station 的请求数量明显过多；
    - 存在复杂分页或 virtual scrolling，导致大量请求；
    - 实际抓取方式可能对 DMS 产生明显负载。
  - collector 运行时统计每个 Station 的请求数，超过 `MAX_PAGE_LOADS_PER_STATION` 就中止并报告。
  - 如果发现只能靠大量翻页或逐条点开 Route 才能拿到数据，Claude / Codex 停止，向 Product Owner 汇报。

### 6.3 部分成功

- 每个 Station 独立保存。成功的 Station 更新 snapshot 和 Last Updated；失败或跳过的 Station **保留上一次成功的数据**，并显示本次失败原因。
- 任务状态：`running` / `succeeded` / `partial` / `failed` / `needs_login`，每个 Station 也有自己的状态。

---

## 7. 数据存储（第一阶段）

Runtime 目录默认 `%LOCALAPPDATA%\nc-ops-console\runtime-data\`（可通过 `RUNTIME_DATA_DIR` 覆盖，见第 5 节）。T4 起输出标准化 JSON：

```text
runtime-data/
  route-profiles.json      每个 Station 最新一次成功的标准化 snapshot
  refresh-state.json       上次任务的结束时间（用于 cooldown）和各 Station 状态
  last-failure.json        最近一次失败的记录：时间、Station、步骤、错误信息（不含 cookie / token / 页面全文）
```

- 写文件用“先写临时文件再重命名”的方式，避免写到一半导致文件损坏。
- 不保存 raw 抓取历史。调试需要的原始页面样本只在 T2 / T3 开发时手动保存为测试 fixture（清理后放入 `server/test/fixtures/`）。
- `last-failure.json` 默认不保存截图（截图可能包含内部数据和账号信息）。需要时通过配置 `DEBUG_SCREENSHOT_ON_FAILURE=true` 临时打开，截图只存本地 runtime 目录。

`route-profiles.json` 结构：

```json
{
  "schema_version": 1,
  "stations": {
    "SFO01": {
      "fetched_at": "2026-09-30T18:20:00Z",
      "source_as_of": null,
      "source": "dms-playwright",
      "rows": [
        { "route_id": 0, "station": "SFO01", "route_name": "…", "dsp_name": "…",
          "pickup_volume": 0, "pph": 0, "first_mile_distance": 0,
          "address_type_distribution": [ { "type_code": "0", "type_name": "…", "share": 0.5 } ],
          "postal_codes": [ "94607", "94608" ],
          "route_difficulty": "…", "route_difficulty_code": "…",
          "route_difficulty_manual": null, "route_difficulty_manual_code": null,
          "raw": { }, "parse_errors": [ ] }
      ]
    }
  }
}
```

### 7.1 以后接 Database / Tableau

- 数据库阶段：`store/` 换成数据库实现，并新增历史表，例如 `route_profile_snapshots(station, route_name, fetched_at, …)`。保留策略到时候再设计。
- Tableau：第一阶段不做。之后可以从 store 导出 Route 级 CSV，或让 Tableau 直连数据库。粒度按 `docs/tableau.md` 要求，一行 = 一个 Station 在某次抓取中的一条 Route。
- 有正式 API 或只读数据库后，只替换 `dms/` collector，transform 之后的部分不变。

---

## 8. 前端（`web/`，T7）

第一阶段页面：**Route Profile（路区画像）**

- **Station 选择：** 多选 chip。Station 列表来自配置文件 `server/config/stations.json`（初始按 legacy 的 9 个 Station 填写，可编辑，见 D1）。
- **“Refresh from DMS / 更新数据” 按钮：**
  - 没选 Station、任务进行中、cooldown 中、需要登录时都禁用，并显示原因（如 “Refreshing SFO01 (1/2)…”、“Available in 3:20”）。
- **Session 状态：** Connected / Needs login（提示运行 `npm run dms:login`），以及 “Clear DMS session” 操作。
- **路区画像表格：** 按 Station 分组。每组标题显示 Station、**Last Updated**，失败时附上失败原因。列为第 2 节的字段。Address Type Distribution 用紧凑的比例条或文字显示。支持按列排序。
- **状态：**
  - 加载中
  - 从未刷新（空状态：“No data yet — select stations and refresh”）
  - 刷新中
  - 部分失败
  - server 不可达
  - needs_login
- **标注：** 页面明确显示数据来自 DMS snapshot，不是实时数据（`AGENTS.md` 第 15 节）。
- 页面上放一个到 `/legacy/` 的链接。

第二阶段（不在本 spec 内）：路区画像接入地图（依赖 D5）、legacy 功能逐步迁移。

**T7 已确认的最小页面（Product Owner 2026-10-01）：** 只读显示 SFO01，上面列出的其他内容留到 T7b。

- server 在 `GET /` 返回 `web/index.html`，静态资源只从 `web/` 中固定的白名单文件提供；现有两个 API 行为不变。
- 页头：标题 `North California Route Profile`、Station `SFO01`、Last Updated（来自 `fetched_at`）、Total Routes（来自 `total`），并注明数据是 DMS snapshot，不是实时数据（`AGENTS.md` 第 15 节）。
- 表格列：Route Name、DSP / Fleet、Pickup Volume、PPH、First-mile Distance（mi）、Route Difficulty、Manual Difficulty。按 API 返回顺序显示，不排序、不筛选。空值显示 `—`（普通文字，不加标签框）。数字格式（Product Owner 2026-10-01 预览后确认）：Pickup Volume 显示为整数（千分位），PPH 和 First-mile Distance 固定 2 位小数。表格行高约 32–36px，单行显示。难易度直接显示 `route_difficulty` / `route_difficulty_manual` 原值，不计算。
- 数据只来自 `GET /api/route-profiles?station=SFO01`，页面中没有写死的业务数据。
- 状态：Loading / 成功 / No data（`snapshot_not_found`、`station_not_found` 或 0 行）/ API error（其他错误码，以及 server 不可达）。错误只显示简洁说明和错误码，不显示 stack trace 或本地路径。
- 原生 HTML / CSS / ES modules，不加框架、bundler 或依赖。视觉参考 legacy，但不复制大段代码，也不修改 `nc-ops-console-main/`。
- 不做：多 Station、Refresh from DMS、POST API、地图、Tableau、登录 / 权限、Address Type Distribution 可视化、排序 / 筛选、数据编辑、`/legacy/` 静态服务。

---

## 9. API 草案（T6）

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/stations` | 可选 Station 列表 |
| GET | `/api/route-profiles?stations=SFO01,MFR01` | 最新 snapshot（含每个 Station 的 Last Updated 和状态） |
| POST | `/api/refresh` | 启动刷新，body `{ stations: [...] }`，返回 202 / 409 / 429 |
| GET | `/api/refresh/status` | 当前 / 上次任务状态、cooldown 剩余秒数 |
| GET | `/api/dms/session` | `connected` / `needs_login` / `unknown`（不返回任何 session 内容） |
| POST | `/api/dms/logout` | 删除本地 storageState 文件 |

Phase 1 登录仍通过命令行 `npm run dms:login` 完成，不提供在线登录接口。页面在 `needs_login` 时提示“请运行 dms:login”。

**T6 已确认的最小 API（Product Owner 2026-10-01）：** 只实现以下两个只读接口，表中其余接口留待后续任务。

| Method | Path | 成功 | 错误 |
|---|---|---|---|
| GET | `/api/health` | 200 `{ "ok": true }` | — |
| GET | `/api/route-profiles?station=SFO01` | 200 `{ station, fetched_at, source_as_of, total, rows }`（`rows` 结构沿用 T3 / `docs/data-schema.md` 第 8 节） | 400 `invalid_station`（缺少或格式非法）；404 `station_not_found`；404 `snapshot_not_found`（还没有 `route-profiles.json`）；500 `snapshot_invalid`（文件损坏或结构不合法） |

- 只监听 `127.0.0.1`，不提供 HOST 覆盖；端口默认 3000，可用 `PORT` 覆盖。
- 只读：不访问 DMS，不读 session，不启动浏览器，不修改 `route-profiles.json`。
- 不加 CORS 头；错误响应只有稳定错误码，不包含本地路径或 stack trace。

---

## 10. 待确认的细节

- **D1** Station 列表：第一阶段用配置文件（按 legacy 9 个 Station 初始化），还是从 DMS 读取？
- **D2** First-mile Distance 的单位和计算口径（DMS 页面上的定义）。→ T2：接口字段 `firstOrderMileage`，页面单位为 **mile**（列名“首单里程”）。
- **D3** Address Type Distribution 在 DMS 上的形式：有哪些类型？是占比还是数量？→ T2：**占比**（每个 Route 合计 1.0），共 10 种类型，见实现记录 T2。
- **D4** Route Difficulty 是 DMS 直接提供的字段吗？如果不是，第一阶段不显示，**不自行推算**。→ T2：**是**，`roadAreaDifficulty`（D / C / B / A / S 五级）。另有人工难易度字段，用哪个待 Product Owner 决定。
- **D5** DMS 的 Route Name 与 legacy route（例如 `SFO02-042`）能否对应？（第二阶段接地图时需要）
- **D6** Pickup Volume 的统计窗口（DMS 页面上显示的是哪段时间的领件量）？→ 仍未知（2026-09-30）。目前只确认 `receiptQty` = 页面“领件量”；不猜测，不称为 Daily Volume，保留原值，后续确认。
- **D7** ~~session 和 runtime data 放在仓库（OneDrive 同步目录）内？~~ **已决定（2026-09-30）：不接受。** 默认改到 `%LOCALAPPDATA%\nc-ops-console\`，见第 5 节。

D2、D3、D4、D6 由 T2 摸底时在 DMS 页面上确认，结果写入 `docs/data-schema.md`，不猜测。

---

## 11. 任务拆分（未授权）

先证明 scraper 链路稳定（T1–T5），再接 backend 和页面（T6–T7）。

| # | 任务 | 负责 | 依赖 |
|---|---|---|---|
| T1 | **Playwright session state / login bootstrap**：`package.json`、Playwright（Chromium）、config（`.env` / `.env.example`）、`.gitignore`（`playwright/.auth/`、`runtime-data/` 作为额外保护）、默认路径基于 `LOCALAPPDATA` 并做路径检查（第 5 节）、`npm run dms:login`（有界面的浏览器 → 手动登录 → 保存 storageState）、验证 storageState 能否保持登录 | Codex 实现，PO 本机运行验证 | — |
| T2 | **DMS「路区画像」页面摸底**（受控探索，停止条件见第 6.2 节）：PO 本人登录，和 Claude 一起确认页面路径、每个 Station 的请求次数、字段定义（D2–D4、D6），保存清理过的 fixture | PO + Claude | T1 |
| T3 | **单 Station scraper + 标准化输出**（Product Owner 2026-09-30 决定：原 T4 并入 T3）：只抓 SFO01；只读、白名单、请求计数、熔断、session 过期检测；transform（纯函数，fixture 单元测试）→ runtime data 目录下的 `route-profiles.json`（原子写）+ `last-failure.json` | Codex 实现，PO 本机运行验证 | T2 |
| T4 | （已并入 T3） | — | — |
| T5 | **多 Station 串行抓取**：`--station SFO01,MFR01`；串行、Station 间隔、文件锁、cooldown、部分成功保留旧数据 | Codex 实现，PO 本机运行验证 | T4 |
| T6 | **最小 Node backend API**（Product Owner 2026-10-01 收窄范围）：Node 内置 `http`、`127.0.0.1`、只读 `GET /api/health` 和 `GET /api/route-profiles?station=`（第 9 节 “T6 已确认的最小 API”）。`/legacy/` 静态页面、刷新接口、session 状态、进程内锁留到后续任务 | Codex | T3 |
| T7 | **最小只读前端**（Product Owner 2026-10-01 收窄范围）：`web/` 显示 SFO01 Route Profile，server 提供 `GET /` 和静态资源（第 8 节 “T7 已确认的最小页面”） | Codex，PO 预览签字 | T6 |
| T7b | **Dashboard Refresh button**（原 T7 其余部分）：多 Station chip、Refresh 按钮禁用 / 进度、session 状态、刷新中 / 部分失败 / needs_login 状态、按列排序、Address Type Distribution、`/legacy/` 链接与静态服务 | Codex，PO 预览签字 | T5、T7 |
| T8 | 以后再考虑：database、online auth、team deployment（不在本 spec 内） | — | — |

**T3 架构要求（Product Owner 2026-09-30）：** 页面控制和数据转换分开。
- Playwright 层（`server/src/dms/`）只负责：打开页面、执行最少必要的 UI 操作、等待并捕获 `queryList/pagination` 的响应，原样交给下一层。
- transform 层（`server/src/transform/`）单独负责：`records[]` 字段映射、类型转换、保留 raw 值、null / 解析错误处理。用 fixture 做单元测试。
- 字段解析逻辑不能写在 Playwright 页面控制代码里。

**多 Station（D8，2026-09-30）：** 现在不自动切换 DMS 页头的全局站点。T3 只做 SFO01。T3 稳定后再单独设计受控测试（记录原站点 → 切到 MFR01 → 验证 → 切回原站点），**Product Owner 明确授权前不执行**。T5 依赖这个结论。

每个任务完成后，文档同步更新（README 运行说明、`docs/data-schema.md` 字段定稿、`AGENTS.md` 第 4.3 节目录结构）。Codex 在沙箱里无法登录 DMS，所以 T1、T3、T5 都需要 Product Owner 在本机运行验证，T3 / T4 的测试依赖 T2 保存的 fixture。

---

## 12. 验收标准

**Scraper 链路（T1–T5）**

- **AC1** `npm run dms:login` 打开有界面的浏览器；手动登录后，storageState 保存到配置路径；再次运行 scraper 时不需要重新输入账号密码。
- **AC2** 仓库、`.env.example`、日志、输出 JSON、`last-failure.json` 中没有 DMS 账号、密码、cookie、token（grep 检查 + 代码审查）。
- **AC3** 默认 session 和 runtime data 路径位于 `%LOCALAPPDATA%\nc-ops-console\` 下，可通过配置覆盖；仓库内没有任何实际的 session / cookie / runtime 文件（`git status` 干净）；session 路径配置到仓库内时拒绝运行；runtime 路径在仓库内，或任一路径在同步目录中时，输出 warning；`.gitignore` 保留 `playwright/.auth/`、`runtime-data/` 规则。
- **AC4** Session 过期时立即停止，提示重新运行 `dms:login`，不自动重试或绕过登录。
- **AC5** 单 Station（SFO01）能抓到完整的 Route Profile，每个 Station 的请求数被记录，并且不超过 `MAX_PAGE_LOADS_PER_STATION`。
- **AC6** 输出的 `route-profiles.json` 符合第 7 节结构，包含第 2 节全部字段和每个 Station 的 `fetched_at`。
- **AC7** 多个 Station 按顺序逐个抓取，中间有间隔，不并发；同时启动第二个抓取会被文件锁拒绝（有测试证明）。
- **AC8** Station 部分失败时，成功的 Station 已更新，失败的 Station 保留旧数据，失败原因写入 `last-failure.json`。
- **AC9** 触发熔断条件（测试中模拟 429 / 5xx）时，剩余 Station 标记为 `skipped`。
- **AC10** 字段名使用 `pickup_volume`，任何地方都不出现 “Daily Volume”；`route_difficulty` 只来自 DMS 原值，代码中没有难度计算逻辑；`station` 不从 `route_name` 解析。
- **AC11** 所有保护参数都可以通过配置修改，默认值见第 6.2 节。
- **AC12** `npm test` 通过，至少覆盖 transform、锁 / cooldown、串行执行和部分成功。

**Backend + 页面（T6–T7）**

- **AC13** 运行 `npm start` 后，server 只监听 `127.0.0.1`；`/` 打开新页面，`/legacy/` 打开旧站，旧站功能与现在一致（`AGENTS.md` 第 10.1 节）。
- **AC14** 只有 POST `/api/refresh` 会触发 DMS 访问；server 启动、页面加载、状态查询都不会访问 DMS。
- **AC15** 任务进行中再次刷新返回 409；cooldown 中返回 429；前端按钮在这两种情况下都禁用并显示原因。
- **AC16** 页面显示每个 Station 的 Last Updated，并标明数据是 DMS snapshot；所有状态（加载、空、刷新中、部分失败、server 不可达、需要登录）都能看到。
- **AC17** UI 经 Product Owner 预览签字（`AGENTS.md` 第 9 节）。

---

## 13. 风险

- **DMS 改版**导致 scraper 失效：selector 集中管理，失败时写清楚失败在哪一步，保留旧数据。
- **Playwright 安装**：需要下载 Chromium，公司网络可能拦截。T1 时先在本机验证 `npx playwright install chromium`。
- **storageState 可能不够用**：storageState 只保存 cookie 和 localStorage。如果 DMS 把登录态放在 sessionStorage 或其他位置，恢复后可能仍是未登录状态。T1 需要验证“保存 → 关闭 → 重新打开仍已登录”；不行的话再讨论改用 persistent profile。
- **Session 文件本身就是登录凭据**：`dms-state.json` 中是明文 cookie，拿到文件的人等于拿到登录态。只保存在本机 OneDrive 外的默认路径，不复制、不上传。
- **负载**：如果 DMS 路区画像只能逐条 Route 点开，请求次数会随 Route 数线性增长（legacy 中 SFO01 有 51 条 route），需要在 T2 评估后决定是否可行。
- **字段口径**：Pickup Volume 与 legacy 的 volume 口径不同，两者不能直接比较或合并。

## 实现记录（Implementation Notes）

### LANG1 — DMS 界面语言保护（2026-11-03）

- 共用 `withPortraitPage` 在登录检查后、UI 操作前读取查询按钮 DOM，最多等待 2 秒；中文按钮存在则继续，仅发现名称以单词 `Search` 结尾（区分大小写，`/(^|\s)Search$/`，允许前置图标名称，如 `search Search`，不匹配单独的小写 `search`）时抛出 `DmsLanguageError`，两者都缺失则交还原有流程。单 Station、route-detail、批次和 global Station 模式共用该检查。
- 登录的两次 context 和 scraper context 使用 `zh-CN`。CLI、数据状态区及刷新进度弹窗显示切换中文并重新保存登录的提示；复用已有 API `stop_reason`，不增加响应字段，不修改 `needs_login` 判定。两个批次入口沿用原有阶段标记，记录为 `capture:DmsLanguageError`，通过 `safeStopReason` 校验。
- `npm.cmd test` 646/646 通过，专项测试 227/227 通过，`git diff --check` 通过；无 lint/build 配置。Chromium 使用临时 loopback HTTP 和纯合成 API 验证提示、进度弹窗及提示清除，无 console/page error 或外部请求。首次合成预览因测试服务漏提供 `difficulty.js` 超时，补齐后通过。
- 未访问 DMS、未读取真实 session/runtime 文件、未运行登录或抓取命令、未重启现有服务，未 commit/push/deploy。真实 DMS 验证与 Product Owner 预览签字待后续进行。

### LANG2 — 自动切换中文（2026-11-03）

- 新增 `language-switch.js`，保留 portrait-page 的 LANG1 re-export 和提示。英文时精确匹配可见 English trigger 及中文 / 简体中文菜单项，仅尝试一次，点击上限 2 秒。networkidle 超时容忍，中文查询按钮确认最多 30 秒；安全错误原样抛出，切换后重新检查登录。
- 仅在中文菜单点击派发前预留重载预算：open 列表上限 +1；已有全局 prod-api 上限 +25；batch 累计预算 +25（覆盖 open 重载开销，Station 自身 prod-api 预算不放宽）。无切换时预算不变。
- 未访问真实 DMS、session 或 runtime；选择器按 brief 推断，真实 DOM 和最终抓取结果待 Product Owner 验证。
- 检查：最终 `npm.cmd test` 672/672 通过，语言专项 24/24 通过，`git diff --check` 通过；无 lint/build 配置。纯合成 Chromium DOM 验证可见控件精确匹配、两次点击及中文确认，无 page error、无外部请求。首次合成检查受 PowerShell 中文管道编码影响失败，改用 Unicode 转义后通过。未重启服务，未 commit/push/deploy。

### T1 — 2026-09-30

- Product Owner 本次明确要求执行 `.handoff/briefs/T1-dms-login.md`，授权范围仅 T1；本文上方 Draft / 未授权标记不代表后续 T2–T8 已获授权。
- 新增 `package.json`、`package-lock.json`、`.env.example`；唯一直接永久依赖为 `playwright`（本次解析版本 1.63.0，其传递依赖为 `playwright-core` 1.63.0）。Node.js 要求 >=22.9，不使用 dotenv、Express 或测试框架。
- `server/src/config.js` 提供纯函数路径解析、仓库内拒绝、同步目录 warning 和 URL 校验；`server/bin/dms-login.js` 从脚本位置推导仓库根目录，与运行工作目录无关。相对 `DMS_STATE_PATH` 以仓库根目录解析。
- 默认 session 路径：Windows 有 `LOCALAPPDATA` 时使用 `%LOCALAPPDATA%\nc-ops-console\playwright\.auth\dms-state.json`；否则使用 `~/.nc-ops-console/playwright/.auth/dms-state.json`。配置覆盖必须位于仓库外；比较先规范化，Windows 不区分大小写。路径包含 OneDrive / Dropbox / Google Drive / iCloud 时 warning 后继续。
- `server/src/dms/session.js`：有界面 Chromium → 用户手动登录并按 Enter → storageState 写入仓库外的同目录临时文件后重命名 → 关闭浏览器 → 新浏览器复用 storageState → 用户回答 y/n。仅主动导航两次，不操作表单、不抓数据、不实现 persistent profile。浏览器正常加载页面所需的资源和手动登录产生的请求不属于额外自动化操作。
- Ctrl+C、关闭页面/浏览器或终端会取消流程并清理未完成临时文件；已完整保存的 session 不因取消或验证失败而删除。日志只输出 session 路径、origin + pathname、阶段和结果；不输出浏览器原始错误或 session 内容。
- 安装：`npm.cmd install`、`npx.cmd playwright install chromium` 已成功；Chromium（及其默认配套 headless shell / FFmpeg / Winldd）位于 `%LOCALAPPDATA%\ms-playwright`，未安装 Firefox / WebKit，也未安装到仓库。沙箱首次安装因 EACCES / EPERM 失败，经批准在沙箱外完成。
- 测试：`npm.cmd test`，25 项通过。`server/test/config.test.js` 覆盖路径及 URL；`session.test.js` 使用模拟浏览器/文件操作覆盖两次导航、y/n、取消清理和脱敏；`cli.test.js` 覆盖缺少 URL、仓库内路径拒绝、从其他工作目录启动及 warning。`server/test/index.js` 是简报指定 `node --test server/test/` 的目录入口（Node v24 不会直接发现该目录下的测试）。所有测试不访问 DMS、不写实际 session。
- 使用：复制 `.env.example` 为本地 `.env`，只配置 `DMS_BASE_URL` 和可选 `DMS_STATE_PATH`，然后从仓库根目录运行 `npm.cmd run dms:login`（PowerShell 执行策略允许时可用 `npm run dms:login`）。账号密码只在浏览器里手动输入。
- **本机验证（2026-09-30，Product Owner + Claude）：通过。** `npm run dms:login` 打开有界面的 Chromium → Product Owner 手动登录 → storageState 保存到 `%LOCALAPPDATA%\nc-ops-console\playwright\.auth\dms-state.json`（约 2.6 MB）→ 关闭浏览器 → 用 storageState 重新打开，Product Owner 确认仍是登录状态（y）→ 输出 “storageState 验证成功”，退出码 0。结论：Phase 1 用 storageState 足以保持登录，不需要 persistent profile。日志中没有 cookie / token；仓库内没有 session 或 runtime 文件。`DMS_BASE_URL` 配置为路区画像页（`/gofo-site/report/reportCenter/areaDepiction`）。
- 未配置 lint / build；legacy 页面未修改，本次未重复执行地图交互回归。无数据 schema / dataset 变化，未 commit / push / deploy。真实 DMS 登录和 storageState 保持验证待 Product Owner 本机完成，Codex 未尝试访问 DMS。

### T2 — DMS 路区画像页面摸底（2026-09-30，Claude 本机受控探索）

**执行方式：** 没有用 Mode A。原因是 Codex 沙箱不能联网，也读不到仓库外的 session 文件；spec 也把 T2 定为 PO + Claude。临时探索脚本放在 `.handoff/t2/`（gitignore），输出放在 `%LOCALAPPDATA%\nc-ops-console\t2-exploration\`（仓库外，含内部数据，仅本机）。

**访问量：**
- 共打开页面 4 次（1 次纯被动观察 + 3 次只读交互）。
- 只对 SFO01 点了 1 次“查询”。
- 没有切换页头全局站点，没有任何提交 / 保存 / 删除操作。
- 全程没有 429 / 5xx。
- storageState 每次都有效，没有跳到登录页。

#### 页面结构

- 路径 `/gofo-site/report/reportCenter/areaDepiction`，标签页“站点看板 | 路区画像”。Vue + Ant Design 微前端，class 前缀为 `dbuMicroSysApp-`。
- **筛选区：** 邮编、快递员工作区域名称、车队名称、筛选标签；点“展开”后还有“转运站点”“所属大区”。按钮：查询、重置。
- **表格：** vxe-table，有虚拟滚动和横向滚动。列：路区名称、转运站点、车队名称、是否新开、PPH、首单里程、收件地址类型、路区难易度、路区难易度（人工）、安全度、领件量、邮编数、分拣码、业务模式、操作（画像详情 / 路区详情）。
- **分页：** vxe-pager，默认 10 条/页，可选 10 / 20 / 30 / 50 / 100 / 200 / 500。SFO01 共 51 条。
- **Station 的作用范围：** 由**页头全局站点切换器**（右上角 “SFO01 ∨”）决定。页面内“转运站点”下拉只列出当前全局站点（SFO01）。列表接口默认不带 Station 参数，也只返回当前全局站点的数据。

#### 数据来源：接口响应（不是 DOM）

| 接口 | 用途 | 说明 |
|---|---|---|
| `POST /prod-api/dlvs-dataApi/roadAreaPortrait/home/frontPage/queryList/pagination` | 路区画像列表 | 请求体 `{pageNum, pageSize, siteHandleType:"ALL", transitStationCodeList:[<站点内部 ID>], pageType:""}`；返回 `data.records[]` + `total/pages/current/size`。**一条 record = 一个 Route，Phase 1 字段全部在内** |
| `POST /prod-api/dlvs-dataApi/siteOffline/regionalSiteDropdownBox` | 站点下拉数据 | 请求体 `{groupType:[4,5]}`；按大区返回站点列表（`groupName` 是站点代码，`id` 是内部 ID） |

- 鉴权方式：请求头 `authorization` 加 `auth-tag-x`，来自 storageState 中的 localStorage。没有专门表示站点的请求头。
- 不需要逐条 Route 请求。“画像详情 / 路区详情”是按需打开的弹窗，Phase 1 字段不需要它们。

#### 字段映射（Phase 1）

| Phase 1 字段 | 接口字段 | 页面列 | 说明 |
|---|---|---|---|
| Station | `transitStationName` | 转运站点 | 以抓取时选择的 Station 为准，并校验与该字段一致；不从 Route Name 解析 |
| Route Name | `roadAreaName` | 路区名称 | 如 `SFO01-001` |
| （Route ID） | `roadAreaId` | — | 数字，样本内唯一，可作为稳定 route ID（见待决定问题） |
| DSP / Fleet Name | `fleetName` | 车队名称 | 如 `SFO-AAS` |
| Pickup Volume | `receiptQty` | 领件量 | 统计窗口未确认（D6） |
| PPH | `actualPph` | PPH（件/h） | 另有 `pphP25/P50/P75`、`pphDelta`、环比字段，Phase 1 不用 |
| First-mile Distance | `firstOrderMileage` | 首单里程 | 页面单位显示为 **mile** |
| Address Type Distribution | `receiveAddressType[]` | 收件地址类型 | `{typeCode, typeName, typeValue}`。`typeValue` 是**占比**，样本中每个 Route 合计为 1.000。类型：0 独栋住宅/别墅、1 工业园区/仓库、2 公寓、4 农场、5 商业、6 学校、7 医院、8 政府机构、9 其它、10 未知 |
| Route Difficulty | `roadAreaDifficulty` + `roadAreaDifficultyCode` | 路区难易度 | DMS 直接提供：0 D级 极易、1 C级 易、2 B级 中、3 A级 难、4 S级 极难。另有人工字段 `roadAreaDifficultyManual(Name)`，样本中全为 null |
| Last Updated | （抓取时间） | — | 列表中没有数据截至时间，`source_as_of` 暂为 null |

样本（SFO01 前 10 条）中上述字段都没有 null。

#### 请求数量与加载机制（单个 Station）

- **打开页面一次**会触发应用启动请求：`/prod-api/` 接口约 20 个，包括约 1.2 MB 的 `lookupItem/findAllLookupItem` 和约 600 KB 的 `i18n`，另有大量静态资源。**这部分开销按“每次刷新任务打开一次页面”计算，不按 Station 计算。**
- 列表数据：页面加载时有 1 次默认请求（10 条）。通过页面把条数调到 100 并查询，**1 次请求即可拿到 SFO01 全部 51 条**。
- 没有逐 Route 请求，没有懒加载，也没有“展开后加载”。分页很简单（`total` / `pages`），不属于复杂分页。
- 表格 DOM 有虚拟滚动和横向滚动，单元格是格式化后的文本（如“21.37件/h”“24.58mile”）。**DOM 抓取不可靠**。

#### 推荐 T3 方案：页面驱动 + 截获接口响应（network）

- 用 storageState 打开页面，通过页面 UI 选择“转运站点”并把每页条数调到 100 / 200，点“查询”，用 `page.waitForResponse` 截获列表接口的 JSON 并解析。
- 不自己拼接口请求、不处理鉴权头，所有请求都和人工操作页面完全一样。
- 如果 `total` 大于每页条数，按页面翻页（预计不会发生）。
- 不解析 DOM。DOM 只用于定位筛选控件（`.dbuMicroSysApp-form-item` + 标签文本、`.vxe-pager--sizes`）。
- `MAX_PAGE_LOADS_PER_STATION` 建议默认 3（含默认加载的 1 次请求）。

#### 停止条件检查

没有触发任何一项：不需要逐 Route 请求，单个 Station 请求很少，没有复杂分页或虚拟滚动带来的额外请求，没有观察到明显负载风险。唯一较重的是页面启动请求，见上方说明。

### T3 — SFO01 单 Station scraper（2026-09-30）

- Product Owner 明确授权执行 `.handoff/briefs/T3-sfo01-scraper.md`；本次只实现 T3，未实现多 Station、页头全局站点切换、lock / cooldown、API、前端或数据库。保留原有 T1 / T2 记录及需求、验收标准。
- 新增 `server/src/dms/route-profile-page.js`：复用 storageState 打开路区画像页面，通过 T2 已确认的控件选择 SFO01、100 条/页并查询，捕获 POST 列表响应并原样返回。页面层不映射数据字段；统计全部请求及 roadAreaPortrait 请求，默认上限 3，遇到登录失效、控件不可用、超限或 `/prod-api/` 429 / 5xx 即停止并关闭浏览器，不重试。
- 新增 `server/src/transform/route-profile.js`：无 I/O、无 Playwright 依赖的纯函数；验证响应结构、Station、必需字段、整数且唯一的 route_id 和分页完整性。映射标准行、保留规定来源字段的 raw 值及 parse_errors，单独保存系统 / 人工难易度，不计算运营指标或分类。total 超出当前 records 数量时拒绝，T3 不翻页。
- 新增 `server/src/store/route-profiles-file.js`：读写 schema_version 为 1 的 route-profiles.json，仅更新本次 Station 并保留其他 Station；使用同目录临时文件 + rename 原子更新。CLI 失败时写 last-failure.json，仅保存固定说明、阶段、错误类型和时间；不写浏览器原始错误、响应内容或 URL，失败不改旧 snapshot。
- 扩展 `server/src/config.js` / `.env.example`：RUNTIME_DATA_DIR 默认 Windows LOCALAPPDATA 下的 nc-ops-console/runtime-data，无 LOCALAPPDATA 时回退到用户目录；覆盖路径以仓库根目录解析，仓库内及同步目录输出 warning。MAX_PAGE_LOADS_PER_STATION 留空默认 3，要求正整数。T1 session 路径规则和登录行为保持不变。
- 新增 `server/bin/dms-scrape.js` 和 package.json 的 dms:scrape script。本机使用：`npm.cmd run dms:scrape -- --station SFO01`；可追加 `--headless`，默认有界面。其他 Station、缺少 session 或无效配置在加载浏览器前退出。成功摘要包括 Station、行数、total、list 请求数、输出路径、parse_errors 数量。
- 新增合成 fixture `server/test/fixtures/route-portrait-pagination.json`（复制 brief 指定样本）与 `server/test/t3.test.js`，接入现有测试入口。`npm.cmd test` 离线通过 **70 项**（T1 原有 25 项 + T3 新增 45 项）。覆盖字段 / raw / manual 映射、数字转换、schema 拒绝、空数据、存储原子性与失败保留、配置 warning、页面 mock 的登录 / 超限 / 熔断、CLI mock 全链路及真实 CLI 进程的提前拒绝。
- 未安装依赖、未联网、未读取或写入真实 session、未运行真实 dms:login / dms:scrape。未配置 lint / build；legacy 页面未修改，未重复执行地图及 analytics 浏览器回归。真实 DMS 抓取及 UI selector 验证待 Claude / Product Owner 本机完成；离线测试不能代替真实验证。未 commit / push / deploy。
- **第 1 轮修复（Claude review 后）：** 失败时 CLI 输出并在 `last-failure.json.detail` 中记录模块生成的具体原因；响应捕获要求请求体包含 `transitStationCodeList` 数组且 `pageSize` 匹配，避免误拿“每页条数”切换触发的响应。`npm test` 75/75 通过。
- **本机真实验证（2026-09-30，Claude 在 Product Owner 本机运行 `npm run dms:scrape -- --station SFO01`）：通过。**
  - 流程：打开 → 展开 → 转运站点 → 每页条数 → 查询，与 T2 记录的 selector 一致。
  - 结果：输出 51 行，`total` = 51；`parse_errors` = 0；`route_id` 51 个全部唯一；所有行的 `station` 都是 SFO01。
  - 字段：除 `route_difficulty_manual` 外，其余字段都没有 null；`route_difficulty_manual` 51 行全为 null，与 T2 样本一致。地址类型占比每行合计 1.000。难易度分布涵盖 D / C / B / A / S 五级。
  - 请求：列表请求共 3 次（页面加载 1 次 + 切换每页条数 1 次 + 查询 1 次），**刚好等于默认上限 3**。没有 429 / 5xx。
  - 输出位置：`%LOCALAPPDATA%\nc-ops-console\runtime-data\route-profiles.json`（约 175 KB，在仓库外）。仓库内没有出现 runtime 或 session 文件。

### T6 — 最小只读 Backend API（2026-10-01）

- 扩展 `server/src/store/route-profiles-file.js`：新增 `getStationSnapshot` 和三个固定名称的读取错误类，校验 schema_version、stations 和被请求 Station 的必需字段；读取失败只输出固定说明，不改变既有写入行为。
- 新增 `server/src/api/app.js`、`http-utils.js`、`server.js`：使用 Node 内置 HTTP，提供 `GET /api/health` 和 `GET /api/route-profiles?station=SFO01`；返回原有 rows（含 raw、parse_errors），统一 JSON / no-store / nosniff 响应头，不设置 CORS。错误体只含 error；请求日志只记录状态码。
- 新增 `server/bin/server.js` 和 package.json 的 server script：本机运行 `npm.cmd run server`，默认端口 3000，支持 PORT（1–65535），固定监听 127.0.0.1。复用 runtime 配置及 warning；CLI 启动摘要按任务要求显示地址与 runtime 路径，启动失败不输出 stack。未新增依赖，package-lock.json 未修改。
- 新增 `server/test/t6.test.js` 并接入 `server/test/index.js`。`npm.cmd test` 离线 **85/85 通过**（原有 T1 / T3 75 项 + T6 10 项），使用临时目录和合成 mock snapshot，覆盖成功响应、参数和 schema 错误、错误脱敏、方法限制、响应头、loopback 监听、文件内容 / mtime 不变、CLI 端口校验及占用、默认 / 覆盖配置、import 链无 DMS / Playwright。
- 未配置 lint / build；未联网、未读取真实 runtime data 或 session、未启动浏览器，未修改 legacy 或执行其浏览器回归。未实现前端、refresh、session、legacy 静态服务或数据库；未 commit / push / deploy。
- **本机真实验证（2026-10-01，Claude 在 Product Owner 本机运行 `npm run server`）：通过。**
  - 启动：只监听 `127.0.0.1:3000`（netstat 确认，不是 0.0.0.0）。
  - 健康检查：`GET /api/health` 返回 200 `{"ok":true}`，响应头包含 `no-store` 和 `nosniff`。
  - 数据接口：`GET /api/route-profiles?station=SFO01` 返回 200，内容与 T3 真实 snapshot 一致：`station` = SFO01，有 `fetched_at`，`source_as_of` 为 null，`total` = 51，`rows` 共 51 行（每行 14 个字段）。
  - 错误码：缺少参数或参数为空、非法字符、重复参数 → 400 `invalid_station`；`MFR01` → 404 `station_not_found`；POST → 405；未知路径 → 404 `not_found`。错误响应只包含错误码。
  - 带 `Origin` 请求头访问时，响应中没有 `Access-Control-*` 头。
  - 只读：请求前后 `route-profiles.json` 的修改时间不变。
  - 验证结束后已停止 server。

### T7 — 最小只读前端（2026-10-01）

- 新增 `web/index.html`、`styles.css`、`app.js`、`format.js`：原生 ES modules，同源 GET `/api/route-profiles?station=SFO01`；显示七列及 API 的 total / fetched_at，保持 rows 顺序。Last Updated 使用浏览器本地时间、分钟和时区，title 保存完整来源时间。空值显示 `—`，难易度只显示原值；沿用 legacy 深色 / teal 视觉参考，窄屏表格独立横向滚动。
- `format.js` 提供格式化及 Loading / success / empty / error 状态纯函数；错误码仅展示已知稳定值，未知错误归为 internal_error，不展示响应文本或异常详情。Retry 只重新 GET，不自动重试。所有 API 值通过 textContent 渲染，无外部资源、inline script 或 inline style。
- 新增 `server/src/api/static-files.js`：固定四个路径对应四个文件，通过 createStaticReader 注入 handler；createApiServer / startApiServer 支持覆盖 webDir，默认仓库根 web/。静态路径按原始请求路径匹配，避免 URL dot-segment normalization 绕过白名单；GET 之外返回 405 / Allow: GET，读取失败返回固定 internal_error。静态响应设置 no-store、nosniff、CSP；现有 API 响应头及行为保持不变，请求日志仍只记录状态码。
- 新增 `server/test/t7.test.js` 并接入测试入口。`npm.cmd test` **95/95 通过**（原有 85 项 + T7 10 项），原有 T6 测试未修改。覆盖静态文件原文、响应头、原始路径穿越、方法限制、webDir 覆盖、注入与读取失败脱敏、格式化、状态映射，以及用最小 DOM doubles 验证实际 app 的行顺序、HTML 字符串作为文本、空值、时间 title、Retry、网络及 JSON 解析失败。
- package.json / package-lock.json、legacy、数据 schema 及真实 runtime 文件未改；未新增依赖。未配置 lint / build，`git diff --check` 通过。测试只使用临时目录及合成数据 / doubles，未访问 DMS、真实 session / runtime data，未启动浏览器，未 commit / push / deploy。
- 本机真实数据、浏览器 console、CSP 执行及宽 / 窄屏视觉验收待 Claude / Product Owner：运行 `npm run server` 后打开 `http://127.0.0.1:3000/`。离线检查不替代 Product Owner 的预览签字。
- **本机真实验证（2026-10-01，Claude 在 Product Owner 本机运行 `npm run server`）：功能通过，UI 待 Product Owner 预览签字。**
  - server 只监听 `127.0.0.1:3000`（netstat 确认）。`/`、`/styles.css`、`/app.js`、`/format.js` 返回 200，Content-Type 正确，带 CSP / no-store / nosniff；`/index.html`、`/../package.json`、`/%2e%2e/package.json` 返回 404；`/api/health` 仍为 200。
  - `GET /api/route-profiles?station=SFO01`：total = 51，rows 51 行，与 T3 真实 snapshot 的 rows 和 `fetched_at` 完全一致；`source_as_of` 为 null。
  - 无界面 Chromium（1440 宽和 390 宽）：页头显示 SFO01 / Last Updated `2026-09-30 17:46 PDT`（title 为完整 ISO 时间）/ Total Routes 51，表格 51 行、7 列，Manual Difficulty 全部显示 `—`；console 没有 error / warning；页面只发出 5 个同源 GET 请求（页面、3 个静态文件、1 个 API），没有外部请求；窄屏时只有表格区域横向滚动，页面本身不横向滚动。
- **第 1 轮修复（2026-10-01，Product Owner 预览后）：** 仅修改 web/styles.css、web/app.js、web/format.js 和 server/test/t7.test.js。单元格保留 13px 字号，使用 20px line-height、上下 6px padding 和 nowrap，数据行约 33px；难易度标签缩小为 20px 高，保留表格独立横向滚动。两列难易度的 null / undefined / 空字符串只渲染普通 `—`，非空值继续用 textContent 原样显示标签。Pickup Volume 使用千分位整数，PPH / First-mile Distance 固定 2 位小数，空值及非有限数字仍显示 `—`，仅改变显示格式。补充纯函数与实际 app DOM doubles 测试，覆盖数字格式、两列空值不生成标签、非空标签及跨 Station 名称原样显示；`npm.cmd test` **96/96 通过**。未配置 lint / build；未修改 server 实现、API、静态路由、package 文件、legacy 或真实数据，未访问 DMS / session、未启动浏览器，未 commit / push / deploy。本轮宽 / 窄屏视觉效果与 console 检查待 Claude / Product Owner 本机预览确认。

### LANG3 — 提示文案（2026-11-11）

- 更新登录说明及 session 验证问题：登录后直接按 Enter，英文界面由 LANG2 自动切换；验证问题仅询问登录状态。CLI 和看板使用一致的自动切换失败提示，说明手动切换、重新刷新及仍失败时重新登录的步骤。
- 同步 session、data-status、multi-station-batch 和 rd1 的文案断言；不修改语言切换、y/n 处理、抓取或刷新逻辑。
- 检查：`node --test server/test/` 共 825 项，767 通过、56 跳过、2 失败；失败为 CD-AC30 / CD-AC31，均因未配置 `NC_TEST_DB_*`。session、language-switch、data-status、multi-station-batch、rd1 专项测试 159/159 通过。`git diff --check` 通过（仅有既有工作区文件的 LF/CRLF 提示）；无 lint / build 配置。
- 未读取 .env 或真实 session/runtime 文件，未访问 DMS，未运行登录或抓取，未重启服务，未 commit / push / deploy。未进行真实浏览器预览，待 Product Owner 确认提示显示。
