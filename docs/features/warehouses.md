# 仓库管理 / Warehouse Management（WH）

- **状态：** Awaiting preview sign-off（D18 权限方案已部署，2026-10-09）
  - Product Owner 2026-10-09 review 通过；T0、WH-T1、WH-T2、WH-T3、WH-FIX1 的代码和 Claude review 都已完成。
  - **2026-10-09 权限方案调整（D18）：只有公用电脑本机（3100）管理仓库，3000 恢复为真正只读。** WH-T4 负责把写入入口收回到 3100。
  - 仓库功能曾按 Product Owner 要求暂停（2026-10-09，优先抓取南加州数据）。正式库部署（migration 003）仍需另行批准。
- **相关文档：** `docs/features/route-map.md`（地图、RM5 / RM5b / RM6 / RM7）、`docs/features/district.md`、`docs/features/central-db.md`（第 21 节数据库角色、第 22 节 P3 部署）、`docs/deployment.md`
- **不做：** Active / Inactive、登录 / SSO / 账号、operator audit、`created_by` / `updated_by`、Nominatim 自动兜底、新服务端口、DMS 改动、Route 数据改动、新增 npm 依赖。

---

## 1. 目标

在线路地图中显示仓库位置，并允许任何能访问 Dashboard 的电脑查看、添加、修改、删除仓库。仓库数据存放在中央 PostgreSQL，所有电脑看到同一份数据。不使用 localStorage 保存仓库。

## 2. Product Owner 决定（2026-10-09）

| # | 决定 |
|---|---|
| D1 | 用户只填写 Name、Address、District、Station（可选）。保存时由服务端调用 **US Census Geocoder** 得到坐标。不自动 fallback 到 Nominatim。 |
| D2 | Census 识别失败时才显示默认折叠的“手动输入坐标”。失败时不保存错误坐标，不清空用户的输入。 |
| D3 | 显示 Census 标准化后的地址供用户核对。坐标明显离所选 District 很远时弹出确认，用户确认后允许保存。 |
| D4 | ~~现阶段不做登录。能访问办公室局域网 Dashboard 的电脑都可以添加、修改、删除仓库。~~ **已被 D18 取代。** 仍然不做登录。 |
| D5 | 地址规范化后相同：提示“可能重复”，必须二次确认。名称相同但地址不同：允许保存，只给提示。 |
| D6 | 3000 和 3100 共用一个 Warehouse 模块。3100 仍然只监听 localhost，3000 仍然只对局域网开放。Route / ZIP / DMS 数据继续只读。（写入范围按 D18 收回到 3100。） |
| D7 | 新增 `nc_warehouse` 角色，只能对 `warehouses` 执行 SELECT、INSERT、UPDATE（限定字段）、DELETE。启动时实际检查权限，权限过大时拒绝启动。 |
| D8 | District 必填，Station 可选。Station 按 `config/districts.json` 校验是否存在、是否属于所选 District，不依赖 DB `stations` 表。 |
| D9 | 如果 District 被删除或改名：不自动删除仓库，地图上不显示，“查看全部仓库”中标记“片区不存在 / Unknown District”，由用户手动重新分配，不自动猜测归属。 |
| D10 | 仓库 marker 只跟当前 District 显示，不受 Station、DSP、Route / ZIP 选择影响，不参与淡化。 |
| D11 | 删除是真正的 DELETE，必须二次确认，确认框至少显示 Name 和 Address。 |
| D12 | CRUD 之后只刷新 warehouse 图层，不刷新整个页面，不运行 DMS。 |
| D13 | 批准使用 Census Geocoder（不需要 API key）。在 deployment / privacy 文档中写明：仓库的商业地址会通过 HTTPS 发送给 US Census Geocoder，用于地址转坐标。 |
| D14 | 离片区阈值为 50 km，只用于提醒，不作为硬阻止。超过阈值时弹出二次确认，确认后仍可保存（WH-Q1）。 |
| D15 | 接受删除不可恢复：Delete → 显示 Name 和 Address → 二次确认 → 物理删除。误删后手动重新添加。不做 soft delete、Active / Inactive 或 audit history（WH-Q3）。 |
| D16 | 保存到非当前片区时，不自动切换片区，提示“已保存到 X 片区”并带“查看仓库”按钮。点击按钮后切换到对应片区，并定位、高亮该仓库。 |
| D17 | 多人并发编辑：保存时核对仓库在打开后是否已被修改。如果已变化，不覆盖，提示“仓库已被其他人修改，请重新加载后再编辑”，并刷新仓库数据。 |

标记为 **〔Claude 建议〕** 的细节已经由 Product Owner 在 2026-10-09 review 通过。D14–D17 是 review 时补充的决定。

### 2.1 权限方案调整（D18，Product Owner 2026-10-09）

**只有公用电脑本机管理仓库，其他电脑只能查看。** 本节取代 D4 和第 5.3 节中“局域网写入”的设计；与其他章节冲突时，以本节为准。

| 服务 | 仓库能力 | 数据库凭据 |
|---|---|---|
| **3100**（Worker，只监听 127.0.0.1，公用电脑本机） | 查看，以及添加、编辑、删除、调用 Census Geocoder；显示“管理仓库” | reader，加上 `nc_warehouse`（repo `.env`） |
| **3000**（局域网只读） | 只能查看：显示 marker，点击后显示 Name、Address、District、Station。**没有** POST、PATCH、DELETE，**不显示**“管理仓库”和任何编辑入口 | **只有** `nc_reader`（`readonly.env`）；**不加载** `nc_warehouse` |

- **取消：** 3000 的仓库写接口、`WAREHOUSE_ALLOWED_HOSTS` 局域网写入白名单，以及 3000 对 `nc_warehouse` 凭据的依赖。
- **3000 启动检查：**
  - 局域网模式下，环境中出现 `NC_DB_WAREHOUSE_URL` 时，**拒绝启动**（和 scraper / owner 配置同样处理）。
  - 本机模式下不读取这个变量。
  - 继续检查 reader 不能写 `warehouses`。
