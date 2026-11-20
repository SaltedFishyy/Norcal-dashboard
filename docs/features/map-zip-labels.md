# 线路地图：显示面板与邮编标注 / Map Display Panel and ZIP Labels

- 状态：**Approved**（需求已确认，Product Owner 2026-11-19 “可以，你弄吧”）；实现授权同日；**Done**（T1–T4 已实现，全套 962 项测试通过；Product Owner 2026-11-20 “提交并发布”）
- 关联：`docs/features/route-map.md`、`docs/features/map-visual-refresh.md`、`docs/features/map-price-color.md`
- 编号前缀：MZL

## 1. 目标

在线路地图上加“显示邮编”开关：打开时在每个 ZIP 区块上标出 5 位邮编，关闭时隐藏。开关不绑定颜色模式，按线路 / DSP / 站点 / 难易度 / 价格都能用。同时把现有“显示线路编号”开关挪到同一个通用“显示”面板，并让线路编号也在所有颜色模式下可用。

## 2. 已确认的规则（Product Owner 2026-11-19）

| 编号 | 规则 |
|---|---|
| MZL-D1 | 新建通用“显示”面板（Leaflet control，右上，颜色模式按钮下方、图例上方），任何颜色模式下都在。面板里有两个开关：“线路编号”“邮编”。 |
| MZL-D2 | “显示线路编号”开关从图例移到显示面板；线路编号在**所有颜色模式**下都可显示（不再只在“按线路”时出现）。沿用现有 localStorage key `nc-ops-map-route-labels`、默认开。 |
| MZL-D3 | “显示邮编”默认**关**，记住每个人的选择（localStorage key `nc-ops-map-zip-labels`；存储不可用时用内存值）。 |
| MZL-D4 | 邮编按缩放和防重叠显示：缩小时少显示或不显示，放大后逐步显示全部；不保证任何缩放下都全部显示。 |
| MZL-D5 | 选中线路时，只显示这条线路的邮编。 |
| MZL-D6 | 两个都开时，线路编号优先放置，邮编避让线路编号。 |
| MZL-D7 | 只改前端：不改数据、API、store、schema。 |

Claude 暂定（PO 预览时可改）：

| 编号 | 规则 |
|---|---|
| MZL-D8 | 邮编最小缩放级别 `ZIP_LABEL.minZoom = 10`（可配置常量）；低于此级别不显示邮编。 |
| MZL-D9 | 选中站点 / DSP 筛选时，范围外（`outside`）和淡化（`dimmed`）的 ZIP 不显示邮编。 |
| MZL-D10 | 样式：比线路编号小一号、半透明深色胶囊底 + 白字（与线路编号同一视觉语言，在任何底色上都清楚，不需要按底色切换字色）。 |
| MZL-D11 | 邮编也避让仓库标记和视口边缘（与线路编号相同）。 |

## 3. 现状（2026-11-19）

- `web/map-view.js`：
  - 第 55–76 行：`route-labels` pane（zIndex 610，`pointer-events: none`）、`labelToggle` 复选框、localStorage 读写、`route-labels--disabled` class。
  - 第 117–130 行：颜色模式按钮 `modeControl`（topright）；第 131–139 行：`legendControl`（topright）。
  - 第 221 行：`legend.append(labelToggle)` 只在“按线路”分支执行，所以其他模式下看不到开关。
  - 第 224–230 行 `labelPriority()`：用 `polygonStyle().fillOpacity` 等于 `POLYGON_STYLE.focused / dimmed / outside` 的值来判断优先级。难易度 / 价格模式的常态不透明度是 0.55 / 0.85，与这些值不同——线路编号放到所有模式后，必须确认优先级仍正确（最好改为按选择状态判断，而不是比较不透明度）。
  - 第 240–244 行 `layoutRouteLabels()`：非 `route` 模式直接隐藏全部线路编号。
  - 第 253–271 行：防重叠（仓库标记、已放置标签、视口边缘、同线路中心距离）。
  - 第 282–295 行 `buildRouteLabels()`：每次 `render` 建 marker；`clearRouteLabels()` 在 `clear()` 中移除。
  - 事件：`zoomend` / `moveend` / 仓库 DOM 变化时重新布局。
