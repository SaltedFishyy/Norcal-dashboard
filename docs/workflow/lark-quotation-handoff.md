# Lark 配置交接信息（报价表只读同步）

用途：发给协助操作 Lark 开发者后台的 ChatGPT / 管理员。对应功能方案：`docs/features/lark-quotation-sync.md`。
**本文不含、也不要求提供任何凭据**（App Secret、access token、密码、Cookie）。凭据只由用户在公用电脑本机 `.env` 中填写，不要粘贴到任何聊天。

标记说明：**[已验证]** = Claude 2026-11-06 实际核对过；**[待验证]** = 需要有权限的人在后台或用真实凭据确认；**[据 ChatGPT]** = 来自 ChatGPT 的后台检查，Claude 未核对。

---

## 1. 最终架构

- **只需要后端定时调用 Sheets 读取接口**，使用应用身份 `tenant_access_token`，只读。
- **不需要**：机器人程序、消息事件订阅（`im.message.receive_v1`）、事件回调地址、长连接。理由：需求是 Dashboard 主动拉取表格数据，不接收 Lark 推送，也没有聊天交互。
- 后台现有的「长连接 Connection failed」是因为没有程序在线监听，与本功能无关，**不需要修复**。
- 机器人能力：本方案的授权方式（第 4 节方式 1「添加文档应用」）**不依赖机器人能力** [据官方 FAQ，见第 2 节链接]。已启用的机器人能力可保留，不需要为本功能再做任何设置。

## 2. 应用类型、域名与官方文档

- 应用类型：企业自建应用（custom app）「聪明小K」，App ID `cli_aa60a32dbff89c16` [据 ChatGPT；App ID 不是密钥]。
- 开发者后台域名：`open.larkenterprise.com` [据用户提供的后台链接]。
- **API 域名：`https://open.larkenterprise.com/open-apis/...`**
  - [已验证] 该域名的 `open-apis` 可访问：不带凭据调用 `POST /open-apis/auth/v3/tenant_access_token/internal` 返回 `{"code":10003,"msg":"invalid param"}`；不带 token 调用 `GET /open-apis/sheets/v3/spreadsheets/<token>/sheets/query` 返回 HTTP 400、`code 99991661 Missing access token`，即标准 Lark 开放平台响应。
  - [待验证] 用本应用真实 App ID / Secret 在该域名取得 token 成功（因为应用注册在 larkenterprise 后台，应使用同一域名；不要换成 open.larksuite.com 或 open.feishu.cn）。
  - 注意：larkenterprise 文档站页面标题为 Feishu Open Platform，文档示例 URL 写的是 `open.feishu.cn`；实际调用请把域名替换为 `open.larkenterprise.com`。
- 官方文档（larkenterprise 文档站）：
  - 读取单个范围（Sheets v2）：https://open.larkenterprise.com/document/ukTMukTMukTM/ugTMzUjL4EzM14COxMTN
  - 获取工作表列表（Sheets v3 query）：https://open.larkenterprise.com/document/server-docs/docs/sheets-v3/spreadsheet-sheet/query
  - 申请 API 权限：https://open.larkenterprise.com/document/ukTMukTMukTM/uQjN3QjL0YzN04CN2cDN
  - 云文档常见问题（如何让应用访问文档）：https://open.larkoffice.com/document/ukTMukTMukTM/uczNzUjL3czM14yN3MTN （同一内容的 Feishu/Lark 文档站版本；larkenterprise 对应页面 [待验证]）

## 3. 最小权限

| 项 | 值 |
|---|---|
| 精确 scope | **`sheets:spreadsheet:readonly`** [已验证：读取范围与工作表查询两个接口的文档均列为可选权限之一] |
| 后台显示名称 | 中文约为「查看、评论和导出电子表格」 [已验证：文档描述；后台实际文字 [待验证]] |
| 令牌类型 | `tenant_access_token`（应用身份）。在后台权限管理的**应用身份权限**页签申请，不是用户身份页签 |
| 不需要 | `sheets:spreadsheet`（编辑）、`drive:drive`、`drive:drive:readonly`（范围更大）、任何消息 / 机器人 / 通讯录权限 |
| 是否需要发布 | 免审权限申请后立即生效；需审核权限需要「创建版本并提交审核」，管理员通过后生效 [已验证：官方权限文档]。该 scope 在本租户是否免审 [待验证：后台权限条目上会标注] |
| 管理员审批 | 仅当该 scope 被标为需审核时需要租户管理员审批 [已验证规则；本租户情况 待验证] |