- **前端：** 3000 和 3100 共用同一套模块。根据 `/api/capabilities` 的 `warehouse_write` 决定是否创建管理面板、是否显示“管理仓库”按钮。不复制两套页面。
- **保留：** migration 003、`nc_reader`→`v_warehouses`、`nc_warehouse` 的有限 CRUD 权限、3100 的写请求防护（loopback Host、Origin、`X-NC-Warehouse`）、5.4 的分级启动检查（只用于 3100）。
- **环境：** 2026-10-09 Claude 已从 `readonly.env` 删除 T0 写入的 `NC_DB_WAREHOUSE_URL`（文件只剩 `DATA_SOURCE`、`NC_DB_READER_URL`、`LISTEN_HOST`、`PORT`）。repo `.env` 中的 `NC_DB_WAREHOUSE_URL` 保留，给 3100 使用。

## 3. 现状（Claude 2026-10-09 检查）

- 项目中没有任何 geocoding 能力。
- 页面 CSP 为 `default-src 'self'`，浏览器不能直接访问外部服务，所以 geocoding 只能由服务端调用。
- 3000 的只读保证有三层：
  - 路由层：只有 extension 可以声明非 GET 方法，且 extension 不能覆盖只读路由（`server/src/api/app.js`）。
  - 数据库角色层：`nc_reader` 只能读视图。
  - LAN 启动检查：出现 scraper / owner / DMS 配置，或 reader 能写 `scrape_runs` 时拒绝启动（`server/bin/server.js`）。
- 3100 的写保护（`server/src/worker/worker.js`）：校验 Host、Origin、`X-NC-Refresh` 请求头、JSON content type，并限制 body 大小。仓库写入沿用这套做法。
- District 和 Station 的定义在 `config/districts.json`。
- PostgreSQL 版本为 17.11，可以直接用 `gen_random_uuid()`。
- `migrate.js` 只支持 `schema`、`scraper_role`、`reader_role` 三个占位符。
- 测试库 migration 会给所有角色授权，所以新增 migration 003 之前，必须先在测试库创建 `nc_test_warehouse` 角色，否则现有 DB 测试全部失败。
- `run-service.ps1` 会清除继承的 `NC_DB_*` 环境变量，只读服务的配置只来自 `readonly.env`。
- 地图点击事件会清除当前选择（`map.on('click', onClear)`）。点击仓库 marker 不能触发这个清除。

## 4. 数据设计

### 4.1 表（migration `003_warehouses.sql`）

| 字段 | 类型 | 规则 |
|---|---|---|
| `id` | uuid PK，默认 `gen_random_uuid()` | 不使用 sequence，`nc_warehouse` 不需要 sequence 权限 |
| `warehouse_name` | text NOT NULL | trim 后非空，长度 ≤ 120 |
| `address` | text NOT NULL | trim 后非空，长度 ≤ 300。保存用户输入的原文，不替换成 Census 地址 |
| `address_key` | text NOT NULL | 规范化后的地址（见 4.3），用于查重，不返回给前端。建普通索引，**不建** UNIQUE（重复由用户确认后允许保存） |
| `district_id` | text NOT NULL | 格式 `^[a-z0-9-]{1,32}$`。是否存在于 config 由服务端校验 |
| `station_id` | text NULL | 格式 `^[A-Z]{3}\d{2}$`。是否存在、是否属于该 District 由服务端校验 |
| `latitude` | double precision NOT NULL | −90 到 90 |
| `longitude` | double precision NOT NULL | −180 到 180 |
| `created_at` | timestamptz NOT NULL，默认 now() | |
| `updated_at` | timestamptz NOT NULL，默认 now() | 每次 UPDATE 由应用写入 `now()` |

- 视图 `v_warehouses`：包含除 `address_key` 以外的全部字段。
- 不新增 Active / Inactive，不新增 matched address 字段。Census 地址只在保存时显示，不入库。
- 不修改现有的表、视图和授权。

### 4.2 角色与权限

`003` 新增占位符 `{{warehouse_role}}`。`migrate()` 增加参数 `warehouseRole`，默认 `nc_warehouse`，测试使用 `nc_test_warehouse`。

```sql
REVOKE ALL ON warehouses, v_warehouses FROM PUBLIC;
GRANT USAGE ON SCHEMA {{schema}} TO {{warehouse_role}};
GRANT SELECT ON v_warehouses TO {{reader_role}}, {{warehouse_role}};
GRANT SELECT, INSERT, DELETE ON warehouses TO {{warehouse_role}};
GRANT UPDATE (warehouse_name, address, address_key, district_id, station_id, latitude, longitude, updated_at)
  ON warehouses TO {{warehouse_role}};
```

- `nc_warehouse` 是 LOGIN 角色。它只有 `nc_ops` 的 CONNECT 权限，其余权限全部由上面的 SQL 授予。它不是任何其他 nc 角色的成员。
- `nc_scraper` 不对 `warehouses` 授权（001 的 `GRANT SELECT ON ALL TABLES` 只对当时已存在的表生效，003 不再补授权）。
- `nc_reader` 只能读 `v_warehouses`，不能读基础表 `warehouses`。

### 4.3 地址规范化（`address_key`）〔Claude 建议〕

处理顺序：

1. 转小写，Unicode NFKC。
2. 把 `.,#` 替换为空格，合并连续空格，trim。
3. 按词替换常见缩写：street→st、avenue→ave、road→rd、drive→dr、boulevard→blvd、highway→hwy、lane→ln、court→ct、parkway→pkwy、suite→ste、north/south/east/west→n/s/e/w。

只用于查重提示，不改变用户保存的 `address`。已知限制：同一地址的拼写差异较大时，可能识别不出重复。

## 5. 服务端设计

### 5.1 模块结构（新目录 `server/src/warehouses/`）