- `web/map-state.js`：`routeLabelAnchors()`（约第 210 行）及其几何工具 `geometryParts`、`polygonMoments`、`inPolygon`、`boundaryDistanceSquared`、`interiorPoint`，可复用来算每个 ZIP 的标注点。
- `web/map-text.js` 第 7 行：`showRouteLabels: '显示线路编号'`。
- `web/styles.css` 第 207–238 行（`.route-label*`）、第 578–580 行（`.route-labels--disabled`、`.map-route-label-toggle`）。
- 测试：`server/test/route-map-web.test.js`（线路编号约第 1061–1330 行、开关约第 2040–2062 行）、`server/test/profile-typography.test.js` 第 55 行。
- 旧版 `nc-ops-console-main` 没有邮编标注，无视觉先例。

## 4. 设计

### 4.1 显示面板（MZL-T1）

- 新 Leaflet control（`position: 'topright'`），在 `modeControl` 之后、`legendControl` 之前 `addTo(map)`，保证位置在两者之间。
- 内容：标题“显示”+ 两个复选框行（“线路编号”“邮编”）。T1 先只放“线路编号”，T2 加“邮编”。
- `disableClickPropagation`，滚轮不缩放地图（同图例）。
- 图例不再包含开关。
- 线路编号在所有颜色模式下按同一套规则布局；优先级（选中 / 聚焦 / 普通 / 淡化 / 范围外）由选择状态决定，在各模式下结果一致。

### 4.2 邮编标注（MZL-T2）

- 标注点：`zipLabelAnchors(features)`（`web/map-state.js`，纯函数）——每个 ZIP 一个点，取面积最大的部分的内部点（复用现有几何工具）；几何只在 `render` 时算一次。
- 独立 pane `zip-labels`（`pointer-events: none`，zIndex 低于 `route-labels`，例如 605）。
- 开关关闭时：不做邮编布局计算（可以不建 marker，或建好但隐藏且不布局）；打开时立即布局。
- 布局：在线路编号之后运行；避让线路编号已放置的矩形、仓库标记、其他邮编、视口边缘；缩放低于 `ZIP_LABEL.minZoom` 时全部隐藏。
- 过滤：MZL-D5（选中线路只显示该线路）、MZL-D9（范围外 / 淡化不显示）。
- 常量集中在 `ZIP_LABEL`（`minZoom`、字宽、高度、padding），便于调整。

## 5. 验收标准

| 编号 | 标准 |
|---|---|
| MZL-AC1 | 五种颜色模式下，右上都能看到“显示”面板，位置在颜色模式按钮和图例之间；图例里不再有开关。 |
| MZL-AC2 | “线路编号”开关在所有颜色模式下都能显示 / 隐藏线路编号；状态沿用 `nc-ops-map-route-labels`，默认开。 |
| MZL-AC3 | 非“按线路”模式下，选中线路、站点聚焦、DSP 筛选时，线路编号的选中 / 聚焦 / 淡化 / 隐藏表现与“按线路”模式一致。 |
| MZL-AC4 | “邮编”开关默认关；打开后在缩放 ≥ `ZIP_LABEL.minZoom` 时显示邮编，互不重叠，不压线路编号和仓库标记；关掉后全部隐藏；刷新后保持上次选择。 |
| MZL-AC5 | 选中线路时只显示该线路的邮编；站点 / DSP 筛选时范围外和淡化的 ZIP 不显示邮编。 |
| MZL-AC6 | 切换片区 / 重新 `render` 后旧邮编标注被清掉，不残留。 |
| MZL-AC7 | 现有测试全部通过；新增测试覆盖面板、开关存储、所有模式下的线路编号、邮编布局与过滤。 |

## 6. Codex 任务拆分

