# 片区管理 / District Management（DA）

- **状态：** Approved（Product Owner 2026-10-09；DA-Q1 至 DA-Q4 按 Claude 推荐执行；DA-T0 已批准）
- **相关文档：**
  - `docs/features/district.md`（片区层级、南加州）
  - `docs/features/central-db.md`（第 21 节 schema 和角色、第 22.3 节 `scrape_disabled` 与刷新范围）
  - `docs/features/warehouses.md`（D18：3100 管理、3000 只读的先例）
  - `docs/deployment.md`
- **这次不做：**
  - `scrape_disabled` / 跳过原因的界面
  - 新增 Station 代码（Station Management）
  - 新增、删除或改名 District
  - 调整 Station 在片区内的排序
  - 登录 / 审计
  - 保存后自动抓取
  - 运行 DMS

---

## 1. 目标

在公用电脑本机（3100）上，从**已知 Station** 中给现有 District 添加或移除 Station。保存后的片区归属会立即生效于：

- 美西线路画像的 District / Station 下拉
- 线路地图的 District / Station 下拉
- 仓库的片区和站点校验与显示
- 以后按 District 刷新时的 Station 范围

**“保存片区配置”和“开始抓取 DMS”是两个完全独立的操作。** 保存不会触发任何抓取。

## 2. Product Owner 决定（2026-10-09）

| # | 决定 |
|---|---|
| A1 | 片区归属存在 PostgreSQL，正式环境以数据库为**唯一**来源。`config/districts.json` 降级为：一次性种子、`DATA_SOURCE=json` 后备、测试 fixture。 |
| A2 | 新建写入账号 `nc_district`，不与 `nc_warehouse` 混用。它只能修改片区归属和配置版本，不能写 `known_stations`、`districts`、Route / ZIP / DMS / 仓库等其他表。 |
| A3 | 从 District 移除的 Station，如果有历史数据，就保留并显示在“未分配站点 / Unassigned Stations”下。snapshot / Route / ZIP 历史数据不删除，以后可以重新分配。 |
| A4 | 这次不把 `scrape_disabled` 放进管理界面，以后单独做。 |
| A5 | 界面只能从 `known_stations` 中选择 Station，不能手动输入新代码。 |
| A6 | 不做新增、删除或改名 District，只管理现有 District 的 Station 归属。 |
| A7 | 使用 `district_config_version`：预览时返回版本号，开始刷新时必须带上预览时的版本号；版本变了就返回 409，要求重新预览。 |
| A8 | 一个 Station 只能属于一个 District，由数据库约束保证。普通添加一个已属于其他片区的 Station 时返回 409；前端显示它当前属于哪个片区；用户明确确认“移动”后，服务端在一个事务中完成移动，任何时刻都不会出现重复归属。 |
| A9 | 3000 只读，不能修改 District。3100（公用电脑本机，只监听 127.0.0.1）可以管理片区归属。`nc_district` 凭据只给 3100。 |
| A10 | 仓库的片区和站点校验改为读取数据库中的片区归属。Station 被移出 District 时，不自动删除或修改仓库，继续按现有规则显示异常归属。 |
| A11 | 保存前显示差异（Added / Removed / Moved），用户确认后才保存。 |
| A12 | Station 即使当前在 DMS 中不可访问，也可以留在 District 中，不会因为抓不到而被自动移除。继续沿用 `scrape_disabled` 机制。 |

| A13 | （DA-Q1）刷新预览本期**不**标注“上次不可用”的 Station。 |
| A14 | （DA-Q2）DA-T2 增加临时开关 `DISTRICT_SOURCE=file\|db`，默认值为 `file`。正式服务先保持读文件，等 migration 004 和种子导入验证完成后，再切换为 `db`。见 5.4。 |
| A15 | （DA-Q3）新加入的 Station 排在片区末尾，本期不提供排序调整。 |
| A16 | （DA-Q4）不记录操作人和变更历史，只保留 `district_config_version` 和 `updated_at`。 |
| A17 | 移动 Station 时，`scrape_disabled_reason` **不能丢失**。本设计中这个字段存放在 `known_stations` 上（4.1），移动只修改 `district_stations` 的 `district_id` 和 `ordinal`，而且 `nc_district` 对 `known_stations` 没有任何写权限，所以移动和移除都不会改变它。需要用测试明确验证（DA-AC9）。 |