| 文件 | 职责 |
|---|---|
| `warehouse-rules.js` | 字段校验、District / Station 校验（读 District config）、地址规范化、“离 District 太远”的判断。纯函数，不访问数据库和网络 |
| `geocoder.js` | Census 客户端。`fetch` 可以注入，只返回 `{ status, latitude, longitude, matched_address }` |
| `warehouse-store.js` | `nc_warehouse` 连接池和 CRUD SQL |
| `warehouse-privileges.js` | 启动时的权限检查：`checkWarehousePrivileges()` 和 `checkReaderWarehouseIsolation()`（WH-T1 实现，WH-T2 接入启动流程） |
| `warehouse-api.js` | HTTP handlers、写请求防护、确认流程。依赖都通过注入传入 |

- 读取仓库：`db-data-source.js` 新增 `readWarehouses()`，用 reader 查询 `v_warehouses`。这样即使没有配置写入账号，地图也能显示仓库。
- `json` 数据源不支持仓库：`readWarehouses()` 返回 `DataSourceUnavailableError`，接口返回 503。仓库加载失败不能影响线路地图。
- `server.js` 和 `worker.js` 都通过同一个工厂函数挂载仓库路由，不复制实现。

### 5.2 API

风格沿用现有接口：路径固定，参数放在 query string 中。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/warehouses?district=<id>` | 当前 District 的仓库。District 不存在于 config 时返回 404 `district_not_found` |
| GET | `/api/warehouses` | 全部仓库 |
| POST | `/api/warehouses` | 新增 |
| PATCH | `/api/warehouses?id=<uuid>` | 修改 |
| DELETE | `/api/warehouses?id=<uuid>` | 删除 |

**返回字段（白名单）：** `id`、`warehouse_name`、`address`、`district_id`、`district_name_zh`、`district_name_en`、`district_known`、`station_id`、`station_known`、`latitude`、`longitude`、`created_at`、`updated_at`。

- `district_known=false` 时，两个 District 名称字段为 null。
- `station_known=false` 表示 Station 已不在 config 中，或不再属于该 District。
- 返回中不包含 `address_key`、连接信息、stack、驱动错误或原始 Census 响应。

**按 District 查询** 只返回 `district_known=true` 的仓库（D9）。

**写请求 body**（JSON，≤ 4 KB）：

```json
{
  "warehouse_name": "SFO02 Warehouse",
  "address": "6015 Giant Highway, Richmond, CA 94806",
  "district_id": "north-cal",
  "station_id": "SFO01",
  "manual_coordinates": { "latitude": 37.98, "longitude": -122.33 },
  "confirm": ["duplicate_address", "far_from_district"],
  "expected_updated_at": "2026-10-09T18:00:00.000Z"
}
```

- `station_id` 可以是 null。
- `manual_coordinates` 可选，提供时跳过 Census。
- `confirm` 可选。
- `expected_updated_at` 只在 PATCH 中使用。

**POST 和 PATCH 的处理顺序：**

1. 写请求防护（5.3）。
2. 字段校验。失败返回 400 `invalid_warehouse` 和 `fields: [...]`，只列字段名。
3. District 不在 config：400 `district_not_found`。Station 填了但不存在或不属于该 District：400 `station_not_in_district`。
4. 地址查重：按 `address_key` 查找其他仓库（PATCH 时排除自己）。
5. 确定坐标：
   - 有 `manual_coordinates`：只校验数值范围。
   - POST，或 PATCH 中 `address` 的 trim 结果发生变化：调用 Census。
   - PATCH 中地址未变化：沿用原坐标。
6. 判断是否离 District 太远：只在坐标或 District 发生变化时检查。
7. 如果有未确认的原因，返回 409 `confirmation_required`，同时返回：
   - `reasons`：`duplicate_address` 和 / 或 `far_from_district`
   - `duplicates`：重复仓库的 name、address、district
   - `geocode`：`matched_address`、`latitude`、`longitude`
   - `distance_km`
8. 写入数据库后返回 201（POST）或 200（PATCH），body 包含：
   - `warehouse`
   - `geocode`：没有调用 Census 时为 null
   - `warnings`：名称相同时为 `["duplicate_name"]`，不拦截

**PATCH 并发保护〔Claude 建议〕：** `expected_updated_at` 与数据库中的值不一致时返回 409 `warehouse_changed`，前端提示“仓库已被其他人修改，请重新加载后再编辑”，然后刷新仓库数据（D17）。这样可以避免多台电脑同时编辑时，后保存的人无意中覆盖前一个人的修改。

**DELETE：** 返回 204。记录不存在时返回 404 `warehouse_not_found`。二次确认只在前端做。

**错误码：**

| 情况 | 返回 |
|---|---|
| Census 没有匹配 | 422 `geocode_failed` |
| Census 返回多个坐标不同的匹配 | 422 `geocode_ambiguous`，不自动选择 |
| Census 超时、网络错误、5xx 或响应格式不对 | 503 `geocode_unavailable` |
| 仓库不存在 | 404 `warehouse_not_found` |
| 写入功能未开启 | 405，带 `Allow: GET` |
| 数据库不可用 | 503 `data_source_unavailable` |

### 5.3 写请求防护与能力开关

- **写入功能开启条件：** 同时满足以下三点：
  - `DATA_SOURCE=db`
  - 配置了 `NC_DB_WAREHOUSE_URL`
  - 通过了启动时的权限检查（5.4）
- **能力开关：** `/api/capabilities` 增加 `warehouse_write: true|false`。
- **每个 POST、PATCH、DELETE 都要检查：**
  - `Content-Type: application/json`（DELETE 不需要 body，跳过这一项）
  - `X-NC-Warehouse: 1`
  - body ≤ 4 KB
  - Origin 必须等于 `http://<Host>`
- **Host 白名单（D18 后）：** 只有 3100 开放写入，白名单固定为 `127.0.0.1:<port>` 和 `localhost:<port>`。~~3000 局域网模式的 `WAREHOUSE_ALLOWED_HOSTS` 白名单~~已取消，3000 不开放任何写方法（返回 405）。
- **线路相关接口不变：** Route / ZIP / DMS / refresh 接口的方法和行为都不改。仓库路由不能覆盖任何现有路由。
- **日志：** 不记录地址、名称、URL query 或 Census 响应，沿用现有的 `HTTP <status>` 格式。