| 任务 | 内容 | 状态 |
|---|---|---|
| MZL-T1 | 显示面板 + “线路编号”开关迁移 + 线路编号在所有模式下可用（AC1–AC3） | Done（r1：Claude 笔误更正样式） |
| MZL-T2 | 邮编标注 + “邮编”开关（AC4–AC6） | Done（r1：恢复 LF / 文案；r2：开关打开时才建 marker） |
| MZL-T3 | 地图减少遮挡 + 显示面板移到配色按钮左侧（第 8 节，AC8–AC11） | Done（r1：无消息时隐藏空状态条；面板位置由 MZL-T4 取代） |
| MZL-T4 | 显示面板移到配色按钮下方、图例左边（MZL-D15、AC12） | Done |

## 8. MZL-P2：地图减少遮挡（Product Owner 2026-11-20）

PO 预览后反馈：DMS 登录过期提示和左下角覆盖率按钮挡视野；显示面板放在配色按钮下方不好看。

| 编号 | 规则 |
|---|---|
| MZL-D12 | DMS 登录过期提示（`web/data-status.js` 的 `loginNotice` / `languageNotice`）**只在线路地图页不显示**；线路档案页和“更新记录 / 刷新”面板里的提示保持不变。地图页其他数据状态消息（如自动更新失败）不在本次范围内，保持不变。 |
| MZL-D13 | 左下角“覆盖率 · 缺少边界的邮编”按钮缩成一个**小图标按钮**，放在“仓库”图例旁边；点开后仍是原来的覆盖率面板（覆盖率、缺少边界的邮编、跨站冲突、数据来源）。有跨站冲突时图标上仍显示警告点。保留可访问名称（`aria-label` / `title` 为“地图覆盖率 · 缺少边界的邮编”及覆盖率数值）。窄屏（≤ 768px）现有的静态展开布局保持不变。 |
| MZL-D14 | “显示”面板移到配色按钮**同一行、紧贴“按线路”左边**：`[显示：☐ 线路编号 ☐ 邮编] [按线路 按 DSP 按站点 按难易度 按价格]`；高度、圆角、背景与配色按钮条一致；图例仍在下方。窄屏时可换行，但不得遮挡配色按钮。 |

| 编号 | 验收标准 |
|---|---|
| MZL-AC8 | 地图页在 `needs_login` / 语言错误时不显示登录提示；线路档案页仍显示；“更新记录 / 刷新”面板仍显示。 |
| MZL-AC9 | 左下角只剩小图标（≤ 约 36px 宽）；点击打开 / 关闭原覆盖率面板；Esc 关闭并聚焦回图标（保持现有行为）；冲突警告点仍可见。 |
| MZL-AC10 | 显示面板与配色按钮在同一行，紧贴其左侧，视觉高度一致；切换颜色模式、勾选开关功能不变。 |
| MZL-AC11 | 全套测试通过；修改的旧断言逐条说明原因。 |

**MZL-D15（Product Owner 2026-11-20，取代 MZL-D14 的位置）**：“显示”面板放在配色按钮**下方、图例左边**，与图例顶端对齐（PO 截图标注的位置）。面板竖排：标题“显示”，下面“线路编号”“邮编”两行复选框；样式与图例一致（深色半透明卡片）。图例高度变化（如 DSP 图例很长）时面板仍贴在图例左上，不被拉伸。图例隐藏时面板仍在原位置（贴右侧）。窄屏（≤ 768px）面板放在图例上方，不遮挡配色按钮。由 MZL-T4 实现，对应 MZL-AC12：面板在配色按钮下方、图例左侧且顶端对齐，五种颜色模式下位置一致，开关功能不变。

## 7. 实现记录

MZL-T1：新增独立显示面板，沿用现有深色图例样式；线路编号开关和本地偏好保持原有行为。标签优先级依据选择及筛选状态计算，适用于所有颜色模式。邮编标注留待 MZL-T2。

MZL-T2：在 render 时计算 ZIP 标注点，使用独立 pane 显示邮编；开关持久化用户偏好，并按缩放、筛选及碰撞规则布局。

MZL-T3: The map suppresses main-area login and language notices through a shared status option; refresh details retain them. Coverage uses an accessible icon control with a conflict indicator. Display options share a responsive control row with color modes.

MZL-T4????????????????????????????????????????????