标记 **〔Claude 建议〕** 的细节已经由 Product Owner 在 2026-10-09 review 通过。

## 3. 现状（Claude 2026-10-09 检查）

- `config/districts.json`：受 git 跟踪，有 3 个片区、37 个 Station。只有丹佛有 `scrape_disabled`（GJT01、BZN01 为 `not_in_dms_menu`）。目前没有“有 snapshot 但不在配置中”的 Station。
- **读取配置的地方有 6 处，每次请求都重新读文件：**
  - `server/src/api/server.js`（`/api/districts`、District 地图、地图站点列表）
  - `server/src/api/freshness.js`
  - `server/src/warehouses/warehouse-api.js`
  - `server/src/worker/worker.js`（刷新预览、POST 刷新）
  - `server/bin/dms-scrape-stations.js`（抓取命令启动时自己再读一次）
  - `server/src/db/parity.js`
- `validateDistricts`、`readDistricts`（会追加 `unassigned` 分组）、`planRefresh` 都是纯函数，可以直接复用。
- 3100 已有“预览 → 确认 → 才启动”的刷新流程（`web/data-status.js` → `/api/refresh/preview` → 确认 → `POST /api/refresh`）。现在只缺“版本一致性”这一环。
- 仓库功能已经把“3100 本机写入、3000 只读”的模式实现并部署了（D18）。本功能完全沿用这套模式：独立账号、分级启动检查、loopback 写入防护、通过 capabilities 控制入口。

## 4. 数据设计（migration `004_districts.sql`）

### 4.1 表

| 表 | 字段 | 说明 |
|---|---|---|
| `known_stations` | `code text PK CHECK (code ~ '^[A-Z]{3}\d{2}$')`、`scrape_disabled_reason text NULL CHECK (IN ('not_in_dms_menu','no_permission','disabled'))`、`created_at` | 已知 Station 登记表，选择器只能从这里选。这次只由种子导入写入（A5）。 |
| `districts` | `id text PK CHECK (^[a-z0-9-]{1,32}$ AND id <> 'unassigned')`、`name_zh`、`name_en`（都 NOT NULL，trim 后非空）、`ordinal int NOT NULL UNIQUE` | 这次只由种子导入写入（A6）。 |
| `district_stations` | `station_code text PK REFERENCES known_stations(code)`、`district_id text NOT NULL REFERENCES districts(id)`、`ordinal int NOT NULL` | **以 `station_code` 作为主键，一个 Station 只能属于一个 District（A8）。** 片区内按 `ordinal, station_code` 排序。 |
| `district_config_version` | `id boolean PK DEFAULT true CHECK (id)`、`version bigint NOT NULL`、`updated_at timestamptz NOT NULL` | 只有一行。每次保存片区归属，在同一个事务中把 `version + 1`。 |

**`scrape_disabled_reason` 放在 `known_stations` 上，而不是放在片区归属表上〔Claude 建议〕：**

- 它描述的是这个 Station 在 DMS 中能不能访问，是 Station 本身的属性。
- 放在 Station 上，移除或移动 Station 时，跳过原因不会丢失。
- `nc_district` 对 `known_stations` 没有写权限，所以这次的功能不可能改到它（A4）。
- 组装成配置对象时，按 Station 所属的 District 还原成现有的 `district.scrape_disabled` 结构，`planRefresh` 不需要改。

### 4.2 视图