### 5.4 启动时的权限检查（D7）

（D18 后只有 `worker`（3100）会加载 `NC_DB_WAREHOUSE_URL`；3000 不加载，局域网模式下出现这个变量就拒绝启动。）`worker`（3100）只要配置了 `NC_DB_WAREHOUSE_URL`，就用这个连接实际检查以下各项。任何一项不符合，**整个服务拒绝启动**，只输出一行中文原因，不输出连接信息。

- `current_user` 不是 superuser，没有 CREATEROLE、CREATEDB、BYPASSRLS 属性。
- 不是任何其他角色的成员（`pg_auth_members` 为空）。
- 不拥有 schema 中的任何对象。owner 不受授权限制，所以必须排除。
- 对 schema 没有 CREATE 权限，对数据库没有 CREATE 和 TEMP 权限。
- 对 `warehouses`：
  - 有 SELECT、INSERT、DELETE 权限。
  - 只对 4.2 列出的列有 UPDATE 权限。
  - 没有 TRUNCATE、REFERENCES、TRIGGER 权限。
- 对 schema 中的其他所有表和视图：没有 INSERT、UPDATE、DELETE、TRUNCATE 权限（包括列级 UPDATE）。

**检查结果分级〔Claude 2026-10-09，原因见下〕：**

- **只有 `missing_warehouse_privilege`**（表或视图不存在，或授权不足）：关闭写入，服务照常启动，记录一行日志。
- **任何“权限过大”类的问题：** 拒绝启动。
- **warehouse 连接串连接失败：** 关闭写入。
- **reader 隔离检查：** 视图不存在时照常启动，此时 `GET /api/warehouses` 返回 503；reader 权限过大时拒绝启动。

**原因：** 服务直接从 repo 工作区运行，正式环境的 env 已在 T0 配置好 warehouse 连接串。代码更新后、正式库执行 migration 003 之前，如果服务重启，3000 不能因为“表不存在”而无法启动。

**另外两项检查：**

- reader 检查（在 3000 局域网模式现有检查的基础上增加）：reader 不能写 `warehouses`，也不能读基础表 `warehouses`。
- ~~局域网启动检查允许出现 `NC_DB_WAREHOUSE_URL` 和 `WAREHOUSE_ALLOWED_HOSTS`。~~（D18）3000 局域网模式下出现 `NC_DB_WAREHOUSE_URL` 时，和 scraper、owner、DMS 配置一样，拒绝启动。

### 5.5 Census Geocoder

- **请求：** `GET https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=<地址>&benchmark=Public_AR_Current&format=json`
  - 只使用 HTTPS。
  - 超时 8 秒。
  - 响应最大 256 KB。
  - 不带 cookie 和 credential。
- **解析：** 坐标取 `result.addressMatches[].coordinates`，其中 `x` 是经度、`y` 是纬度。
  - 0 个匹配：`geocode_failed`。
  - 多个匹配且坐标相距超过 100 m：`geocode_ambiguous`。
  - 否则使用第一个匹配，同时返回 `matchedAddress`。
- **节流：** 服务端同时只发 1 个请求，两次请求至少间隔 1 秒。正常使用量很小，节流只是为了防止误操作或滥用。
- **测试：** 全部用注入的 fetch，测试不访问真实网络。

### 5.6 “离 District 太远”的判断〔Claude 建议〕

- `server.js` 注入 `getDistrictExtent(districtId)`，复用现有的 district map 和 boundaries 读取逻辑，返回该 District 已上图 ZIP 的外包矩形（bbox）。
- 坐标到 bbox 的距离超过 **50 km** 时，判定为 `far_from_district`。50 km 是可配置常量，见 WH-Q1。
- District 还没有任何已上图 ZIP 时（例如没有 snapshot），跳过这项检查，不提示。

## 6. 前端设计

### 6.1 入口

- 地图 header 中，在 DSP 选择框之后增加按钮“管理仓库”。样式比主要操作弱（次要按钮），390 宽度下可以换行。
- （D18）只有 `warehouse_write === true`（即 3100，并且写入功能已开启）时，才创建管理面板并显示“管理仓库”按钮。3000，以及 3100 写入功能关闭、capabilities 请求失败时，都**不显示**这个按钮，只显示 marker 图层。

### 6.2 新模块（`web/map-view.js` 已经 216 行，不往里面加逻辑）

**`web/warehouse-layer.js`**

- 使用独立的 Leaflet pane，z-index 为 620：高于 ZIP 填色（400）和选择描边（450），低于 popup（700）。
- marker 使用 `L.divIcon`，图标是内联 SVG 的建筑物 / 仓库 pin。颜色为深石板色加白色描边，不使用任何 route 颜色或 difficulty 颜色。图例中增加一项“仓库”。
- 提供的接口：
  - `load(districtId)`：调用 `GET /api/warehouses?district=`，替换图层。
  - `focus(id)`：fly 到仓库位置（zoom 13），打开 popup，并让 marker 高亮约 4 秒（CSS 脉冲动画）。
  - `clear()`
- popup 显示 Name、Address、District、Station（有值时）。所有内容都用 `textContent` 写入。
- 点击 marker 不能触发地图的 `onClear`：marker 保持 `bubblingMouseEvents: false`，并用测试覆盖。
- 和 `applySelection`、`setDsp`、station focus、color mode 完全无关，不参与淡化。

**`web/warehouse-panel.js`**

- 管理面板：1440 宽度下为右侧面板或 `<dialog>`，390 宽度下为全屏。
- 两个 tab：
  - “当前片区”（默认）
  - “全部仓库”：列出 Name、District、Station、Address、编辑、删除。`district_known=false` 的行显示“片区不存在 / Unknown District”。
- **表单：**
  - Name、Address、District（默认为当前片区）、Station（下拉框，选项按所选 District 从 config 生成，第一项为“不指定”）。
  - 不显示坐标字段。
  - 只有收到 `geocode_failed`、`geocode_ambiguous` 或 `geocode_unavailable` 后，才出现默认折叠的“手动输入坐标”区域。