## 4. 让应用访问这张表格

应用有 API 权限 ≠ 能读这张表。还必须让应用成为**该表格的协作者**。

**方式 1（推荐，不需要机器人）**：[已验证：官方 FAQ 描述]

1. 前提：应用已开通至少一个云文档 API 权限（即第 3 节的 scope），且已发布版本的**可用范围包含该表格的所有者**；否则搜索不到应用。
2. 由表格所有者或有管理权限的协作者打开表格 → 右上角「…」→「…更多」→「添加文档应用」。
3. 搜索「聪明小K」并添加，权限选**可阅读**（只读即可）。

**方式 2（备选，需要机器人能力）**：把应用作为机器人（不是「自定义机器人」）加入一个群，再把表格分享给该群（可阅读）。

**数据访问范围**：官方文档说明部分接口使用 tenant_access_token 时需要配置「可访问的数据范围」；云文档是否也需要在后台单独配置 [待验证]。如果后台权限条目要求配置数据范围，按最小范围配置并记录。

## 5. 表格定位信息

| 项 | 值 | 状态 |
|---|---|---|
| spreadsheet token | `Wa9VsDiaphLSA3tpWzrcvp5lnAh` | 从链接 `/sheets/<token>` 解析 [已验证解析]；可读性 [待验证] |
| 工作表 ID | `iwYw5J` | 从链接参数 `?sheet=` 解析 [已验证解析]；需用工作表查询接口确认存在 [待验证] |
| 工作表标题 / 行数 / 冻结行数 | — | [待验证]：工作表查询接口返回 `title`、`grid_properties.row_count`、`frozen_row_count` |
| 表头行位置 | — | [待验证]。参考：同类 xlsx 模板「新OA报价模板」表头在第 1 行、数据从第 2 行开始；Lark 表格不一定相同 |
| 读取范围 | 建议 `iwYw5J!A1:<最后一列><row_count>` | [待验证]：列数与行数确认后再定 |
| 日期返回格式 | — | [待验证]：读取接口的 `dateTimeRenderOption` 等参数对结果的影响，用一次真实读取确认 |

## 6. 字段映射

以下按同类 xlsx 模板（22 列，A–V）整理；**Lark 表格的实际列名和列位置全部 [待验证]**，截图中 DSP 列名为「转运中心/DSP」，与模板「车队名称/Fleet」不同。程序将按**表头文字**定位列，不按固定列号。

| 模板列 | 模板表头 | 程序字段 | 用途 |
|---|---|---|---|
| A | 站点名称 / Station | `station_label_raw` | 只存原值，不用于匹配 |
| B | 车队名称 / Fleet（Lark：转运中心/DSP？） | `fleet_name` | 只存原值；与 DMS DSP 不一致只警告 |
| C | 线路名称 / Route | `route_name` → `route_id` | 精确匹配 DMS 当前线路 |
| D | 邮编 / Zipcode | `postal_code` | 与 `route_id` 组成报价键 |
| E | 参考邮编（唯一值） | `reference_postal_code` | 只存原值 |
| F–L | 首票价格 0-1 / 1-5 / 5-10 / 10-20 / 20-30 / 30-40 / 40(lb)以上 | `first.0_1` … `first.40_plus` | 地图 / 主表只用 `0_1`；详情显示全部 |
| M–S | 续票价格 同上 7 段 | `additional.*` | 只在详情显示 |
| T | 报价生效日期 | `effective_from` | 当前价格判断 |
| U | 报价结束日期 | `end_date`（含当天；空 = 长期） | 当前价格判断 |
| V | 备注 | `remarks` | 详情显示 |

## 7. 环境变量（只在公用电脑 repo 根目录 `.env`，已 gitignore）

```text
LARK_OPEN_API_BASE=https://open.larkenterprise.com
LARK_APP_ID=<在本机 .env 填写>
LARK_APP_SECRET=<在本机 .env 填写；不要发到聊天、不要截图>
LARK_QUOTATION_SPREADSHEET_TOKEN=<表格 token>
LARK_QUOTATION_SHEET_ID=<工作表 id>
LARK_QUOTATION_SYNC_MINUTES=0
NC_DB_QUOTATION_URL=<写入角色连接串，由管理员创建角色后填写>
```