- `v_known_stations`：`code`、`scrape_disabled_reason`。
- `v_districts`：`id`、`name_zh`、`name_en`、`ordinal`。
- `v_district_stations`：`station_code`、`district_id`、`ordinal`。
- `v_district_config_version`：`version`、`updated_at`。

### 4.3 角色与授权

| 角色 | 授权 |
|---|---|
| `{{reader_role}}` | 4 个视图的 SELECT |
| `{{scraper_role}}` | 4 个视图的 SELECT（抓取命令用它读取片区归属和版本号） |
| `{{warehouse_role}}` | `v_districts`、`v_district_stations` 的 SELECT（仓库校验读取片区归属；**不能写**） |
| `{{district_role}}`（新） | schema USAGE；4 个视图的 SELECT；`district_stations` 的 SELECT、DELETE，以及列级 `INSERT (station_code, district_id, ordinal)`、`UPDATE (district_id, ordinal)`；`district_config_version` 的 SELECT 和 `UPDATE (version, updated_at)`。对其他任何表都**没有**权限。 |

- `migrate.js` 增加占位符 `{{district_role}}` 和参数 `districtRole`（默认 `nc_district`，测试用 `nc_test_district`）。
- 不修改 001–003 已有的授权。
- `nc_district` 和 `nc_test_district` 需要由 Claude 用 `nc_admin` 手动创建，做法与仓库功能的 T0 相同，**需要 Product Owner 批准**。

### 4.4 种子导入（`npm run db:import-districts`）

- 使用 owner 账号运行，读取 `config/districts.json`，经 `validateDistricts` 校验后，在**一个事务**中完成：
  - 写入 `districts`（顺序与文件一致）。
  - 写入 `known_stations`：配置中的 37 个 Station，加上数据库 `stations` 表中有、但配置中没有的 Station（目前没有）。同时写入 `scrape_disabled_reason`（GJT01、BZN01）。
  - 写入 `district_stations`（`ordinal` 与文件顺序一致）。
  - 写入 `district_config_version` 的初始行，`version = 1`。
- 如果任一表已有数据，就**拒绝执行**，不覆盖，也不合并。只在首次部署时运行一次。
- 输出只包含数量，不输出连接信息。

## 5. 读取路径

### 5.1 统一的片区读取接口〔Claude 建议〕

- `db-data-source.js`（用 reader）新增 `readDistrictConfig()`：从视图组装出与 `districts.json` **结构完全相同**的配置对象，并附带 `config_version`。组装后再调用 `validateDistricts`，保证约束和以前一致。
- json 数据源的 `readDistrictConfig()` 继续读 `config/districts.json`，`config_version` 为 null。
- 6 处读取点都改为调用 `dataSource.readDistrictConfig()`，不再直接读文件。`readDistricts`（包括 `unassigned` 的追加逻辑）改为接收配置对象。
- **数据库模式下，如果片区表为空（还没有导入种子），返回明确的错误 `district_config_unavailable`（503）。不会悄悄回退去读文件**，避免出现两个来源（A1）。

### 5.1a 读取来源开关 `DISTRICT_SOURCE`（A14）

- `DISTRICT_SOURCE=file`（**默认**）：所有读取点、worker 和抓取命令都继续读 `config/districts.json`，`config_version` 为 null。行为与改造前完全一致。
- `DISTRICT_SOURCE=db`：读取数据库（只在 `DATA_SOURCE=db` 时允许；与 `DATA_SOURCE=json` 组合时拒绝启动，并输出一行中文原因）。
- 其他值：拒绝启动。
- 3000、3100、抓取命令**必须使用同一个值**。正式环境中，`readonly.env` 和 repo `.env` 都要设置。3000 和 3100 都在启动日志中输出当前的片区来源。worker spawn 抓取命令时，继承同一个值（不能让抓取命令读取另一份来源）。
- `file` 模式下：
  - `/api/district-admin*` 的写入功能关闭，`district_write: false`。不允许改文件。
  - `POST /api/refresh` 收到的 `config_version` 为 null 时视为一致。