- **确认：** 收到 `confirmation_required` 时，在面板内显示确认区域，内容包括：
  - 可能重复的仓库的名称和地址
  - Census 标准化地址
  - 离片区约 X km
  用户确认后，带上 `confirm` 再提交一次。取消时保留表单。
- **保存成功后：**
  1. 关闭表单。
  2. 刷新列表。
  3. 调用 `layer.load(当前片区)`。
  4. 如果保存的仓库属于当前片区：调用 `layer.focus(id)`，并显示 Census 标准化地址供核对。
  5. 如果不属于当前片区：不自动切换片区，显示“已保存到 <片区>”和“查看仓库”按钮（D16）。点击按钮后，按现有 District 切换流程切换地图的 District，图层加载完成后对该仓库执行 `focus(id)`。该 District 已经不存在时，不显示这个按钮。
  6. 返回 `duplicate_name` 时显示非阻断提示。
- **删除：** 二次确认框文案为“确定删除 <Name>？<Address>”。确认后调用 DELETE，然后刷新列表和图层。
- **错误提示：**
  - `geocode_failed` / `geocode_ambiguous`：“地址无法识别”
  - `geocode_unavailable`：“定位服务暂时不可用”
  - `station_not_in_district`：“站点不属于所选片区”
  - `warehouse_changed`：“仓库已被其他人修改，请重新加载后再编辑”，同时刷新列表和图层（D17）
  - 网络错误：显示通用提示
  - 以上所有情况都保留用户的输入。

### 6.3 接入 `web/map.js`

- 只增加少量接线代码：
  - `loadStation()` 成功后调用 `layer.load(districtSelect.value)`。
  - District 变化时，旧片区的仓库请求结果要丢弃（使用 sequence，和现有写法一致）。
  - Station、DSP、搜索、选择的事件 **不调用** 仓库图层。
- 仓库加载失败时：只在面板或图层上显示一行提示，不改变 `#map-message`，不影响线路地图。

## 7. 验收标准

| AC | 内容 |
|---|---|
| WH-AC1 | 新增仓库：填写 Name、Address、District 后，服务端调用 Census 得到坐标并保存。marker 立即出现，地图移动到仓库并高亮，不刷新页面。 |
| WH-AC2 | 修改 Name、District 或 Station 后保存成功。修改 Address 时重新 geocode，坐标更新，地图移动到新位置并高亮。 |
| WH-AC3 | 删除前确认框显示 Name 和 Address。取消时不删除。确认后数据库中的记录被删除，marker 消失。 |
| WH-AC4 | 切换 District 后只显示对应片区的仓库。 |
| WH-AC5 | 切换 Station、DSP filter，或选择 Route / ZIP，都不改变仓库 marker 的数量、位置和样式（不淡化）。 |
| WH-AC6 | 点击 marker，popup 显示 Name、Address、District 和 Station（有值时），并且不清除当前的 Route / ZIP 选择。 |
| WH-AC7 | Station 可以不填。填写的 Station 不存在，或不属于所选 District 时，返回 400 并拒绝保存。 |
| WH-AC8 | 规范化后地址重复：返回 409 `confirmation_required`，确认后才保存。名称重复但地址不同：保存成功，并显示非阻断提示。 |
| WH-AC9 | Census 识别失败、结果不明确或服务不可用时，不写入数据库，表单输入保留，“手动输入坐标”区域出现。手动输入坐标后可以保存。 |
| WH-AC10 | 坐标离所选 District 超过阈值时需要确认，确认后可以保存。District 没有上图数据时不提示。 |
| WH-AC11 | 写入防护：缺少 `X-NC-Warehouse` 请求头、Origin 或 Host 不合规、content type 不对、body 超大，都会被拒绝。写入功能关闭时返回 405。Route / ZIP / DMS / refresh 接口的方法和行为不变。 |
| WH-AC12 | `nc_warehouse` 只能对 `warehouses` 执行规定的操作。对其他表执行 INSERT、UPDATE、DELETE、TRUNCATE，以及 DDL，全部失败。`nc_reader` 不能写 `warehouses`，也不能读基础表。 |
| WH-AC13 | 启动检查：3100 的 warehouse 凭据权限过大时（例如误配成 scraper 或 owner 的连接串），拒绝启动。（D18）3000 局域网模式下出现 `NC_DB_WAREHOUSE_URL` 时拒绝启动；3000 永远不连接 warehouse 账号。 |
| WH-AC20 | （D18）3000：`GET /api/warehouses` 正常；POST、PATCH、DELETE 返回 405；`warehouse_write: false`；页面不显示“管理仓库”，marker 和 popup 正常。3100：CRUD 正常，只监听 localhost，显示“管理仓库”。Route / ZIP / DMS / refresh 数据仍然只读。仓库 API 出错不影响主地图。 |
| WH-AC14 | API 返回内容不包含 `address_key`、stack、连接信息或原始 Census 响应。日志中没有地址或名称。 |
| WH-AC15 | District 从 config 中消失后，该仓库不出现在地图和按片区查询的结果中，“全部仓库”列表中标记为 Unknown District。必须选择有效的 District 才能保存，删除不受影响。 |
| WH-AC16 | `PATCH` 时 `expected_updated_at` 已过期，返回 409 `warehouse_changed`。 |
| WH-AC19 | 保存到非当前片区时，地图不自动切换片区。点击“查看仓库”后，切换到该片区并定位、高亮该仓库（D16）。 |
| WH-AC17 | 1440 和 390 宽度下，地图页和管理面板都没有页面横向滚动。 |
| WH-AC18 | 现有测试全部通过。地图相关功能不回归：District / Station / DSP 选择、Route / ZIP 搜索、Route Profile ZIP 搜索、选择状态、RM5 / RM5b / RM6 / RM7、Coverage、Missing ZIP、跨站冲突。 |

## 8. 测试要求