不放进 `readonly.env`（局域网只读服务），不放进前端、日志或 Git。App Secret 在开发者后台「凭证与基础信息」查看，由用户自己复制到本机 `.env`。

## 8. 回调 / 长连接

**不需要。** 不需要回调地址、事件清单、长连接运行命令。建议删除或不发布已添加但未发布的 `im.message.receive_v1` 事件，保持应用权限最小。

## 9. 最小读取验证

在 LQ-T0 完成后，由用户在公用电脑运行实现阶段提供的只读检查命令（计划名 `npm run quotes:lark-check`，LQ-T3 实现；实现前也可由有权限的人在开发者后台 API 调试台用应用身份调用同样两个接口）：

1. 取 token：`POST /open-apis/auth/v3/tenant_access_token/internal`。
2. 查工作表：`GET /open-apis/sheets/v3/spreadsheets/Wa9VsDiaphLSA3tpWzrcvp5lnAh/sheets/query`。
3. 读表头：`GET /open-apis/sheets/v2/spreadsheets/Wa9VsDiaphLSA3tpWzrcvp5lnAh/values/iwYw5J!A1:Z3`。

**成功标志**：第 1 步 `code 0`；第 2 步 `code 0` 且列表中有 `sheet_id = iwYw5J`；第 3 步 `code 0` 且返回的表头与第 6 节列名一致。

**故障区分**（以返回的 `code` / `msg` 原文为准，以下为判断思路）：

| 现象 | 可能原因 |
|---|---|
| 第 1 步失败 | App ID / Secret 错误，或域名不对（必须用 larkenterprise） |
| 第 2 步提示需要某些 scope / 权限不足 | `sheets:spreadsheet:readonly` 未开通、未发布或未审核通过 |
| 第 2 步 HTTP 403 / 无文档权限（不提 scope） | 应用未被添加为该表格协作者（第 4 节） |
| 第 2 步成功但没有 `iwYw5J` | 工作表 ID 不对或该工作表已删除 / 改名后链接失效 |
| 第 3 步成功但表头不一致 | 表头不在第 1 行、列名不同或有合并单元格 |

## 10. 后台操作清单

| # | 操作 | 状态 | 由谁 |
|---|---|---|---|
| 1 | 机器人能力已启用 | 已完成 [据 ChatGPT] | — |
| 2 | 已有收发消息、Base 等权限 | 已完成 [据 ChatGPT]；本功能不需要 | — |
| 3 | 应用身份权限页签开通 `sheets:spreadsheet:readonly`，记录是否免审 | 待做 | ChatGPT（云浏览器） |
| 4 | 删除或不发布 `im.message.receive_v1`；事件订阅方式无需配置 | 待做（建议） | ChatGPT |
| 5 | 创建版本，可用范围包含表格所有者；提交发布 | 待做 | ChatGPT 提交；如需审核由管理员通过 |
| 6 | 管理员审批（仅当 scope 需审核） | 视情况 | 租户管理员 |
| 7 | 表格「添加文档应用」→ 聪明小K → 可阅读 | 待做 | 表格所有者 / 有管理权限的协作者 |
| 8 | 确认后台是否要求配置数据访问范围 | 待验证 | ChatGPT |
| 9 | 在公用电脑 `.env` 填写第 7 节变量（Secret 不经聊天） | 待做 | 用户本人 |
| 10 | 记录工作表标题、行数、表头行、日期格式（第 5 节） | 待做 | 第 9 节验证后由 Claude 整理 |

任何修改应用权限、发布版本的操作都需要用户本人执行或明确批准。

## 11. 需要用户确认的问题 / 开始实现前缺少的信息

业务问题见 `docs/open-questions.md`「Lark 报价同步」（LQ-Q1 至 LQ-Q8），重点：

1. 表格是**完整的当前报价总表**，还是**变更记录**？表格中删除 / 修改一行时，Dashboard 是否应同步作废旧报价？（决定同步语义）
2. 主界面显示范围：2026-11-05 已决定（RQ-D9）**地图 hover 和线路档案只显示 0–1 lb 首票**，其他首票重量档和续票只在价格详情显示。是否维持？
3. 价格 0 是否是合法报价？
4. 同步频率（建议每 60 分钟，默认关闭，确认后开启）。

开始实现前仍缺：第 5 节全部待验证项（真实表头、列位置、日期格式、行数）；测试库 `nc_test_quotation` 角色（管理员创建）；Product Owner 对 LQ-Q1、LQ-Q2 的回答。
