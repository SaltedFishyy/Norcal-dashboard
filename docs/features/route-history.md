# 线路历史（Route History，RH）

状态：**Approved**（Product Owner 2026-11-11 批准需求与方案；**尚未授权进入实现**）

## 1. 目标

在线路档案中查看每条 Route 最近 7 天 / 30 天的数据变化：当前值、最高、最低、平均和简单趋势。

## 2. Product Owner 决定（2026-11-11）

| # | 决定 |
|---|---|
| H1 | 指标：`pickup_volume`（领件量）、`pph`、`first_mile_distance`、ZIP 数量。另外标出难度、DSP、ZIP 集合的变化（只标记，不计算统计值）。 |
| H2 | 时间窗口：最近 7 天 / 30 天，可切换。 |
| H3 | 数据保留：**全部保留**，不清理。一年后（或 DB 超过约 1 GB 时）再决定保留规则。 |
| H4 | 取代 `docs/features/dms-refresh.md` 第 0 节“不做历史分析”的规则（该文件已加注）。 |

## 3. 现状（Claude 2026-11-11 检查）

- 历史数据**已经存在**：每次刷新为每个 Station 写入一个新 snapshot；被替换的 snapshot 状态为 `superseded`，没有删除。`snapshot_routes.profile`（jsonb）保存每条 Route 的完整画像。
- 规模：DB 约 19 MB；`snapshot_routes` 2,156 行、533 个不同的 `route_id`；从 2026-10-07 起约 9 个刷新日。数据点不连续（只有手动刷新的日子才有）。AR 上线后每天一个点。
- 只读服务（reader 角色）只能读视图；现有视图只暴露 active 数据，所以需要新视图。
- 前端：线路档案表格点击 Route 打开 `web/route-detail.js` 的 `#route-detail` 弹窗。
- `DATA_SOURCE=json` 模式没有历史数据。
- D6（`docs/open-questions.md`）：`pickup_volume` 的统计窗口仍不确定。历史中只显示原值，标签用“领件量”，不叫 Daily Volume。

## 4. 方案

### 4.1 数据：migration 008 中的视图（与 AR 合并）

- 新视图 `nc.v_route_history_daily`：对每个 Station、每个 **Pacific 日期**（按 snapshot 的 `captured_at` 换算 `America/Los_Angeles`），取当天最后一个 `active` 或 `superseded` 的 snapshot；`pending` / `rejected` 不算。每行一条 Route：`day`、`station`、`route_id`、`route_name`、`dsp_name`、`pickup_volume`、`pph`、`first_mile_distance`、`zip_count`（`postal_codes` 数组长度）、`route_difficulty`、`postal_codes`（用于判断 ZIP 集合变化）、`snapshot_id`。
- 数值从 `profile` jsonb 中取，非数值为 null。
- 索引：`snapshot_routes(route_id)`（如果已有等价索引则不重复建）。
- `GRANT SELECT` 给 reader。
- 具体的列名以 `docs/data-schema.md` 和实际 migration 为准；Codex 写 migration 时同步更新 `docs/data-schema.md`。

### 4.2 API（只读服务）

- `GET /api/route-profiles/<route_id>/history?days=7|30`（默认 7；其他值返回 400）。
- 以 `route_id` 为键。返回：`{ route_id, days, points: [{ day, route_name, station, dsp_name, pickup_volume, pph, first_mile_distance, zip_count, route_difficulty }], changes: [{ day, field, from, to }], first_seen, last_seen, former_names: [] }`。`changes` 只覆盖难度、DSP、ZIP 集合（ZIP 集合只给增减数量，不返回完整列表）。
- 统计值（当前 / 平均 / 最高 / 最低 / 趋势）由前端计算，API 只返回数据点，规则只写一处（前端纯函数，可单元测试）。
- `DATA_SOURCE=json` 时返回 `{ available: false }`，前端显示“当前数据源不支持历史”。
- 数据读取放在 `db-data-source.js` 一侧（数据访问层），API 路由只做参数校验和输出。

### 4.3 前端：线路详情弹窗新增“历史”标签

- 弹窗顶部增加“概况 / 历史”切换（现有内容为“概况”，默认打开概况，不改动现有内容）。
- 历史页：
  - 7 天 / 30 天切换。
  - 4 个指标卡：当前值、平均、最高、最低、趋势。
  - 每个指标一个小折线图（inline SVG，不新增依赖）；缺少数据的日子断开，不插值。
  - 变化标记：难度、DSP、ZIP 集合变化的日子在图上标点，下方列出“10/21 难度 3 → 4”之类的文字。
  - 覆盖说明：“30 天中有 N 天数据”。
- 统计规则：
  - **当前** = 窗口内最近一个数据点（不一定是今天，显示日期）。
  - 平均 / 最高 / 最低 只用非 null 值。
  - **趋势** = 当前值相对窗口平均值的变化百分比；绝对值 ≤ 5% 显示“持平”；数据点少于 3 个时不显示趋势，显示“数据不足”。
- Route 变化：
  - 改名：显示当前名称，下方写“曾用名：…”。
  - 已消失（窗口内最后一次出现早于最新刷新）：显示“最近一次出现：<日期>”。
  - 新 Route：显示“已有 N 天数据”。
- 不新增前端文件、import 路径或依赖（现有静态白名单）；如果确实需要新文件，Codex 先说明，由 Claude 决定是否更新白名单。

## 5. 验收标准

- **RH-AC1** migration 008 在测试库上可以重复执行（幂等或有版本保护），reader 能读新视图、不能读底层表；正式库执行前备份（停止条件，需 Product Owner 确认）。
- **RH-AC2** 视图对每个 Station 每个 Pacific 日只取一个 snapshot（当天最后一个 active / superseded），不包含 pending / rejected；跨 UTC 午夜的时区换算有测试。
- **RH-AC3** API 参数校验（days 只接受 7 / 30，route_id 格式校验）；不存在的 route_id 返回空 points，不报错；JSON 模式返回 `available: false`。
- **RH-AC4** `changes` 正确标出难度、DSP、ZIP 集合变化；改名进入 `former_names`。
- **RH-AC5** 统计函数（当前 / 平均 / 最高 / 最低 / 趋势、±5% 持平、少于 3 点不显示趋势、null 跳过）有单元测试。
- **RH-AC6** 历史页显示 7 / 30 天切换、4 个指标卡、折线图（缺口断开）、变化标记、覆盖说明；概况页现有内容和行为不变。
- **RH-AC7** 窄屏（390px）可用，无横向滚动；中文文案。
- **RH-AC8** 用 30 天的 533 条 Route 级数据量测试，API 响应 < 500 ms（本机）。

## 6. 任务拆分

| 任务 | 内容 | 授权 |
|---|---|---|
| DB-T1 | migration 008（与 AR 合并，见 `auto-refresh.md`）| 实现授权；正式库执行另需确认 |
| RH-T1 | 数据访问 + API + `changes` / `former_names` + 测试 | 实现授权 |
| RH-T2 | 弹窗“历史”标签 + 统计纯函数 + 图表 + 测试 | 实现授权；UI 预览签字 |
| RH-T3 | 线路档案表格增加“7 天趋势”列 | **另行授权** |

推荐顺序：DB-T1 → AR-T1..T3 → RH-T1 → RH-T2。RH 不依赖 AR 也能做（已有约 9 天的历史），但 AR 上线后数据才连续。

## 7. 实现记录（Implementation Notes）

（待填写）