- **DB 测试（`NC_TEST_DB_*`，新增 `NC_TEST_DB_WAREHOUSE_URL`）：**
  - migration 003 的应用和跳过。
  - WH-AC12 的正向和反向权限。
  - 权限检查函数：对正确的角色返回 ok；对 scraper、owner 角色，以及额外授权后的测试角色，都判定为“权限过大”。
- **规则单元测试：** 字段校验、District / Station 校验、`address_key` 规范化、离 District 距离判断、Unknown District 的投影。
- **geocoder 测试（mock fetch）：** 成功、0 个匹配、多个匹配、超时、5xx、格式错误、响应超大、节流。
- **API 测试：**
  - CRUD 完整流程。
  - 确认流程。
  - 写入防护的各种拒绝情况。
  - 写入功能关闭时返回 405。
  - 返回字段白名单。
  - 现有只读路由仍然只接受 GET。
- **Web 测试（沿用 `route-map-web.test.js` 的 fake DOM 写法）：**
  - 图层按 District 加载。
  - Station、DSP 和选择变化时图层不变。
  - popup 内容。
  - 点击 marker 不清除选择。
  - 保存后 focus 并高亮。
  - 删除确认文案。
  - 失败时保留输入、出现手动坐标区域。
  - 1440 和 390 的 CSS 规则检查。
- `npm test` 全部通过。没有配置 DB 测试变量时，DB 测试按现有 `dbSkip` 规则跳过，并在报告中说明。

## 9. 风险与安全

- **写入范围（D18）：** 只有能操作公用电脑本机的人，才能通过 3100 修改或删除仓库，局域网其他电脑只能查看。删除仍然无法恢复（D15），数据库备份见 CD-Q4。
- **外部服务：** 3000 会对外请求 `geocoding.geo.census.gov`。发送的内容只有仓库地址，不带身份信息。Census 不可用时只影响新增仓库和修改地址，可以手动输入坐标兜底。
- **Census 精度：** 坐标按门牌区间插值，可能偏差几十到几百米。保存后自动 focus 并显示标准化地址，就是为了方便用户核对。
- **注入风险：** 名称和地址是用户输入，前端一律用 `textContent` 显示，服务端使用参数化 SQL。

## 10. 对现有功能的影响

- （D18）3000 **保持真正只读**，只通过 reader 读取 `v_warehouses`。仓库写入只在 3100（公用电脑本机）上进行。`central-db.md` 角色表新增 `nc_warehouse`，只给 Worker 使用。
- `readonly.env` **不包含** warehouse 相关变量。repo 的 `.env` 新增 `NC_DB_WAREHOUSE_URL`（3100 使用）和 `NC_TEST_DB_WAREHOUSE_URL`。`.env.example` 只写变量名。
- `docs/deployment.md` 增加：建角色步骤、migration 003、新环境变量、对外请求 Census 的隐私说明（D13）、重启服务。
- `docs/data-schema.md` 增加 `warehouses` 表。
- 不改动 P3 刷新架构、DMS、route 表和视图、防火墙规则或端口。

## 11. 任务拆分

| 任务 | 内容 | 执行 |
|---|---|---|
| **T0 环境准备（2026-10-09 已完成）** | 用 `nc_admin` 创建 `nc_warehouse` 和 `nc_test_warehouse` 两个 LOGIN 角色，分别只有 `nc_ops` 和 `nc_ops_test` 的 CONNECT 权限。随机密码保存到 `secrets\`。连接串写入 `.env` 和 `readonly.env`，不显示内容。**不执行** 正式库 migration。 | Claude，需要 Product Owner 批准（涉及 secrets） |
| **WH-T1 DB** | migration 003、`migrate.js` 占位符和 `warehouseRole` 参数、`db-migrate` CLI、test helper（`dbSkip` 和角色身份校验加入 WAREHOUSE）、`checkWarehousePrivileges()`，以及 DB 测试（WH-AC12、权限检查部分） | Codex |
| **WH-T2 API** | `server/src/warehouses/` 四个模块、`readWarehouses()`、路由挂载（`app.js`、`server.js`、`worker.js`）、capabilities、启动检查（WH-AC13）、`.env.example` 和 deployment 文档；测试覆盖 WH-AC7–16 的服务端部分 | Codex |
| **WH-T3 前端** | `warehouse-layer.js`、`warehouse-panel.js`、接入 `map.js`、`map.html`、`map-text.js`、`styles.css`；测试覆盖 WH-AC1–6、9、17、18 的前端部分 | Codex |
| **WH-T4 权限收回（D18）** | 把写入入口收回到 3100：3000 不加载 warehouse 凭据，局域网模式下出现该变量就拒绝启动；删除 `WAREHOUSE_ALLOWED_HOSTS`；前端按 capabilities 隐藏管理入口；补齐 WH-AC20 的测试；更新文档 | Codex |
| **部署** | 对正式库执行 `npm run db:migrate`，重启服务，然后在 3100 本机和 3000 局域网各验证一次（3000 只读） | Claude，部署前需要 Product Owner 批准 |

每个 Codex 任务都按 `CLAUDE.md` 第 5 节 review，最多修两轮。WH-T3 完成后由 Product Owner 预览签字。

## 12. 未决问题

见 `docs/open-questions.md` 的“仓库管理”一节。WH-Q1–WH-Q3 已于 2026-10-09 解决。

## 13. 实现记录

### WH-FIX1 — 2026-10-09（Codex）

- `map.js` 移除仓库静态 import，使用可注入的动态模块加载器和初始 no-op 适配对象。模块及构造失败只隐藏仓库入口并显示“仓库信息暂时无法加载”，不改变主地图状态；入口在模块就绪前禁用。
- 主地图不等待仓库请求。独立保存最近的加载 promise，仅成功且未过期时记录已加载 District；查看仓库和保存后定位继续等待图层。空数组和非 JSON 的现有 layer / panel 防御逻辑无需修改。
- 新增 brief 要求的七类测试，并额外覆盖 panel 构造失败及非 JSON。现有仓库测试仅机械性增加异步等待和更新错误文案断言；共享地图 fixture 增加加载器注入及预加载模块，以稳定原有测试的模块时序。
- 验证：`npm.cmd test` 553 项通过，0 失败、0 跳过；`node --check web/map.js` 和 `git diff --check` 通过。完整测试输出：`.handoff/wh-fix1-test.log`。未配置 lint / build script。
- 使用 Playwright 访问现有 `http://localhost:3000/map`：仓库模块均返回 404 时，District / Station 有选项、DSP 可用、Leaflet 地图存在、主地图结束 loading；仓库入口隐藏并显示指定提示，无 `pageerror`。未重启服务、运行 DMS、部署或改动凭据。Product Owner 预览签字仍待完成。