- 切换到 `db` 并稳定运行之后，删除这个开关（另开一个任务，届时需要 Product Owner 确认）。

### 5.2 抓取命令（`dms-scrape-stations.js`）

- `DATA_SOURCE=db` 时，用 scraper 账号从视图读取片区配置和版本号；json 模式时继续读文件。
- 新增参数 `--expected-config-version <n>`：
  - 提供了这个参数时，启动时版本号必须一致，否则以 `config:VersionChanged` 拒绝启动，不会切站，也不会发出任何 DMS 请求。
  - 命令行手动运行时可以不带这个参数，按启动时读到的最新归属执行。

### 5.3 刷新预览与启动（A7）

- `GET /api/refresh/preview?scope=...`：返回中新增 `config_version`。
- `POST /api/refresh` 的 body 中**必须**带 `config_version`（请求体上限由现在的 1 KB 放宽到 2 KB 以内即可）：
  - 与当前版本不一致：返回 409 `district_config_changed`，**不启动**任何进程。
  - 一致：spawn 抓取命令时附加 `--expected-config-version`。
- 这样，确认框里看到的 Station 范围就是实际抓取的范围。即使在“确认”和“启动”之间有人保存了片区，抓取命令也会拒绝启动。
- `web/data-status.js`：确认时把预览得到的 `config_version` 一起提交。收到 409 时提示“片区配置已变化，请重新预览”，然后回到预览步骤。
- 预览中的“上次不可用”提示（例如上一个 run 中切站失败的 Station）**这次不做**，见 DA-Q1。

## 6. 写入路径（只在 3100）

### 6.1 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/district-admin` | 返回 `config_version`、全部 District（id、名称、成员及顺序），以及全部已知 Station（code、当前所属 District 或 null、`has_snapshot`、`scrape_disabled_reason`，后者只读展示）。**只在 3100 挂载。** |
| POST | `/api/district-admin/membership` | body：`{ district_id, add: [code], remove: [code], move: [code], expected_version }` |

**POST 的规则**（整个请求在一个事务中完成，任何一步失败都整体回滚）：

1. 写入防护与仓库相同：只接受 loopback Host；Origin 必须为 `http://<Host>`；请求头带 `X-NC-District: 1`；只接受 JSON；body 不超过 4 KB；只允许上面列出的字段。
2. `district_id` 必须存在。`add`、`remove`、`move` 中的每个代码都必须符合格式，并且存在于 `known_stations`；三个列表之间不能有重复。否则返回 400：`unknown_station`、`invalid_membership_change`。
3. `remove`：每个 Station 都必须当前属于 `district_id`，否则返回 400 `not_member`。执行 DELETE。
4. `add`：如果 Station 已属于**其他** District，返回 409 `station_in_other_district`，并在 `conflicts: [{ station, current_district_id, current_district_name_zh }]` 中说明；如果已属于本 District，返回 400 `already_member`；如果没有归属，INSERT，`ordinal` 接在本片区最大值之后。
5. `move`：Station 必须当前属于**其他** District（不属于任何 District 时应该用 `add`，返回 400）。用一条 `UPDATE district_stations SET district_id=…, ordinal=…` 完成，主键不变，所以任何时刻都不会有重复归属（A8）。
6. 版本：`UPDATE district_config_version SET version = version + 1 … WHERE version = $expected`。影响行数为 0 时回滚，返回 409 `district_config_changed`。
7. `add`、`remove`、`move` 全部为空时返回 400，不改变版本号。
8. 成功时返回 200：`{ config_version, district_id, added, removed, moved: [{ station, from_district_id }] }`。
9. **保存不会触发任何抓取，也不会调用 worker 的 refresh。**

- **日志：** 只记录 `HTTP <status>`，不记录 body。
- **不提供：** 编辑 `known_stations`、`districts`、`scrape_disabled_reason` 的接口，也没有任何写文件的能力。

### 6.2 3000 与 3100

