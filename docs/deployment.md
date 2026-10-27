# 公用电脑部署与维护

对应 [Central DB spec](features/central-db.md) 第 21.2、22.1、22.10 节。本文提供 review 后由 Claude 或 Product Owner 执行的步骤；CD-T8 仅交付脚本与文档，没有执行部署。所有 PowerShell 命令在仓库根目录运行，使用当前登录的部署用户。需要 Windows PowerShell 5.1、Node.js >=22.9 和现有 npm 依赖。

## 架构与访问

### 2026-10-27 局域网启动记录

- Product Owner 明确要求允许其他电脑访问。已验证现有仓库外 `readonly.env` 只含允许的只读配置、使用 DB reader，且 reader 写入及 Warehouse 隔离权限检查通过；未显示或修改凭据。
- 办公 Wi-Fi `<office Wi-Fi>` 已为 Private，已有 `NC Ops Console Read-only 3000` 入站规则放行 TCP 3000（Private / Domain）。本次未修改网络类别或防火墙。
- 停止原先仅监听 loopback 的手动 3000 服务，使用现有 `scripts/services/run-service.ps1 -Name readonly` 启动只读守护。实际监听 `0.0.0.0:3000`；Worker 仍为 `127.0.0.1:3100`，PostgreSQL 仍为 loopback。本次未注册或修改登录任务。
- 当前地址为 `http://<LAN-IP>:3000/`（DHCP 地址可能变化）。本机通过该局域网地址检查 health、capabilities 和线路画像接口均返回 200；capabilities 为 `refresh: false, warehouse_write: false`。本机 Worker 仍保留管理能力。尚未从第二台电脑实测连通性。
- 未改业务数据或产品代码，未运行 DMS，未 commit / push。服务配置切换通过实际监听/API检查验证，未重复运行自动测试。

```text
公用电脑（当前用户已登录）
Task Scheduler → start-services.ps1（每 60 秒检查）
  ├─ PostgreSQL             localhost:5432
  ├─ run-service worker  → Worker             127.0.0.1:3100（刷新、仓库管理）
  └─ run-service readonly → Read-only Server  0.0.0.0:3000（局域网配置）
其他电脑 → http://<公用电脑名>:3000 → Dashboard / 只读 API / 仓库查看
Worker → DMS 抓取 → JSON + PostgreSQL
Read-only Server → PostgreSQL reader 视图（只读）
```

PostgreSQL 和 Worker 只接受本机连接。其他电脑只访问 `http://<公用电脑名>:3000`，不能触发刷新。只有公用电脑本机通过 3100 管理仓库，其他电脑通过 3000 只读查看。本机刷新入口是 `http://127.0.0.1:3100`。脚本的端口占用检查采用部署约定的 3100 / 3000；修改端口前必须同步调整脚本、防火墙和访问地址。

## 配置与本机目录

统一基目录为 `%LOCALAPPDATA%\nc-ops-console`，由当前部署用户拥有：

| 路径 | 用途 |
|---|---|
| `pgsql\bin` | `pg_ctl.exe`、`pg_isready.exe` |
| `pgdata` | PostgreSQL 数据目录 |
| `config\readonly.env` | 只读服务配置，仓库外 |
| `runtime-data` | 默认 JSON、进度和 `scrape.lock`；可被 `RUNTIME_DATA_DIR` 覆盖 |
| `logs` | 服务与 PostgreSQL 日志 |
| `playwright\.auth` | 既有本机 DMS 登录态，不复制到仓库或其他电脑 |

两个 env 文件有不同用途，下表只列变量名，不提供或复制任何凭据值：

| 配置 | 变量名与用途 |
|---|---|
| repo 根目录 `.env` | Worker / 抓取：`DATA_SOURCE`、`DB_DUAL_WRITE`、`NC_DB_SCRAPER_URL`、`NC_DB_READER_URL`、`NC_DB_WAREHOUSE_URL`、`DMS_BASE_URL`、`DMS_STATE_PATH`；人工 migration 使用 `NC_DB_OWNER_URL`；可选 `RUNTIME_DATA_DIR`、`WORKER_PORT`。测试使用 `NC_TEST_DB_OWNER_URL`、`NC_TEST_DB_SCRAPER_URL`、`NC_TEST_DB_READER_URL`。 |
| 仓库外 `readonly.env` | `DATA_SOURCE`、`NC_DB_READER_URL`、`LISTEN_HOST`、`PORT`，可选 `RUNTIME_DATA_DIR`。只有 reader 只读视图；不得放入 warehouse 凭据，局域网模式会拒绝启动。没有 owner、scraper 或 DMS 配置。 |