### WH-T3 Review 第 1 轮 — 2026-10-09（Codex）

- F1：静态资源白名单仅补入 `warehouse-layer` 和 `warehouse-panel`。新增真实 HTTP 测试检查 200 / JavaScript content type，并解析三个地图模块的相对 import，检查白名单覆盖。
- F2：保存到当前片区后先关闭管理面板，再调用 `onSaved` 刷新、定位和高亮。识别地址及同名提示用 `textContent` 写入独立的 `#map-warehouse-notice`，不受图层错误提示清空影响；打开面板或切换 District 时清除。非当前片区保存、查看仓库及删除流程保留原行为。
- F3：`loadStation()` 仅在仓库图层加载成功时记录已加载片区；失败后切换 Station 可重试，成功后继续复用图层。新增 503 → 重试成功 → 不再请求的回归测试。
- 现有 `route-map-web.test.js` 仅机械性增加页面提示元素的 fake DOM ID；本轮未修改 `map-view.js`、数据结构或需求和验收标准。1440 / 390 的布局由既有 CSS 规则测试覆盖，实际浏览器预览仍由后续 review / Product Owner 签字确认。
- 验证：`npm.cmd test` 全部 543 项通过，0 失败、0 跳过；针对性测试 40 项通过；语法检查和 `git diff --check` 通过。PowerShell 的 `npm.ps1` 被执行策略拦截，因此使用 `npm.cmd` 执行同一 test script。完整输出保存在 `.handoff/wh-t3-review1-test.log`。

### T0 — 2026-10-09（Claude）

- **角色：** 用 `nc_admin` 创建了两个角色：
  - `nc_warehouse`：只有 `nc_ops` 的 CONNECT 权限。
  - `nc_test_warehouse`：只有 `nc_ops_test` 的 CONNECT 权限。
  - 两者的属性都是 LOGIN、NOSUPERUSER、NOCREATEDB、NOCREATEROLE、NOINHERIT、NOREPLICATION、NOBYPASSRLS。