| | 3000（局域网） | 3100（本机） |
|---|---|---|
| `/api/district-admin*` | **不挂载**，返回 404 | 挂载 |
| 凭据 | 只有 `nc_reader`；**局域网模式下出现 `NC_DB_DISTRICT_URL` 时拒绝启动** | reader、scraper、`nc_warehouse`，加上 `NC_DB_DISTRICT_URL` |
| capabilities | `district_write: false` | `district_write: true`（通过启动检查时） |

- **3100 启动检查**（沿用仓库的分级规则）：新增 `checkDistrictPrivileges`，逐项检查 4.3 中列出的权限，并确认不是 superuser、没有角色成员关系、不拥有任何对象、没有 CREATE / TEMP 权限，对其他表也没有写权限。
  - 只是缺少权限（表还不存在）：关闭写入，服务照常启动。
  - 权限过大：拒绝启动。
- **3000 局域网模式：** reader 隔离检查扩展到片区表，reader 对 4 张基础表既不能写，也不能读。

## 7. 前端

### 7.1 入口〔Claude 建议〕

- 放在 `web/data-status.js` 的数据状态区域，“刷新数据”按钮旁边加一个“管理片区”按钮。线路画像页和线路地图页都会加载 data-status，所以两个页面都有这个入口，不需要复制代码。
- 只有 capabilities 中 `district_write === true` 时才显示。按 WH-FIX1 的经验，管理模块 `web/district-admin.js` 用 `import()` **动态加载**，加载失败只影响这个入口，不影响主页面。

### 7.2 管理面板（`web/district-admin.js`）

- 选择一个 District 后，列出当前成员，按片区内顺序排列，每行有“移除”勾选框，标记“暂无数据”和“跳过原因：<reason>”（只读）。
- “添加 Station”区域：列出所有已知 Station，**不提供文本输入**。
  - 未分配的 Station 可以直接勾选“添加”。
  - 属于其他 District 的 Station 显示“当前属于 <片区名>”，只能勾选“移动到本片区”，不能普通添加（A8）。
- **差异确认（A11）：** 点击“保存”后先显示差异，确认后才提交。
  ```
  Added:   SFV02, FAT01
  Moved:   LAX03（来自 北加州片区）
  Removed: LAX02
  ```
- **保存结果：**
  - 显示新增、移出、移动了哪些 Station，以及“未触发数据抓取，如需抓取请使用‘刷新数据’”。
  - 收到 409 `district_config_changed` 时，提示“片区配置已被修改，请重新加载”，并重新拉取数据。
  - 收到 409 `station_in_other_district` 时，显示冲突的 Station 及其所属片区。
- 所有用户可见内容都用 `textContent` 写入。390 宽度下面板全屏，不出现横向滚动。

### 7.3 保存后页面同步

- 保存成功后，在 `document` 上派发 `nc:districts-changed` 事件。
- `web/app.js`（线路画像）和 `web/map.js`（线路地图）监听这个事件，重新请求 `/api/districts`，走与首次加载相同的 District / Station 选择器初始化逻辑。
- 如果当前选中的 Station 已经不在当前 District 中，按现有规则（`chooseSelection` 等）回到片区总览或片区内的第一个可用 Station。
- 不刷新整个页面，不触发抓取。
- 3000 的其他电脑：下一次加载页面或切换 District 时，就会看到新的归属（每次请求都读数据库，没有缓存）。

## 8. 对现有功能的影响