配置按 spec 第 22.1 节设为 DB 数据源和双写，局域网只读监听采用架构图地址。只读启动命令显式使用 `--env-file=<readonly.env>`，不读取 repo `.env`。不要用 `npm run server` 替代局域网启动命令，它会加载 repo `.env`。只读子进程还清除继承的 DB / DMS 配置及 `NODE_OPTIONS`，使独立 env 文件成为配置来源。配置文件及 secrets 目录权限只授予当前部署用户，不放入同步目录。

## 首次部署顺序

仓库管理升级顺序：先用 `nc_admin` 创建 warehouse 角色（见 [Warehouse spec 第 13 节 T0](features/warehouses.md#13-实现记录)），再由获批的部署操作执行 migration 003，然后重启服务。T2 实现不执行这些部署动作。Worker 的 `.env` 可配置 `NC_DB_WAREHOUSE_URL`，测试使用 `NC_TEST_DB_WAREHOUSE_URL`，只给 Worker（3100）使用，不放进 readonly.env。3100 固定只允许 loopback Host。

启动检查分级：3100 的 warehouse 权限检查通过且使用 DB 数据源时开启写入；只有 `missing_warehouse_privilege`（表或视图不存在、授权不足）或连接失败时，记录一行日志并关闭写入，服务正常启动；任何权限过大问题拒绝启动，只输出一行中文原因。3000 LAN 的 reader 隔离检查在既有 `canWriteRuns` 检查之后执行：只有缺少 warehouse 权限时仍启动（视图未就绪时仓库 GET 返回 503），权限过大时拒绝启动。3000 局域网模式下出现 warehouse 凭据时拒绝启动；本机模式忽略该凭据。

隐私说明（D13）：新增仓库或修改地址时，仓库的商业地址会通过 HTTPS 发送给 US Census Geocoder（`geocoding.geo.census.gov`）用于地址转坐标。不发送名称、District、Station 或其他数据，不需要 API key。只有在 3100 管理流程中才会调用。手动坐标不调用 Census。服务日志不记录地址、名称或 Census 内容。

1. 安装并初始化 PostgreSQL，按 spec [第 21.2 节](features/central-db.md#212-环境claude-已于-2026-10-07-在本机完成) 设置数据目录、localhost 监听、角色与权限。该电脑此前已完成安装；先确认已有实例，不能重新初始化或覆盖 `pgdata`。数据库应先手动启动，方法见下文。
2. 确认上文 T0 warehouse 角色准备完成后，在仓库根目录执行 `npm run db:migrate`，依次应用 migration 001 / 002 / 003，已执行版本自动跳过。
3. **只在首次导入**执行 `npm run db:import-json`。数据库已有 snapshot / detail 时不要重复导入；该命令不会覆盖已有数据。
4. 由 Claude 创建仓库外 `readonly.env`，按照上表配置 reader；检查本地 `.env` 的 Worker 双写配置。不要在聊天、日志或截图中显示文件内容。

   如果用 `icacls /inheritance:r` 收紧 config 目录权限，必须确认 `readonly.env` **文件本身**仍有当前部署用户的读权限。可用 `icacls "<文件路径>"` 查看文件 ACL（不会显示文件内容）；目录权限正确不代表文件权限正确。文件 ACL 为空或当前用户没有读权限时，Node 可能报 `readonly.env: not found`。
5. 当前用户普通 PowerShell 执行下列注册命令。任务仅注册，不会立即启动；review 后可在 Task Scheduler 手动运行，或等待下一次该用户登录。

   ```powershell
   .\scripts\services\register-tasks.ps1
   ```

   脚本用 `Get-Command node` 保存 Node 绝对路径。任务名为 `NC Ops Console Services`，当前用户登录触发，`Interactive` / `Limited`，隐藏窗口，不需要保存 Windows 密码或管理员权限。现有同名任务先显示配置，再覆盖；其他用户的任务拒绝覆盖。配置为忽略重复实例、失败后每分钟重启（最多 999 次）、无执行时间限制、允许电池运行、可用时启动。权限失败时明确报错，不尝试提权。Node 安装位置或 repo 移动后需重新注册。
6. 管理员 PowerShell 添加下述防火墙规则。
7. 只对可信办公网络设置 Private，方法见下文。
8. Product Owner 手动设置插电时不睡眠。
9. Product Owner 通过 Windows 管理方式设置自动登录或一直保持当前用户登录。**开机但无人登录不会启动服务**；锁屏可以保持会话，注销会使交互式会话不可用。无用户登录的启动方案需要管理员权限和保存的 Windows 密码，且有界面浏览器不能在未登录会话运行，所以 MVP 使用登录触发。脚本不设置自动登录，也不保存 Windows 密码。

## 防火墙、网络与电源

只在管理员 PowerShell 中新增以下入站规则：

```powershell
New-NetFirewallRule -DisplayName 'NC Ops Console Read-only 3000' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -Profile Private,Domain
```

不要开放 3100 或 5432。检查是否已有过宽的 Node 入站规则，避免其他规则允许 Public 网络。若 Windows 弹出“是否允许 node.exe 访问网络”，**只勾选专用网络**。

R-P3-1：2026-10-08 检查时办公 Wi-Fi 是 Public，这会使上述规则不生效。Product Owner 已决定改为 Private。先查看接口名称，再在管理员 PowerShell 中执行（替换占位符）：

```powershell
Get-NetConnectionProfile
Set-NetConnectionProfile -InterfaceAlias '<名称>' -NetworkCategory Private
```

只能对可信办公网络这样设置，不要对公共 Wi-Fi 使用此操作。

Product Owner 手动打开“设置 → 系统 → 电源”，把插电时睡眠设为“从不”，屏幕可以关闭。也可人工执行 `powercfg /change standby-timeout-ac 0`；脚本不会改变电源设置。笔记本合盖是否睡眠也需人工确认。

## 启动、停止与日志

review 后可手动启动入口（长期循环，终端保持运行）：

```powershell
$nodePath = (Get-Command node -CommandType Application | Select-Object -First 1).Source
.\scripts\services\start-services.ps1 -NodePath $nodePath
```

使用带用户 SID 的 Global 命名 Mutex 防止同一用户在多个会话重复运行。入口负责 PostgreSQL 启动及恢复，启动后最多等 60 秒，并持续重试；每 60 秒检查守护进程。Worker / readonly 各自守护在启动前检查端口和 PostgreSQL；不在守护脚本内启动数据库。退出后依次等待 5、15、60 秒，之后一直等 60 秒；运行超过 10 分钟后退出，等待重置为 5 秒。缺少 `readonly.env` 时每 60 秒检查一次，绝不回退到 repo `.env`。

停止（保留任务注册及 PostgreSQL）：

```powershell
.\scripts\services\stop-services.ps1
# 连同 PostgreSQL 停止：
.\scripts\services\stop-services.ps1 -IncludePostgres
# 删除登录任务，另行停止已启动的服务：
.\scripts\services\register-tasks.ps1 -Unregister
```

停止脚本通过现有 Node 配置解析 Worker 的真实 runtime 路径，仅返回路径，不显示 env 内容；无法解析时拒绝操作，可明确传入 `-RuntimeDir '<实际目录>'`。存在活 PID 的刷新锁或锁无法解析时默认拒绝，提示检查后才使用 `-Force`。强制停止会中断刷新，可能需要人工清理 running run。脚本只停止当前用户、当前脚本路径对应的 supervisor / guardian 及其 Node 服务和抓取后代，并复查创建时间以防 PID 复用，不对所有 Node 进程执行批量终止。手动运行、其他 repo 的 Node 不会被停止；任务停止后下一次登录仍会启动，维护期间如需长期停用，应删除任务。

日志位于 `%LOCALAPPDATA%\nc-ops-console\logs\`：

| 文件 | 内容与滚动 |
|---|---|
| `services.log` | 启动、数据库恢复、守护状态，每条带时间戳 |
| `worker.log`、`readonly.log` | stdout / stderr 每行带时间戳和来源、退出码、重启等待 |
| `postgres.log` | PostgreSQL 自身输出 |

服务日志超过 10 MB 时下次写入滚动为 `.1`，只保留一份旧日志。PostgreSQL 文件可能保持打开，脚本仅在确认 cluster 已停止、下次启动前滚动超过 10 MB 的日志；运行期间不会强行移动文件。需持续控制 PostgreSQL 日志大小时，人工维护其原生日志轮转配置，不能重命名正在打开的文件。

手动启动 PostgreSQL（普通 PowerShell，当前部署用户）：

```powershell
$basePath = Join-Path $env:LOCALAPPDATA 'nc-ops-console'
& (Join-Path $basePath 'pgsql\bin\pg_ctl.exe') start -D (Join-Path $basePath 'pgdata') -l (Join-Path $basePath 'logs\postgres.log')
& (Join-Path $basePath 'pgsql\bin\pg_isready.exe') -h 127.0.0.1 -p 5432
```

## 刷新、登录与故障恢复

- 在公用电脑打开 `http://127.0.0.1:3100`，选择范围并确认刷新。其他电脑的 3000 入口只读，浏览不会产生 DMS 请求。
- DMS 登录过期：在**交互式终端**运行 `npm run dms:login`，在浏览器完成登录后回到终端按 Enter。Claude Code 的 `!` 方式不能完成该交互。登录后重新刷新，不自动重试失败抓取。
- 正式命令行刷新只用 `npm run dms:scrape-stations`（需要时显式传 `--stations`）。旧的 `dms:scrape`、`dms:scrape-route-detail`、`dms:scrape-route-details` 只写 JSON，不能用于正式 DB 刷新。
- run 卡在 running：先确认没有任何抓取运行，再执行 `npm run db:abandon-run -- <run_id> --confirm-no-scrape-running`。`<run_id>` 是实际 UUID，该命令只把 running 改为 abandoned；不要在活跃抓取期间执行。
- 残留 `scrape.lock`：Windows 可能复用 PID，存活检测不足以证明抓取仍在进行。先确认 Worker 进度、相关进程及命令行均无刷新，再人工删除**实际 runtime 目录**中的 `scrape.lock`。不要只依据 PID 或自动删除锁；锁损坏也需人工确认。
- PostgreSQL 不可用时先看日志与内存，不要反复初始化数据库。2026-10-08 曾因可用内存仅约 0.6 GB 导致 PostgreSQL 崩溃（`0xC0000142`）。公用电脑不要长期运行大量常驻应用，应保留足够可用内存。

## 回退与验收

回退前停止 Worker（可先用停止脚本停止两项 Node 服务）。把 `readonly.env` 的 `DATA_SOURCE` 改为 `json` **只适用于 loopback 本机模式**，同时需设置本机监听；现有保护不允许局域网 JSON 模式。局域网部署可暂时停用只读服务，继续使用命令行抓取和本机 JSON 模式；正式抓取仍使用 `dms:scrape-stations`。重新启动前确认配置，不以 repo `.env` 替代 readonly 配置，也不删除 DB / JSON 数据。

TD7：repo 当前位于 OneDrive，Product Owner 决定暂不迁移。脚本从自身上两级解析 repo，不写死同步路径；数据库、登录态、readonly 配置、日志和默认 runtime 保持在 `%LOCALAPPDATA%`。OneDrive 同步 repo 的维护风险仍存在，后续迁移需重新注册任务。

CD-AC35 的部署验证留给 Claude review 后执行：检查任务配置，注销重新登录或重启后确认三个进程自动运行、防火墙仅开放 TCP 3000（Private / Domain），再从另一台电脑测试只读访问。CD-AC36 的真实 DMS 刷新及局域网验证也需另行执行。本次脚本语法检查和 npm 测试不能替代这些部署验收。