- **密码：** 128 bit 随机值，写入 `%LOCALAPPDATA%\nc-ops-console\secrets\` 下的 `nc_warehouse.txt` 和 `nc_test_warehouse.txt`，文件 ACL 只授予当前用户。创建角色时，会话关闭了出错语句的日志记录；检查过 `postgres.log`，里面没有相关记录。
- **连接串：**
  - repo 的 `.env` 新增 `NC_DB_WAREHOUSE_URL` 和 `NC_TEST_DB_WAREHOUSE_URL`。
  - `readonly.env` 新增 `NC_DB_WAREHOUSE_URL`。
  - 现有代码不读取这两个变量，运行中的服务不受影响。
- **验证：**
  - 两个角色都能登录各自的库。
  - 都不是 superuser，没有角色成员关系，不拥有任何对象。
  - 数据库的 CREATE 和 TEMP 权限为 false，CREATE TEMP TABLE 被拒绝（42501）。
  - 对 `nc` schema 没有 USAGE 权限。
  - 跨库连接被拒绝（42501 permission denied for database）。
- 没有执行任何 migration。

### WH-T1 — 2026-10-09（Codex 实现，Claude review 通过）

- **第 0 轮：** Codex 发现 brief 中有三处说法不一致，停下来提问，没有改动任何文件。三处分别是：`npm test` 会加载 `.env`；CD-AC30 不允许跳过；migration 测试写死了版本号。
- **第 1 轮：** Claude 澄清后，Codex 完成实现。
- **新增：** `server/db/migrations/003_warehouses.sql`、`server/src/warehouses/warehouse-privileges.js`、`server/test/warehouse-db.test.js`。
- **修改：** `migrate.js`（新增 `warehouseRole` 参数和 `{{warehouse_role}}` 占位符）、`db-helpers.js`（`dbSkip` 和测试角色加入 WAREHOUSE）、`refresh-migration.test.js`（版本断言扩展到 003）、`freshness.test.js`、`server/test/index.js`、`docs/data-schema.md`。
- **CD-AC30 的修复：** 原测试写死了 `2026-10-09T00:00:00Z`，从 2026-10-09 起，导入 run 的时间晚于这个值，排序反了。现改为相对 `now()` 的时间。只改了测试数据，断言没有放宽。
- **Claude 本机验证：** `npm test` 498 项全部通过（0 失败、0 跳过）；001 和 002 没有变化；测试库中没有残留的临时 schema。
- **正式库：** 还没有执行 migration 003，留到部署步骤。

### WH-T2 — 2026-10-09（Codex 实现，Claude review 第 1 轮后通过）

- **第 0 轮（第一次）：** brief 中把“错误响应不含地址”误写成了“响应中没有地址”。Codex 发现后停止，没有改动文件。Claude 修正措辞后重新运行第 0 轮。
- **新增：** `server/src/warehouses/` 下的 `warehouse-rules.js`、`geocoder.js`、`warehouse-store.js`、`warehouse-api.js`、`warehouse-setup.js`，以及 5 个 `warehouse-*.test.js` 测试文件。
- **修改：**
  - `server/src/api/server.js`：始终挂载 `/api/warehouses`，注入 `getDistrictExtent`，capabilities 增加 `warehouse_write`。
  - `server/bin/server.js`、`server/bin/worker.js`、`server/src/worker/worker.js`：两个服务共用 setup 和分级启动检查。
  - `db-data-source.js`：新增 `readWarehouses`、`checkReaderWarehouseIsolation`。
  - `data-source.js`：json 数据源下读取仓库返回 503。
  - `run-service.ps1`：清除继承的 `WAREHOUSE_*` 环境变量。
  - 文档：`.env.example`、`docs/deployment.md`（包含 Census 隐私说明）。
  - 测试：`capabilities` 相关的现有测试做了机械性更新。
- **Review 第 1 轮修复：**
  - R1：district map 数据有错误时，`getDistrictExtent` 返回 null，跳过距离判断，不阻断保存；数据库不可用时仍返回 503。
  - R2：Host 白名单、Host 头和 Origin 比较都忽略大小写。
  - R3：名称重复提示按 `lower(btrim())` 比较。
  - R4：局域网启动日志如实显示“仓库可写”。
- **Claude 本机验证：** `npm test` 525 项全部通过（0 失败、0 跳过）。

### WH-T4 — 2026-10-09（D18 权限收回；Codex 实现，Claude review 通过）

- **3000：**
  - `server/bin/server.js` 不再调用仓库 setup，也不读取或连接 `NC_DB_WAREHOUSE_URL`。
  - 局域网模式下出现这个变量时，和 scraper、owner、DMS 配置一样，拒绝启动。
  - 仍然执行 reader 隔离检查。启动日志恢复为“（局域网只读）”。
- **3100：** `warehouse-setup.js` 删除 `lan` 分支和 `WAREHOUSE_ALLOWED_HOSTS`，白名单固定为 loopback；分级启动检查不变。
- **前端：** `map.js` 先创建 marker 图层，再查询 `/api/capabilities`。只有 `warehouse_write === true` 时，才创建管理面板并显示“管理仓库”。capabilities 请求失败时按只读处理，不显示错误。`map.html` 中的按钮默认 hidden。
- **文档：** `.env.example`、`docs/deployment.md`、`central-db.md` 角色表已更新，角色表新增 `nc_warehouse` 和 `nc_test_warehouse`，只给 Worker 使用。
- **测试：** 新增 3000 只读用例（GET 200；写方法返回 405 并带 `Allow: GET`；本机模式不调用 setup；局域网模式出现凭据就拒绝启动），3100 CRUD 和非 loopback Host 返回 403，Route、ZIP、DMS 各路径的写方法都被拒绝，以及前端入口按 capabilities 显示。
- **Claude 本机验证：**
  - `npm test` 576 项全部通过（0 失败、0 跳过），`git diff --check` 通过。
  - 除本 spec 外，代码、测试和文档中已经没有 `WAREHOUSE_ALLOWED_HOSTS`；`readonly.env` 中没有 warehouse 凭据。
  - 在临时只读预览服务（127.0.0.1:3300，行为与 3000 相同，仓库数据为模拟数据）上做了浏览器冒烟测试：
    - capabilities 中 `warehouse_write` 为 false；POST、PATCH、DELETE 都返回 405，并带 `Allow: GET`。
    - 页面上 marker 和 popup 正常；“管理仓库”按钮隐藏，也没有创建面板；console 没有任何消息。
- **尚未验证：** 3100 的真实 CRUD 需要正式库先执行 migration 003，留到部署步骤。

### WH-FIX2 — 2026-10-09（图例溢出；Codex 实现，Claude review 通过）

- `web/styles.css` 新增 `.warehouse-legend .warehouse-legend-icon { position: static; margin: 0 !important; ... }`，覆盖 Leaflet `createIcon()` 带来的绝对定位和负 margin。marker 样式没有改动。新增一项 CSS 规则测试。本机 `npm test` 577 项全部通过。

### 部署 — 2026-10-09（Product Owner 批准：migration 003、重启服务、真实 CRUD 验证）

- `npm run db:migrate`：001、002 skipped，003 applied。在正式库上用真实账号检查：`checkWarehousePrivileges` 为 ok，`checkReaderWarehouseIsolation` 为 ok。
- `stop-services.ps1`（不带 `-Force`，PostgreSQL 保持运行）后执行 `Start-ScheduledTask 'NC Ops Console Services'`。结果：
  - 3100 只监听 127.0.0.1，日志中没有“仓库写入未开启”。
  - 3000 监听 0.0.0.0，日志显示“（局域网只读）”。
  - `readonly.env` 中没有 warehouse 凭据。
- **边界验证：**
  - capabilities：3100 为 `warehouse_write: true`；3000 无论通过 127.0.0.1 还是局域网 IP 访问，都是 false。
  - 3100 无法通过局域网 IP 连接（connection refused）。
  - 3000 两个地址的仓库 POST、PATCH、DELETE 都返回 405 并带 `Allow: GET`；Route、ZIP、DMS 各接口的 POST 返回 405（`/api/refresh*` 在 3000 上不存在，返回 404）。
- **3100 真实 CRUD（API，真实调用 Census）：**
  - 新增：201，Census 识别为 `6015 GIANT HWY, RICHMOND, CA, 94806`。
  - 局域网 3000 能读到这条仓库。
  - 相同地址再次新增：409 `duplicate_address`。
  - 只改名称：200，没有调用 Census。
  - 使用过期的 `expected_updated_at`：409 `warehouse_changed`。
  - 选不属于该片区的 Station：400 `station_not_in_district`。
  - 删除：204，局域网 3000 上随即消失；再次删除：404。
- **浏览器验证：**
  - 3100：显示“管理仓库”，面板中有“添加仓库”，图例图标在框内并垂直居中。
  - 局域网 3000：marker 和 popup 正常，不显示“管理仓库”，没有创建面板，console 没有任何消息。
  - 浏览器中没有点击删除按钮（会弹出原生 confirm），删除已在 API 层验证。
- 两条测试仓库都已删除，正式库 `warehouses` 为 0 行。没有运行 DMS。
- **待完成：** Product Owner 预览签字（WH-T3 前端交互、390 宽度）。