- **6 处读取点改为通过数据源读取。** 数据库模式不再读 `districts.json`。之后如果修改了 repo 中的 `districts.json`，**不会影响**正式环境；`docs/features/district.md` 中要写明这一点。
- **`unassigned`（A3）：** 移除后有快照的 Station 显示在“未分配站点”下，沿用现有的 `readDistricts` 逻辑。
- **仓库（A10）：** 仓库 API 的片区和站点校验，以及 `station_known` 投影，改为读取数据库中的片区归属，结构不变。仓库数据本身不受影响。
- **刷新范围：** `planRefresh` 不变。`scrape_disabled` 从 `known_stations.scrape_disabled_reason` 还原到配置对象中，GJT01、BZN01 的行为保持不变。
- **3000 / 3100 只读边界**沿用 D18 的模式，Route / ZIP / DMS 数据仍然只读。
- **测试：** 使用 `districtsPath` fixture 的大量现有测试走 json 模式，基本不用改；数据库模式另外补测试。
- **TD 风险缓解：** 片区归属不再受 repo 工作区热加载、git checkout 或 OneDrive 同步的影响。

## 9. 验收标准

| AC | 内容 |
|---|---|
| DA-AC1 | 3000 不能修改 District：`/api/district-admin*` 返回 404；局域网模式下出现 `NC_DB_DISTRICT_URL` 时拒绝启动；`district_write: false`；页面上没有“管理片区”。 |
| DA-AC2 | 3100 可以把未分配的 Station 添加到 District，保存后 `/api/districts` 和两个页面的选择器立即反映新的归属，并且没有触发抓取。 |
| DA-AC3 | 3100 可以移除 Station。被移除的 Station 的 snapshot / Route / ZIP / Detail 数据都保留（行数不变），有快照的 Station 显示在“未分配站点”下。 |
| DA-AC4 | 普通添加一个已属于其他 District 的 Station，返回 409 并给出它当前所属的片区；数据库约束保证不可能出现重复归属。 |
| DA-AC5 | 明确的“移动”在一个事务中完成：从 A 片区移到 B 片区后，A 不再包含它，B 包含它，版本号加 1；任何时刻都不存在重复归属。 |
| DA-AC6 | 新加入但没有 snapshot 的 Station 显示“暂无数据”，不会自动抓取。 |
| DA-AC7 | 保存不会 spawn 任何抓取进程（测试中注入的 spawn 从未被调用），也不会写入 `scrape_runs`。 |
| DA-AC8 | 刷新预览使用最新的片区归属，并返回 `config_version`。预览之后如果保存了片区，`POST /api/refresh` 返回 409 且不启动；抓取命令带 `--expected-config-version` 时，版本不一致就拒绝启动，并且不发出任何 DMS 请求。 |
| DA-AC9 | `scrape_disabled` 的 Station（GJT01、BZN01）在导入后仍然被跳过。**把 GJT01 从 denver 移到其他 District、再移回来，以及移除后再添加，`scrape_disabled_reason` 都保持 `not_in_dms_menu`，刷新范围中仍然跳过它（A17）。** 暂时无法访问的 Station 可以留在 District 中。 |
| DA-AC16 | `DISTRICT_SOURCE`：默认 `file` 时，行为与改造前完全一致（现有测试全部通过）；`db` 时读取数据库；非法值，或与 `DATA_SOURCE=json` 组合时拒绝启动；抓取命令继承与 worker 相同的来源。 |
| DA-AC10 | 只能使用已知 Station：未知代码、格式错误的代码、重复的代码都返回 400；没有任何接口可以写 `known_stations`、`districts`、`scrape_disabled_reason` 或文件。 |
| DA-AC11 | `nc_district` 的权限正向和反向都有测试；权限过大时 3100 拒绝启动，表缺失时只关闭写入。reader、scraper、warehouse 账号都不能写片区表。 |
| DA-AC12 | 种子导入：37 个 Station、3 个 District、顺序和 `scrape_disabled` 都与 `districts.json` 一致；已有数据时拒绝执行。导入后，`/api/districts`、District 地图、刷新预览的输出与导入前（json 模式）一致。 |
| DA-AC13 | 数据库模式下片区表为空时返回 503 `district_config_unavailable`，不会回退去读文件。 |
| DA-AC14 | North Cal / Denver / Southern California 没有回归：选择器、District 地图、ZIP 搜索、仓库过滤、刷新预览都正常；1440 和 390 宽度下没有横向滚动。 |
| DA-AC15 | `npm test` 全部通过，`git diff --check` 通过。 |

## 10. 任务拆分

| 任务 | 内容 | 执行 |
|---|---|---|
| **DA-T0 环境准备** | 用 `nc_admin` 创建 `nc_district`（只有 `nc_ops` 的 CONNECT 权限）和 `nc_test_district`（只有 `nc_ops_test` 的 CONNECT 权限）。随机密码写入 `secrets\`；连接串写入 repo `.env` 的 `NC_DB_DISTRICT_URL` 和 `NC_TEST_DB_DISTRICT_URL`。**不写入** `readonly.env`。 | Claude，**需要 Product Owner 批准**（涉及密钥） |
| **DA-T1 DB** | migration 004（表、视图、授权）、`migrate.js` 占位符、`checkDistrictPrivileges`、扩展 reader 隔离检查、`db:import-districts` 命令、测试 helper 加入 `DISTRICT` 账号，以及数据库测试（DA-AC4、5、9、10 的数据库层，以及 DA-AC11、12） | Codex |
| **DA-T2 读取路径与刷新版本** | 数据源的 `readDistrictConfig`，6 处读取点改为通过数据源读取，返回 503 `district_config_unavailable`；抓取命令从数据库读取并支持 `--expected-config-version`；worker 的 preview / POST 带版本号并在不一致时返回 409；`data-status.js` 提交版本号并处理 409；测试覆盖 DA-AC8、9、12、13、14（服务端） | Codex |
| **DA-T3 写入 API 与启动检查** | `server/src/districts/` 的规则、存储和 API 模块；只在 3100 挂载；3100 加载 `NC_DB_DISTRICT_URL` 并做分级启动检查；3000 局域网模式下出现该变量时拒绝启动；capabilities 增加 `district_write`；测试覆盖 DA-AC1–7、10、11（服务端） | Codex |
| **DA-T4 前端** | `web/district-admin.js`（动态加载）、data-status 中的入口、差异确认、`nc:districts-changed` 事件以及 `app.js` / `map.js` 的同步；测试覆盖 DA-AC1、2、6、14（前端） | Codex |
| **部署** | 执行 migration 004 → 执行 `db:import-districts`（一次） → 重启服务 → 在 3100 上验证一次真实的“添加后再移除”（测试结束后恢复原状），并验证 3000 只读 | Claude，**部署前需要 Product Owner 批准** |

- 每个 Codex 任务都按 `CLAUDE.md` 第 5 节 review，最多修两轮。
- DA-T2 是改动最大的一步，所以把它和写入功能（DA-T3）分开，先让“读取路径换成数据库”这一步单独验证无回归。
- **部署顺序（A14）：**
  1. 代码合入后，`DISTRICT_SOURCE` 保持默认 `file`，正式服务即使重启，行为也不变。
  2. 执行 migration 004 和种子导入，并核对导入结果与文件输出一致。
  3. 在 `readonly.env` 和 repo `.env` 中把 `DISTRICT_SOURCE` 都设为 `db`，然后重启服务。
  4. 如果需要回退，把两个 env 中的 `DISTRICT_SOURCE` 改回 `file` 并重启即可。在 db 模式下做过的片区修改不会自动同步回文件。

## 11. 测试要求（汇总）

- **数据库测试**（`NC_TEST_DB_*`，新增 `NC_TEST_DB_DISTRICT_URL`）：表约束、唯一归属、各角色的正向和反向权限、启动检查、种子导入（成功、拒绝重复导入、与文件一致）、事务回滚。
- **API 测试**（fake 或真实测试库）：添加、移除、移动、409 冲突、版本冲突、未知 Station、空改动、写入防护的各种拒绝、3000 返回 404 和 405、保存时不 spawn 抓取。
- **刷新测试：** 预览带版本号；POST 时版本不一致返回 409 且不 spawn；抓取命令在版本不一致时拒绝启动，并且不发出 DMS 请求（mock）。
- **前端测试**（fake DOM）：入口只在 `district_write` 为 true 时出现、差异确认、冲突显示、保存后派发事件并同步选择器、被移除的 Station 回落到片区总览、390 宽度的 CSS 规则。
- **无回归：** 现有测试全部通过；json 模式的输出与改动前一致。

## 12. 未决问题

见 `docs/open-questions.md` 的“片区管理”一节（DA-Q1 至 DA-Q4）。

## 13. 实现记录

### DA-T0 — 2026-10-09（Claude，Product Owner 批准）

- 用 `nc_admin` 创建了两个角色：
  - `nc_district`：只有 `nc_ops` 的 CONNECT 权限。
  - `nc_test_district`：只有 `nc_ops_test` 的 CONNECT 权限。
  - 属性都是 LOGIN、NOSUPERUSER、NOCREATEDB、NOCREATEROLE、NOINHERIT、NOREPLICATION、NOBYPASSRLS。
- 密码是 128 bit 随机值，保存在 `%LOCALAPPDATA%\nc-ops-console\secrets\nc_district.txt` 和 `nc_test_district.txt`，ACL 只给当前用户。
- 连接串只写入 repo `.env`（`NC_DB_DISTRICT_URL`、`NC_TEST_DB_DISTRICT_URL`）。**没有写入** `readonly.env`。`.env` 已被 gitignore，git 中没有这两个连接串。
- 创建角色时，会话关闭了出错语句的日志。已核对 `postgres.log`：没有角色名、没有 `PASSWORD`、没有 32 位十六进制串。
- **验证结果：**
  - 两个角色都能登录各自的库。
  - 都不是 superuser，没有角色成员关系，不拥有任何对象。
  - 数据库的 CREATE 和 TEMP 都为 false，CREATE TEMP TABLE 被拒绝（42501）。
  - 对正式库的 `nc` schema 没有 USAGE；读取 `nc.warehouses` 被拒绝（42501）。
  - 跨库连接被拒绝（42501）。
- 没有执行任何 migration。

### DA-T1 — 2026-10-09（Codex 实现，Claude review 通过，一轮完成）

- **新增：**
  - `server/db/migrations/004_districts.sql`：4 张表、4 个视图、授权，与 4.1–4.3 一致。
  - `server/src/districts/district-privileges.js`：`checkDistrictPrivileges`、`checkReaderDistrictIsolation`（只实现了函数，还没有接入启动流程，接入在 DA-T3）。
  - `server/src/db/district-import.js`：
    - `importDistricts`：一个事务完成；导入前先对 4 张表加 EXCLUSIVE 锁并检查是否为空，已有数据就拒绝执行。
    - `assembleDistrictConfig`：从视图还原配置对象，供 DA-T2 复用。
  - `server/bin/db-import-districts.js`、`npm run db:import-districts`：只输出数量，失败时只输出 SQLSTATE。
  - `server/test/district-db.test.js`：12 项测试，在真实测试库上运行。
- **修改：**
  - `migrate.js`：增加 `{{district_role}}` 和 `districtRole` 参数。
  - `db-helpers.js`：`dbSkip` 和身份校验加入 DISTRICT。
  - `refresh-migration.test.js`、`warehouse-db.test.js`：版本列表改为 001–004，属于机械性修改。
  - `package.json`：只新增了 scripts 里的一行。
  - `docs/data-schema.md`。
- **A17 验证：** GJT01 移出 denver 再移回、移除后再加回，`scrape_disabled_reason` 始终是 `not_in_dms_menu`。
- **Claude 本机验证：**
  - `npm test` 589 项全部通过（0 失败、0 跳过）。
  - DA-T1 的 12 项都在真实测试库上通过，没有跳过。
  - `git diff --check` 通过。
  - 001–003 没有变化；测试库中没有残留的临时 schema。
- **没有**连接正式库，没有执行正式的 migration 或导入。读取路径、API、前端都没有改动。
