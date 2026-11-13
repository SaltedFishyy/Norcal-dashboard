# 线路地图视觉焕新（Map Visual Refresh，MVR）

状态：**Approved — In progress**（Product Owner 2026-11-11 批准第一阶段 MVR-T1..T3；同日批准第二阶段 MVR-T4..T6，见第 9 节）

## 1. 目标

Product Owner 2026-11-11：喜欢 legacy 站点「北加片区站点数据看板」（`nc-ops-console-main/`，本地 `npx http-server nc-ops-console-main -p 8000`）里 Stations / DSP / Routes 视图的地图观感，觉得比现在的 `/map` 舒服，尤其是颜色和饱和度。要求让 `/map` 往这个方向靠，**不照抄，不改数据逻辑和功能结构**。

只改前端呈现：`/api/route-map*`、数据、选择 / 淡化 / 聚焦的**判定逻辑**、搜索、仓库层、DSP 过滤都不变。规则同 RM9-2 / RM13-5：**不新增 web 文件、不新增 import 路径**（静态白名单），不新增依赖。

## 2. 对比结论（Claude 2026-11-11 在 Chrome 中并排检查，SFO01 / 湾区）

| 方面 | 参考站点 | 现在的 `/map` |
|---|---|---|
| 线路色 | `hsl(golden-angle, 68%, 58%)`，所有颜色明度一致，只差色相 | ColorBrewer Set2/Set3 派生 19 色，再做 vivid / target 变换；黄色很亮、紫色很淡，明暗不一 |
| 色块 | fillOpacity 0.6；边框 `#0A101E` 0.9px、opacity 0.65 | focused 0.52；边框 `#1e293b` 1px |
| 底图 | OSM 栅格，海是灰蓝，陆地米白 | Protomaps `light`：海是饱和青色，和几种青 / 蓝线路色混在一起；缩小时左侧超出 `us` 底图范围的区域显示为灰色空白带 |
| 悬停 / 选中 | 悬停白色描边 2px、填充 0.9；选中线路 0.88 白边，其他 0.14 | 悬停深色描边；选中有双层描边（保留） |
| 范围外 | Routes 视图只显示当前站点 | 其他站点淡化后仍留在图上 |
| 标签 | 无大块编号 | 白底编号框较重 |

参考的底图（OSM 官方 tile）**不采用**：RM2-V1 已决定自托管 Protomaps，OSM 官方 tile 不适合生产使用。

## 3. 第一阶段规格

### MVR-A 底图配色（T1）

- 保留 Protomaps `light` flavor。protomaps-leaflet 5.1.0 没有导出内置 flavor 对象，自定义完整 flavor 成本高，因此**用 CSS filter 作用在底图瓦片上**降低饱和度，使用 `.map-page .leaflet-tile-pane { filter: saturate(.58) sepia(.08) brightness(1.03) contrast(.95); }（已被 P2-1 D1 取代）`（Claude 在 Chrome 中调定，MVR-T1 第 1 轮修复）。filter 只能作用在底图所在的 pane，**不能作用在 polygon / 标签 / 选择描边 / 仓库 marker 上**。
- 地图容器 `#route-map` 的背景色设为和滤镜后的水色接近的灰蓝色，超出底图覆盖范围的区域看起来像海，不再是灰色空白带。
- 数值放在 `web/styles.css` 的一个新的 `MVR` 区块中，范围限定为 `.map-page`。

### MVR-B 新调色板（T1）

- `web/route-colors.js` 的 19 个颜色替换为等明度的 OKLCH 调色板（L = 0.70，C = 0.135，跳过与水色接近的 195°–250° 色相；槽位按 ×7 mod 19 排列，相邻槽位色相相距较远）。**长度仍为 19，FNV-1a hash 规则不变**，所以每条线路仍落在原来的槽位，只是槽位上的颜色值换了。Product Owner 2026-11-11 同意整体换色一次：

  ```text
  #57a3ef #e27897 #9da837 #9292f0 #e57d64 #60b56b #bd83d9 #d68c33 #00b9a0 #da7ab0
  #b49f23 #779bf2 #e6797e #81af50 #a98ae7 #e0834a #35b886 #cd7ec6 #c79521
  ```

- 新调色板本身就是最终填充色：`ROUTE_FILL` 的 vivid 变换（饱和度 ×1.4、亮度 −0.06）和 `target` 变换都改为**恒等变换**（饱和度 1、亮度 0）。保留变换机制和 `dimmed` 变换（饱和度 ×0.45、亮度 +0.06）。结果是：侧栏色块和地图目标区域的颜色一致。
- `assignRouteColors`（RM11 相邻避色，ΔE ≥ 30）**不变**，基于新调色板运行。
- 更新 `route-colors.js` 顶部注释，说明 MVR 换过一次颜色值（长度和 hash 不变）。
- 难易度颜色（`difficulty.js`）不变。

### MVR-C 色块样式（T1）

取代 RM9-M2 / RM9-M5 / RM11-1 中的对应数值（判定逻辑不变）：

| 状态 | fillOpacity | 边框 color / opacity / weight |
|---|---|---|
| focused（含 RM12 的 All Stations、按线路模式） | 0.6 | `#0A101E` / 0.6 / 0.8 |
| normal（按难易度、无筛选） | `difficultyFillOpacity` 0.55 | `#0A101E` / 0.55 / 0.8 |
| selectedRoute | 0.85 | `#0A101E` / 0.9 / 1.2（外层双描边不变） |
| selectedZip | 0.9 | 不变 |
| dimmed（**同站点内**的非目标，DSP 不匹配，选中线路时的其他线路） | 0.15 | `#0A101E` / 0.25 / 0.6 |
| **outside（新）**：单站点聚焦时其他站点的 ZIP | 0.05 | `#0A101E` / 0.12 / 0.5 |
| hover | 在当前状态上 +0.2（上限 0.9） | **白色 `#ffffff`**，opacity 1，weight 2 |

- hover 改为白色描边：Product Owner 2026-11-11 批准参考风格，**取代 RM9-M2 中“悬停不再使用白色描边”**。
- `outside` 的判定：`focusStation !== null && properties.station !== focusStation`，并且没有选中的线路属于该 ZIP。片区总览（`focusStation === null`）没有 outside。选中线路后，其他站点的 ZIP 仍为 outside；同站点其他线路为 dimmed。
- outside 区域的线路编号不显示（`route-label--hidden`）；hover / tooltip / click 仍可用（不改交互）。
- 数值都是 `POLYGON_STYLE` 中的常量；Claude 在 Chrome 中微调后写回本节。

### MVR-D 线路编号标签减负（T2）

- 字号、分档、碰撞、优先级规则**不变**（包括 Product Owner 手调的远档 18px，RM10c / RM10e）。
- 普通 / focused 标签：改为深色半透明胶囊（底 `rgba(10,16,30,.62)`，文字 `#ffffff`，粗细 600，圆角 999px，padding `0 6px`，去掉白色描边阴影）。在饱和色块上比白底更安静。
- 选中：底 `rgba(10,16,30,.9)`，文字白色，`box-shadow: 0 0 0 1.5px #fff`，比其他明显。
- 淡化（dimmed）：整个标签 opacity .35。
- 远档（zoom < 10）碰撞留白从 10px 提高到 16px（`ROUTE_LABEL.tiers` 常量），让远处更稀疏；选中线路仍然始终显示（RM10b-B4）。

### MVR-E 浮动图例（T3）

- 现有 `.map-legend`（右下角，仅难易度模式显示）改为参考风格：深色半透明面板 `rgba(10,16,30,.86)`，1px 细边框 `rgba(255,255,255,.12)`，圆角 10px，`backdrop-filter: blur(4px)`；标题小号大写字距加宽、灰色；色块为 10px 圆点。
- 按线路模式也显示图例：标题“按线路”，一行“N 条线路 · 颜色对应右侧列表”（N = 已加载 features 中满足当前站点聚焦和 DSP 过滤的不同 `route_id` 数；不受搜索框影响。Claude 2026-11-11 决定：避免图例和侧栏搜索结果耦合），再加三个状态示例：选中 / 当前范围 / 其他（用实际样式的小色块）。文案放进 `map-text.js`。
- 按难易度模式：内容不变（S/A/B/C/D/未知），只换样式。
- 390px 下图例不能挡住缩放按钮和署名；必要时缩小或折叠为只显示标题。

## 4. 验收标准

- **MVR-AC1** 底图在 Chrome 中明显降低饱和度，海是灰蓝色；polygon、标签、选择描边、仓库 marker 的颜色不受 filter 影响（检查计算样式：filter 只在底图 pane 上）。缩小到 zoom 5–6 时左侧没有灰色空白带。
- **MVR-AC2** `palette` 是第 3 节的 19 个值，顺序完全一致；`routeColor` 的 hash 不变（同一 `route_id` 的槽位和改动前相同）；`ROUTE_FILL` 的 vivid / target 是恒等变换，dimmed 不变；`assignRouteColors` 的测试继续通过。
- **MVR-AC3** `POLYGON_STYLE` 的数值按 MVR-C；新的 outside 状态只在单站点聚焦时出现在其他站点的 ZIP 上；选中、DSP、片区总览、难易度模式的判定结果和改动前相同（只有数值改变）。
- **MVR-AC4** hover 为白色 2px 描边，填充提高；离开后恢复。
- **MVR-AC5** 标签样式按 MVR-D；字号和分档常量不变；远档留白 16px；outside 区域的编号隐藏；RM10 / RM10b 的布局测试继续通过（因数值改变而失效的断言逐条说明）。
- **MVR-AC6** 图例按 MVR-E：两种模式都显示，按线路模式的线路数跟随过滤变化；390px 下不挡缩放和署名，页面不出现横向滚动。
- **MVR-AC7** 现有行为不变：站点 / DSP / 线路选择、ZIP 搜索、tooltip、仓库层、更新记录、定位按钮、着色模式切换。`npm test` 全部通过。
- **MVR-AC8** Claude 在 Chrome 中对照参考站点检查片区总览和 SFO01：颜色明度一致、相邻线路一眼可分、目标区域突出、画面不杂乱。Product Owner 预览签字。

## 5. 测试要求

- 单元测试：palette 值和长度、hash 槽位不变、`ROUTE_FILL` 恒等、`polygonStyle` 各状态（含 outside 和 hover）、outside 编号隐藏、图例内容（两种模式和过滤后的数量）、CSS filter 只作用于底图 pane。
- 旧断言因本 spec 改变数值而失效时，逐条更新并在实现记录中说明，不删除行为断言。
- 浏览器检查：Claude 在真实 Chrome 中进行（AC1、AC8）。

## 6. 影响与风险

- 所有线路颜色整体变化一次（Product Owner 已同意）。线路画像页不使用 `routeColor`，不受影响。
- CSS filter 有轻微 GPU 开销；Protomaps 是 canvas 瓦片，filter 作用在 pane 上，拖动和缩放时需要检查是否卡顿。
- `map-view.js` 已较大（`docs/tech-debt.md`），本次只做小的增量，不重构。
- `web/styles.css` 工作区中有其他任务未提交的改动，提交时需要部分暂存。

## 7. 任务拆分

| 任务 | 内容 | 授权 |
|---|---|---|
| MVR-T1 | A 底图 + B 调色板 + C 色块样式 / outside / hover | 2026-11-11 已授权 |
| MVR-T2 | D 标签 | 2026-11-11 已授权 |
| MVR-T3 | E 图例 | 2026-11-11 已授权 |
| MVR-P2 | 第二阶段：底图回调 + 按 DSP / 按站点着色 | 2026-11-11 已授权，见第 9 节 |
| — | 布局：地图改为“左侧栏 + 全屏地图” | Product Owner 2026-11-12 已决定，见 `docs/features/map-layout.md`（ML） |

## 8. 实现记录（Implementation Notes）

### MVR-T1

- 仅实现 MVR-A/B/C；API、数据、依赖、import 路径、难易度颜色和相邻避色算法未变。
- CSS 仅过滤 `.map-page .leaflet-tile-pane`，使用初始参数；地图背景选择灰蓝色 `#a6bdc5`，待 Chrome 对照水色确认。
- pane 检查：Protomaps 继承 GridLayer 默认 tilePane；polygon / ZIP highlight 使用 overlayPane，标签使用 route-labels（610），双描边使用 selection-outline（450），仓库 marker 使用 warehouse（620），均不在过滤元素内。
- palette 按规格顺序替换，FNV-1a 函数不变；vivid / target 恒等，dimmed 参数不变。outside 使用 dimmed 颜色变换和独立透明度 / 边框。
- 非选中且单站点范围外的 ZIP 优先使用 outside；显式选中优先级不变。所有成员 ZIP 都为 outside 的标签隐藏且不占碰撞空间；混合成员沿用原布局。
- hover 白色 2px、opacity 1、填充 +0.2 上限 0.9；mouseout 继续重新计算当前样式。selectedZip 基础边框不变，hover 时统一为 2px。
- 旧断言逐项调整，保留行为断言：
  1. RM2：route_id=1 的地图色 `#cca300` → `#cd7ec6`；槽位 8/14/16/17 对应新 palette。
  2. DS / R2a：范围外 ZIP 从 dimmed 改为 outside；同站点 DSP 不匹配仍为 dimmed，显式选择优先不变。
  3. R1：hover 深色改白色，weight 从 max(base, hover) 改固定 2px（含 selectedZip）；保留恢复和基础样式不变检查。
  4. R2a：饱和度增强预期改为恒等；白色 `#f0f0f0` → `#ffffff`，保留 hue / HSL 检查。
  5. RM11 / RM12：指定旧色 `#66c2a5` 的目标色 `#22ce98` → 本色，淡化色 `#77b19f` → `#92b5aa`（dimmed 参数不变，输入不再先增强）；透明度 .7/.16/.52 → .85/.15/.6，范围外为 .05。
  6. DS 页面 / RM10d：其他站点改为 outside 透明度、标签隐藏；移除聚焦后恢复可见，继续检查 DSP / 线路选择。
- 新增全 palette、固定 hash 槽位、恒等变换、outside 优先级、两种模式 hover、滤镜范围 / pane、线路选择时 outside 标签隐藏及混合成员标签可见测试。
- 检查：`npm.cmd test` 774 通过，0 失败 / 跳过；随后补充标签测试，针对性测试 66 通过。`git diff --check` 通过。项目无 lint / build 命令。
- Chrome 实机视觉、zoom 5–6 边界水色、计算样式、拖动性能及 Product Owner 预览签字待 Claude / Product Owner 完成；T2 标签外观 / 间距和 T3 图例未实施。

### MVR-T1 第 1 轮修复

- 按 Claude Chrome 调定值更新 MVR-A 与 CSS：`saturate(.58) sepia(.08) brightness(1.03) contrast(.95)`，过滤范围仍仅为底图 tilePane。
- `us` 底图增加 `bounds: [[24.0, -125.0], [49.5, -66.5]]`，与 RM2 提取 bbox 一致，阻止完全位于范围外的瓦片绘制灰色背景。未设置地图全局 maxBounds；hawaii 保留独立 bounds。南界 24.0° 低于 southern CA / Yuma，仍由 us 层覆盖。
- 背景最终为 `#abdadc`：本地 `@protomaps/basemaps/src/flavors.ts` 的 LIGHT water 为 `#80deea`（RGB 128,222,234）。对 RGB 依次应用 CSS saturate(.58) 和 sepia(.08) 的标准 3×3 矩阵，再逐通道计算 `c * 1.03 * .95 + 255 * .025`（brightness、contrast），得到约 `(170.953,217.731,219.850)`，四舍五入为 `(171,218,220)`。容器本身不再过滤，避免重复变换；真实边界视觉仍待 Chrome 复查。
- 测试将 RM2 原先 us bounds 为 undefined 的断言改为指定范围，并直接检查 basemaps 配置；保留 hawaii 和其他底图范围断言。MVR CSS 测试同步检查新滤镜及背景值；未修改其他行为断言。
- 检查：`npm.cmd test` 775/775 通过，0 失败 / 跳过；`node --test server/test/route-map-web.test.js` 44/44 通过；`git diff --check` 通过（仅已有 LF/CRLF 提示）。无 lint / build 命令。本轮未运行真实 Chrome，AC1 视觉和 AC8 签字待复查；无数据、API、依赖变化，未 commit / push / 部署。

### MVR-T2

- 直接修改原标签 CSS，普通 / focused 共用白字、600 字重、深色半透明胶囊；选中保留原 700 字重、字号、行高和垂直 padding，改为深色底及 1.5px 白色描边；dimmed 仅在整个标签上应用 .35 opacity，继承普通底色和文字颜色。
- 远档碰撞留白 10 → 16；普通 widthPadding 8 → 12（左右各 6px），selectedWidthPadding 12 → 15（左右各 6px 加描边各 1.5px）。其他分档常量、尺寸估算方法、排序、碰撞、视口和仓库避让算法不变。
- 旧断言逐项更新：R2a 白底 / 边框 / 内边距 / 圆角 / 深色字与 dimmed .4 改为新样式；RM10e 普通字重 / 字色及远档留白更新，保留全部字号、行高和其他分档断言，补充两种 widthPadding 检查；RM11 focused 专用白底断言改为验证继承普通颜色。
- RM10b 碰撞样例中心间距 30 → 32、视口边缘中心 9 → 11，适配新增宽度，继续验证远档碰撞、中近档可见及无碰撞留白的视口边缘。针对性测试 44/44 通过。
- 未改 T1、API、数据、依赖、import 路径和业务交互；真实 Chrome 视觉检查及 Product Owner 预览签字仍待 Claude / Product Owner 完成。
- 最终检查：`npm.cmd test` 775/775 通过，0 失败、0 跳过；`node --test server/test/route-map-web.test.js` 44/44 通过；`git diff --check` exit 0（工作区既有 LF/CRLF 提示）。无 lint / build 命令。MVR-AC5 / AC7 自动化部分通过，真实浏览器视觉和交互验收待完成。

### MVR-T3

- 仅扩展现有图例与 MVR CSS：两种模式在有 features 时显示，clear / 空 features 时隐藏。难易度标题、等级文案和颜色保持原样。
- 按线路模式从已加载图形按 focusStation / dsp 过滤并去重 route_id，不读取搜索结果或当前选择；render、DSP、模式和选择更新均同步刷新图例，站点切换沿用 render。
- 状态圆点使用中性 RGB (148,163,184)，填充透明度与边框颜色、透明度、宽度直接读取 POLYGON_STYLE。其他状态在单站点聚焦时用 outside，片区总览用 dimmed。新增文案集中在 map-text.js。
- 面板采用规格的深色半透明背景、边框、圆角和 blur；450px 以下缩小面板与字号、隐藏三行线路状态示例、增加底部留白，保留线路标题及数量说明。实际 390px 遮挡与横向滚动情况待 Chrome 检查。
- 旧断言逐项更新：RM5 两处“线路模式图例 hidden”改为可见，保留选择、视口、请求数和图层身份检查；MVR 滤镜测试改为精确匹配 filter 属性，避免把新增 backdrop-filter 错认成底图滤镜。
- 新增两模式文案、线路去重、站点 / DSP 数量变化、搜索与选择不影响数量、零匹配、未加载 / clear / 空 features 隐藏，以及面板 / 圆点 / 窄屏 CSS 测试。
- 检查：`npm.cmd test` 777/777 通过，0 失败 / 跳过；其后补充文案精确断言与 CSS 测试，`node --test server/test/route-map-web.test.js` 47/47 通过。无 lint / build 命令。MVR-AC6 功能与 CSS 自动化部分通过；MVR-AC7 自动化回归通过，真实 Chrome 交互、390px 视觉与 Product Owner 签字仍待 Claude / Product Owner 完成。无 API、数据、依赖或 import 路径变化，未 commit / push / 部署。
### MVR-T3 第 1 轮修复

- 线路状态示例增加 18×12px、背景 `#e9e4d8`、圆角 3px 的浅色底图方块，上叠 10px 圆点。颜色使用现有 `palette[0]`，填充透明度和边框 color / opacity / weight 直接读取对应 `POLYGON_STYLE`。未改计数、难易度圆点或交互逻辑。
- 已确认 `/route-colors.js` 位于 `server/src/api/static-files.js` 的现有白名单；直接 import 现有模块，无新增模块路径、白名单或依赖。
- 测试更新为检查底图容器、palette 示例色以及三个示例的完整填充和边框参数（含 dimmed / outside 切换）。针对性测试 47/47、`npm.cmd test` 778/778 通过，0 失败、0 跳过；`git diff --check` 通过（仅既有换行提示）。项目无 lint / build 命令。
- 用现有 Playwright headless Chromium 打开运行中的 `http://127.0.0.1:3000/map`，viewport 390×844。SFO01 显示 37 条线路，两种模式的 `document.documentElement.scrollWidth` 均为 390，pageerror 为 0。未重启服务或修改 package.json。
- 地图滚入视口后的 boundingClientRect，单位 px，格式 `(x, y, width, height)`：

  | 元素 | 按线路 | 按难易度 |
  |---|---|---|
  | 图例 | (167, 721.109375, 200, 60) | (167, 616.109375, 200, 165) |
  | 缩放控件 | (23, 349.5, 36, 72) | 同左 |
  | 定位按钮 | (23, 431.5, 36, 36) | 同左 |
  | 署名 | (13, 813.109375, 364, 30.78125) | 同左 |
  | 仓库图例 | (23, 759.890625, 86, 44) | 同左 |

- 两种模式图例与上述四类控件的矩形交叠检查全部为 false，无需修改 MVR 窄屏规则。截图 `.handoff/MVR-T3-mobile.png` 仅本地保存，390×844，已查看确认布局。
- MVR-AC6 本轮修复与移动端检查通过；MVR-AC7 自动化回归通过，本轮未重复所有真实浏览器交互。最终视觉与 Product Owner 预览签字待完成。无数据、schema、API 变化；未 commit / push / 部署。



---

## 9. 第二阶段：底图回调 + 按 DSP / 按站点着色（MVR-P2，**Approved**，Product Owner 2026-11-11）

Product Owner 2026-11-11：底图希望像参考站点一样饱和度稍高；增加“按 DSP”着色（颜色对应 DSP），按线路时颜色对应线路；**保持连贯，不能乱**。Claude 给出方案，Product Owner 回复“按你的建议做”。仍然只改前端呈现，规则同第 1 节（不新增 web 文件 / import 路径 / 依赖，不改 API 和数据）。

### P2-1 Product Owner 决定（2026-11-11）

| # | 决定 |
|---|---|
| D1 | 底图滤镜回调到约 `saturate(.85) sepia(.04) brightness(1.02) contrast(.97)`；`#route-map` 背景按 MVR-T1 第 1 轮的同一方法重新计算。**取代 MVR-A 的数值。** |
| D2 | 新增着色模式 **按 DSP**、**按站点**。模式按钮顺序：按线路 / 按 DSP / 按站点 / 按难易度。 |
| D3 | **DSP 按公司代码定色**：`dsp_name` 最后一个 `-` 之后的部分为公司代码（`SFO-AAS`、`SFO02-AAS`、`DEN-AAS` → `AAS`）。没有 `-` 时整个名称就是代码；空值归为“未分配”（中性灰，不参与分配）。Product Owner 同意 Claude 的推断“后缀相同 = 同一家公司”；规则集中在一个函数里（例如 `dspColorKey`），以后改为按完整 `dsp_name` 只需改这一处。记入 `docs/open-questions.md`。 |
| D4 | **不做**线路色从 DSP 色派生；线路色保持 MVR-B。 |
| D5 | 一致性原则：**颜色只表达当前模式的分组；同一颜色在地图色块、右侧线路列表色块、图例、tooltip 中一致。** 切换模式只改变“颜色代表什么”，透明度 / 边框 / 选中 / 淡化 / outside 层级、仓库层、选择和过滤行为都不变。 |

### P2-2 颜色分配（Claude 设计）

- 调色板：DSP 和站点都使用 MVR-B 的同一套 19 色（视觉统一）；淡化仍用 `ROUTE_FILL.dimmed` 变换。
- **按片区分配，片区内尽量唯一**（纯函数，确定性；每次加载片区数据计算一次，和 RM11 的线路分配同一时机，切换站点 / DSP / 选择 / 模式时不重算）。**MVR-T5 第 1 轮修订（Claude 2026-11-11，Chrome 中发现 UNS / AAS 都是粉色且相邻；用 5 个片区真实数据模拟后确定）：**
  1. 邻接：复用 RM11 的共享顶点邻接，按分组键聚合。
  2. 顺序（DSatur）：每一步从未分配的键中选“已分配相邻分组数”最多的；相同时按邻接总数多、ZIP 数多、键名排序。
  3. 每个键的候选色按首选槽位 `palette[FNV-1a(键) % 19]`（复用 `routeColor` 的 hash）开始循环，只看片区内**未占用**的颜色，依次取：
     a. 第一个与已分配相邻分组 ΔE ≥ `ROUTE_COLOR_ASSIGN.minDeltaE`（30），并且与片区内所有已分配分组 ΔE ≥ `GROUP_COLOR_ASSIGN.minGlobalDeltaE`（20，新常量）的颜色；
     b. 否则第一个与相邻分组 ΔE ≥ 30 的颜色；
     c. 否则与相邻分组最小 ΔE 最大的未占用颜色；
     d. 19 色都已占用时允许复用：与相邻分组最小 ΔE 最大的颜色。
  4. 模拟结果（相邻分组 ΔE < 30 的对数，修订前 → 修订后）：北加 DSP 4 → 0、站点 2 → 0；南加 DSP 6 → 5（30 个公司代码，超过 19 色）、站点 4 → 0；丹佛、西雅图、凤凰城全部 0。
- 已知限制：同一公司在不同片区的颜色“通常相同但不保证”；片区内分组超过 19 个时会有复用（相邻分组仍尽量避开）。

### P2-3 地图与页面

- 按 DSP / 按站点：polygon 填充色 = 分组色，套用现有状态层级（focused / selectedRoute / selectedZip / dimmed / outside / hover）。
- 线路编号：按 RM10-L1，只在按线路模式显示；其他模式隐藏。
- 右侧线路列表色块：跟随当前模式（线路色 / 该线路 DSP 的颜色 / 该线路站点的颜色 / 难度色）。
- **按 DSP 模式下右侧列表按 DSP 公司代码分组**：组头 = 色块 + 公司代码 + 线路数；组内按线路名排序；组按 ZIP 数从多到少，相同按公司代码排序。搜索、选择、滚动定位行为不变；其他模式保持现在的平铺列表。
- tooltip：在现有内容前加一个当前模式的色点（难易度模式用难度色）。
- 图例（MVR-E 的面板）：
  - 按 DSP：标题“按 DSP”，列出当前站点聚焦范围内的公司代码，不受 DSP 过滤影响，保留其他公司供切换；色点 + 代码 + ZIP 数，按 ZIP 数排序；超过 8 行时面板内滚动（最大高度约 220px）。鼠标悬停显示该代码包含的完整 `dsp_name`（多个名称时使用下述不可点击提示）。
  - **点击图例行**：当前范围内该公司代码只对应一个 `dsp_name` 时，等同于在 DSP 下拉框中选中它（复用现有 DSP 过滤流程，包括 RM7-5 的选中处理）；对应多个时不可点击（`aria-disabled`，提示“该公司在多个站点，请先选择站点”）。再次点击已选中的行等于清除 DSP 过滤。
  - 按站点：标题“按站点”，列出站点代码 + ZIP 数，只展示不可点击（站点切换仍用下拉框）。
  - 按线路 / 按难易度：保持 MVR-E。
- 切换模式时 polygon 填充颜色过渡约 200ms（`transition: fill .2s, fill-opacity .2s`，只作用在 overlay pane 的 path 上；hover 不加过渡以保持跟手）。尊重 `prefers-reduced-motion`（关闭过渡）。
- 文案放进 `map-text.js`。

### P2-4 验收标准

- **P2-AC1** 底图滤镜和背景按 D1；缩小到全美范围时海和范围外区域无明显色差（Claude Chrome 检查）。
- **P2-AC2** `dspColorKey`：`SFO-AAS` / `SFO02-AAS` / `DEN-AAS` → `AAS`；无 `-` 原样；空值 → 未分配。
- **P2-AC3** 分组颜色分配为纯函数、结果确定；片区内分组数 ≤ 19 时互不相同；首选色未冲突时保留；相邻分组 ΔE 规则按 P2-2；超过 19 个时按 P2-2 复用；无结果时回退到首选色。
- **P2-AC4** 四种模式切换：地图色块、列表色块、图例、tooltip 色点一致；状态层级和选择 / 过滤行为与按线路模式相同；编号只在按线路模式显示。
- **P2-AC5** 按 DSP 模式下列表按公司代码分组（排序按 P2-3）；搜索、选择、列表定位正常；切回其他模式恢复平铺。
- **P2-AC6** DSP 图例点击按 P2-3：唯一对应时设置 DSP 过滤（下拉框同步），再次点击清除；多个对应时不可点击并有提示。
- **P2-AC7** 模式切换有约 200ms 填充过渡，hover 无过渡；`prefers-reduced-motion` 下无过渡。
- **P2-AC8** 现有测试通过（因本节改变的断言逐条说明）；390px 下无横向滚动，四个模式按钮不溢出（可换行或缩小）。
- **P2-AC9** Claude 在 Chrome 中检查北加片区总览、SFO01、南加片区（DSP 多）；Product Owner 预览签字。

### P2-5 任务拆分

| 任务 | 内容 |
|---|---|
| MVR-T4 | D1 底图回调（轻量） |
| MVR-T5 | D3 `dspColorKey` + P2-2 分组颜色分配 + 按 DSP / 按站点模式（地图、模式按钮、列表色块、tooltip 色点、编号隐藏）+ 图例列表（不可点击） |
| MVR-T6 | DSP 图例点击过滤 + 按 DSP 列表分组 + 模式切换过渡 |

### P2 实现记录（Implementation Notes）

### MVR-T4

- 底图 tilePane 滤镜更新为 P2-1 D1 的 `saturate(.85) sepia(.04) brightness(1.02) contrast(.97)`；作用范围不变，容器本身不加滤镜。
- 背景按 MVR-T1 第 1 轮的 CSS 标准矩阵 / 公式重新计算，输入 Protomaps light water `#80deea`（RGB 128,222,234）。依次应用 saturate(.85) 标准 3×3 矩阵得到 (139.226300,219.126300,229.326300)，sepia(.04) 标准 3×3 矩阵得到 (144.319917,219.858746,227.550238)，brightness(1.02) 得到 (147.206316,224.255920,232.101242)，contrast(.97) 逐通道为 `c * .97 + 255 * .015`，得到 (146.615126,221.353243,228.963205)。最终四舍五入为 (147,221,229)，即 `#93dde5`。
- CSS 测试仅更新滤镜和背景值断言，保留滤镜只作用于底图 pane、容器未过滤及其他 pane 隔离检查；未改数据、API、依赖或交互。
- 全美范围水色衔接的真实 Chrome 检查及 Product Owner 预览签字待完成。
- 检查：`npm.cmd test` 781/781 通过，0 失败、0 跳过；`git diff --check` 通过（仅工作区既有 LF/CRLF 提示）。项目无 lint / build 命令。未 commit / push / 部署。


### MVR-T5

- Added DSP suffix keys, neutral unassigned DSP color, and deterministic district group allocations. Group allocation shares RM11 vertex adjacency and CIE76 distance code; RM11 route ordering and allocation behavior are preserved.
- DSP and station maps are calculated once beside assignRouteColors after each successful district load and shared by view and panel. No color-mode URL/storage state existed, so none was added. Existing DSP suffix decision is already recorded in docs/open-questions.md.
- Added the four ordered mode buttons, group fills, matching list swatches and tooltip dots, route-only labels, and noninteractive group legends with scoped ZIP counts, stable sorting, complete DSP-name titles and a 220px scrolling list. No T6 grouping, legend click handler or transition was added.
- Updated old assertions: RM5 two-button text/aria arrays now have four entries; difficulty button index moved from 1 to 3 in RM5/RM5b/search tests. RM6 four-row safe-tooltip assertions now run in all four modes. RM11 shared-render source assertions include groupColors. Existing selection, request, layer identity and tooltip field assertions remain.
- Added tests for DSP keys, purity/determinism, unique colors through 19 groups, preferred fallback, cyclic DeltaE collision choices, maximin reuse above 19, ZIP-count ordering, group-mode state hierarchy, hidden labels and shared map/list/legend/tooltip colors and filter scope.
- Playwright headless Chromium checked the running http://127.0.0.1:3000/map without restarting services. At widths 1440 and 390 all four modes had document scrollWidth 1440 and 390 respectively, with zero pageerrors. At 390 the four buttons occupied x=138.98 through x=363, inside the viewport. Local screenshots: .handoff/MVR-T5-1440.png and .handoff/MVR-T5-390.png.
- No API, data, schema, dependencies, web files or new import paths were added; no commit/push/deployment. No lint/build scripts exist. Final test results recorded below; Claude visual review across NorCal overview/SFO01/SoCal and Product Owner preview sign-off remain pending.

- Final checks: npm.cmd test passed 785/785, zero failures/skips; targeted map-state + route-map-web passed 73/73. After expanding the existing RM6 tooltip loop to all four modes, route-map-web passed 48/48 again. git diff --check passed (existing LF/CRLF warnings only). P2-AC2/3/4 and the T5 portion of AC8 passed; AC1 belongs to T4, AC5/6/7 belong to T6, AC9 remains pending visual review and owner sign-off.


### MVR-T5 第 1 轮修复

- Group assignment now uses dynamic DSatur order: assigned neighboring group count, total degree, ZIP count, then key. Cyclic candidates follow a global/adjacent thresholds, b adjacent threshold, c unused maximin, d full-palette maximin reuse. Added frozen GROUP_COLOR_ASSIGN.minGlobalDeltaE = 20; adjacency still uses ROUTE_COLOR_ASSIGN.minDeltaE = 30.
- assignRouteColors and RM11 tests were not changed in this repair. No API, data, schema, dependency, import path or consumer changes.
- Updated group tests cover all a/b/c/d branches, determinism, uniqueness through 19 groups and reuse above 19. Added dynamic DSatur ordering/tie-break coverage and an adjacent pair whose distinct preferred colors have DeltaE < 30: the later group must change color. Existing RM11 assertions remain intact.
- Read-only checks against the running local district API reused actual shared-vertex adjacency and CIE76 helpers. Counts of adjacent pairs with DeltaE < 30 match P2-2 item 4:

  | District | DSP groups | DSP pairs | Station groups | Station pairs |
  |---|---:|---:|---:|---:|
  | north-cal | 18 | 0 | 10 | 0 |
  | south-cal | 30 | 5 | 15 | 0 |
  | denver | 12 | 0 | 11 | 0 |
  | seattle | 14 | 0 | 8 | 0 |
  | phoenix | 14 | 0 | 8 | 0 |

- No real API payload was saved; no DMS capture or service restart. Browser visual checks were not repeated; P2-AC9 remains pending Claude / Product Owner review.
- Checks: npm.cmd test 787/787 passed, zero failures/skips; map-state 27/27 and route-map-web 48/48 passed. git diff --check passed (existing LF/CRLF warnings only). No lint/build scripts. No commit/push/deployment.

### MVR-T6

- DSP legend rows are native buttons. Legend and dropdown share changeDsp, including dropdown synchronization, RM7-5 incompatible-selection clearing, view/panel filtering and retained ZIP hints. A unique full DSP name toggles its filter; multiple names use aria-disabled with the centralized Chinese hint. Unassigned groups have no selectable DSP name and remain disabled. Selected rows expose aria-pressed and a visible border/background.
- Per the T6 brief, DSP legend scope now follows station focus before DSP filtering; alternative companies remain visible after filtering. Updated P2-3 wording accordingly. Station legend scope is unchanged. No API, data, schema or allocation changes.
- DSP route lists group the existing search/filter matches by dspColorKey. Groups sort by summed route ZIP counts descending, then company code; routes sort by name. Headers show the shared color, code and route count without click handlers. Existing route button aria and events remain; selected buttons scroll to the nearest visible position. Other modes retain the existing list rendering, including overview station headings.
- Only mode changes opt polygon SVG paths into a 200ms fill/fill-opacity transition, removed after 220ms. Hover removes the class immediately and hovered polygons do not opt in on a mode change. This keeps ordinary selection/filter/hover updates immediate. CSS is restricted to overlayPane paths, excluding selection-outline, labels and warehouse panes; reduced-motion disables transitions.
- Updated old T5 assertions individually: (1) DSP legend rows now have click handlers, while station rows still do not; (2) filtering retains both DSP groups in the fixture, while station legend still narrows to one. All color, tooltip, label, selection and layer assertions remain.
- Added regression coverage for unique/ambiguous/toggle legend actions, station disambiguation, dropdown synchronization in both directions, RM7-5 clearing, retained legend alternatives, group/code/name ordering, unassigned group, search/empty results, route selection/scrolling, restoration across other modes, transition lifetime/hover suppression and reduced-motion CSS.
- Checks: targeted route-map-web 51/51 passed; npm.cmd test 790/790 passed, zero failures/skips. No lint/build scripts exist. git diff --check passed (existing LF/CRLF warnings only).
- Temporary Playwright headless checks used the already running http://127.0.0.1:3000/map without service restart. At 1440 and 390, all four modes had document scrollWidth equal to viewport width; pageerrors were zero. SFO01 legend retained 9 rows when selecting SFO-UNS and toggled the dropdown back to all DSPs. Enter selected a legend row and Space cleared it. At 390 the four mode buttons span x=138.98 through 363. Computed transition was fill 0.2s, fill-opacity 0.2s; emulated reduced-motion duration was 0s.
- Screenshots .handoff/MVR-T6-1440.png and .handoff/MVR-T6-390.png remain local; mobile screenshot inspected. An initial browser check timed out because PowerShell piped Chinese selectors as question marks; rerun used mode-button indexes and passed. No real API payloads were saved.
- P2-AC5/6/7/8 task checks passed. Full manual regression of all pre-existing interactions, Claude multi-district visual review and Product Owner preview sign-off remain pending. No commit, push, deployment, credentials, dependencies, new web files or import paths.


### MAP-FIX 拖动后 tooltip 残留

- `web/map-view.js` reuses zooming and adds dragging; dragstart / zoomstart close polygon and highlight tooltips, restore current polygonStyle for hovered layers and empty hoveredLayers. Mouseout shares clearHover. Drag/zoom mouseover skips hover styles; normal entry restores them.
- Leaflet 1.9.4 `_openTooltip` defers drag-time mouseover to moveend. Shared polygon/highlight tooltip handlers also block those deferred opens until the next normal mouseover, including after dragend. Tooltip content, styles, clicks, selection/filter logic, APIs and data remain unchanged.
- Existing Leaflet doubles / labelFixture regression covers drag and zoom cleanup, all-polygon tooltip closure, current style restoration, empty hoveredLayers (verified through mode-transition eligibility), suppressed hover/open, deferred open suppression, normal re-entry and highlight tooltips.
- Checks: route-map-web 52/52 passed; npm.cmd test 791/791 passed, zero failures/skips; git diff --check passed (existing LF/CRLF warnings only). No lint/build scripts exist. The first targeted run exposed an invalid test selection fixture (`{}`); corrected it to use the default selection before the passing runs.
- Temporary Playwright headless Chromium smoke check used the already-running http://127.0.0.1:3000/map: map paths loaded, an opened tooltip count changed from 1 to 0 after drag and pointer exit, zero pageerrors. No services started/restarted; no API payloads saved. Exact SFO01 A-to-B manual reproduction, full manual regression and Product Owner preview sign-off remain pending. No commit/push/deployment, credentials, dependencies, new web files or import paths.

### MAP-PERF 快速拖动（2026-11-11）

- 背景（brief 引用 Claude 的 Chrome 实测）：北加片区约 zoom 7–8，us 34 块、norcal 20 块、pnw 7 块、mountain 4 块同时渲染；us 与区域层重叠。Protomaps 主线程绘制繁忙，SVG polygon 在 moveend 重绘，快速拖动时彩色区块延迟出现。编号布局已只在 moveend / zoomend 执行，本次未改。
- `us` 增加 `maxZoom: 6`，`hawaii` 增加 `minZoom: 7`；所有底图增加 `keepBuffer: 4`。`MAP_RENDER.svgPadding` 从 0.5 改为 1，polygon、highlight 和 selection-outline 沿用该常量。未改选择、过滤、着色、API 或数据。
- 已检查本地 protomaps-leaflet 5.1.0 的 `src/frontends/leaflet.ts`：选项继承 `L.GridLayerOptions`，`LeafletLayer extends L.GridLayer` 的构造函数调用 `super(options)`，工厂返回 `new LeafletLayer(options)`，因此 minZoom / maxZoom / keepBuffer 传给 GridLayer。Leaflet 1.9.4 的 `_setView` 按 minZoom / maxZoom 停止范围外瓦片绘制，`_update` 使用 keepBuffer。
- 旧断言逐项更新：（1）us “无 maxZoom”改为 6，保留无显式 minZoom 的断言；（2）hawaii “无 minZoom”改为 7；（3）区域 minZoom 数组中 hawaii 的 undefined 改为 7。新增 svgPadding 固定为 1、全部底图 keepBuffer 为 4 的断言；保留 renderer 共用、bounds、maxDataZoom、updateWhenZooming 和其他行为断言。
- 检查：`npm.cmd test` 791/791 通过，0 失败 / 跳过；`git diff --check` 通过（仅既有 LF/CRLF 提示）。无 lint / build 命令。测试日志仅本地保存在 `.handoff/MAP-PERF-tests.log`。
- 现有 Playwright headless Chromium 只读检查运行中的本地 `/map`，未启动或重启服务：SFO01 加载 445 个 overlay path；zoom 7 / 8 时 us 瓦片数为 0，区域层正常绘制；zoom 6 时 us 绘制 12 块，所有区域层为 0。所有底图 keepBuffer 为 4，已挂载 SVG padding 为 1；往返平移后 pageerror 为 0。首次 zoom 6 检查受到尚未结束的缩放动画影响，等待动画结束后补测通过。未保存真实 API 数据。
- 已接受的视觉代价：zoom ≥ 7 时，区域底图范围外只显示地图背景色。未量化帧率或重测 brief 的性能基线；完整人工交互回归、Claude Chrome 视觉复核及 Product Owner 预览签字仍待完成。未新增 web 文件、import 路径、依赖，未 commit / push / 部署或写入凭据。

## 10. Phase 3 — 底图（Product Owner 2026-11-11）

### 需求（来源：MVR-P3-basemap task brief）

- 加强山林、公园、水体和道路层级，参考 legacy OSM 的视觉；线路 / ZIP 色块仍是最醒目的元素，不改数据、选择、过滤或着色判定。
- 使用 `config/basemap-service-region.json` 的 52 个 Station bbox（已含 0.05° 边距），接入仓库外 `service.pmtiles`：Protomaps 构建 20261110，数据 z11–14，约 915 MB。服务区显示 zoom 11–16 使用高精度底图，区外继续使用区域底图 overzoom。
- 不新增前端文件、import 路径、依赖或静态白名单入口。自动生成内联 light flavor，再集中覆盖配色；通过 UMD 的 `paintRules` / `labelRules` 使用，移除底图降饱和滤镜。运行时不 fetch 服务区配置。
- 服务区范围外不请求 service archive；服务区内空瓦片不提示错误，文件缺失不阻止线路区块。

### 验收标准（沿用 task brief AC1–AC5）

- AC1：API / 文件白名单及 basemaps 测试更新；service 缺失时保留区块和交互。
- AC2：服务区 z11–16 可用街道和路名；测试断言 maxDataZoom 14 / bounds，服务区外 z11+ 保留区域底图。
- AC3：自定义配色通过 paintRules / labelRules 生效；不新增前端文件 / import / 依赖，调整 tile-pane filter。
- AC4：Chromium z8 / z14 截图，可使用合成数据 / 无底图配置检查；无 console 错误，区块仍突出。真实底图由 Claude 本机预览。
- AC5：`node --test server/test/`、`git diff --check` 检查；本节及 route-map 底图来源说明完成。未配置 NC_TEST_DB_* 时按 brief 如实报告。

### 实现记录（Implementation Notes）

- API 和文件读取两处固定白名单均加入 service。单个 service 图层放在 ops 之后，避免创建 52 个独立 renderer / archive cache；外包 bounds 从配置生成，实际瓦片准入额外检查 52 个 bbox 的联合范围。沿用 GridLayer `_isValidTile` 的世界范围 / bounds 检查，再应用联合范围；getZxy 同样拦截范围外请求。service 的文件头预检延迟到首个范围内瓦片，范围外连预检 Range 也不发送。
- service 设置 minZoom 11、maxDataZoom 14、levelDiff 0：Protomaps 默认 levelDiff 1 会在显示 z11 时读不存在的数据 z10。z15–16 使用 z14 overzoom。判定基于显示瓦片，缺瓦片缓存基于数据瓦片，防止 overzoom 父瓦片跨外包 bounds 时误移除区域回退。
- 服务区瓦片由 service 独占；其他显示瓦片继续由原区域层 / ops overzoom。service 加入后重新计算原图层准入，避免持续叠画；不把区域层整体截断在 z10。service 返回 undefined 时静默记录该数据瓦片并重绘，让区域层补位；文件缺失 / 后续 Range 失败恢复区域层并沿用原提示，AbortError 仍交还 renderer。边界按瓦片相交，保留截取的完整边界瓦片，不按 Station 矩形硬裁剪道路。
- 内联 flavor 由本地 @protomaps/basemaps 5.7.2 的 namedFlavor("light") 自动生成；与 vendor UMD source map 中的 light 对象逐项比较，74 个顶层键及原始值完全一致。保留完整对象和 BSD-3-Clause / © Protomaps 来源注释，再覆盖绿色植被、土黄色荒地、蓝色水体、柔和黄橙道路、深灰文字和白色 halo。水色 / 背景同为 #93dde5，tilePane filter 为 none；其他 pane 和 MVR P2 状态参数未变。
- 旧断言更新：light 字符串改为规则对象 / 配色值；basemap URL、maxDataZoom、minZoom 数组追加 service；全部底图缺失时允许尚未触发预检的 service 图层存在，区块和提示检查保留；CSS filter 断言改为 none。新增配置一致性、完整 flavor 键集合、各站点 z11–16 准入、范围外零请求、空瓦片静默回退和 service 缺失交互测试。
- Chromium 使用临时本地 HTTP 服务、真实 Leaflet / Protomaps renderer 和内存合成空瓦片，不读取真实 runtime，不启动或重启现有服务。z8 / z14 均显示 3 个合成区块，9 个底图配置，maxDataZoom 14，filter none，console / pageerror 均为 0。截图 `.handoff/MVR-P3-z8.png`、`.handoff/MVR-P3-z14.png` 已查看；仅验证配置和无数据状态，不能证明真实道路 / 地名视觉。
- 最终检查结果见下方补充；真实底图路名、地形配色、多站点接缝和 Claude / Product Owner 预览签收仍待完成。无运营数据 / schema 改动；无依赖、前端文件或 import 路径新增；未读取 .env / 真实 runtime，未访问 DMS、commit、push 或部署。
- 最终检查：定向 `node --test server/test/route-map-web.test.js server/test/map-state.test.js server/test/basemap-file.test.js` 87/87 通过；`node --test server/test/` 共 840 项，782 通过、56 跳过、2 失败。失败项为 freshness 的 CD-AC30 和 reader-role 的 CD-AC31，均报告“未配置 NC_TEST_DB_*”；未加载 .env，按 brief 留给 Claude 本机复跑 npm test。项目无 lint / build 命令。`git diff --check` 通过，仅工作区原有 LF/CRLF 警告。
- 补充 Chromium 实测：真实 renderer 使用合成有效空 MVT，z8 区域瓦片 18 / service 0；服务区内 z14 区域 0 / service 20；平移到服务区外（40, -124）后区域 15 / service 0，console / pageerror 仍为 0。此前合成缺瓦片运行也无错误；增加 Range 失败恢复回退、AbortError 保持取消语义测试。AC1–AC4 的允许测试范围已覆盖；AC5 文档与 diff 检查完成，全量通过仍受测试数据库配置阻挡。完整真实底图视觉、既有全部交互的人工回归及 Product Owner 签收未宣称完成。

## 11. Phase 4 — 谷歌白天风格底图（MVR-P4，**Done**，Product Owner 2026-11-12 批准；MVR-T7 第 1 轮经 Claude review 通过，Product Owner 2026-11-12 预览签字并批准提交）

### 需求与决策过程

- Product Owner 2026-11-12 先选择 Protomaps 官方 **dark**（对比图 `.handoff/basemap-dark/basemap-*.png`），MVR-T7 已按 dark 实现（见 P4-5）。
- 看到效果后，Product Owner 改为“要像谷歌地图那种”。Claude 做了两种谷歌风格预览（`.handoff/basemap-dark/google-night-*.png`、`google-day-overview.png`），Product Owner 选择 **谷歌白天**（2026-11-12）。**本节以谷歌白天为准，取代前面的 dark 方案。** ML-Q2 的结论同步更新。
- 风格目标：接近谷歌地图默认浅色样式的观感——米白陆地、浅蓝水面、浅绿公园 / 植被、白色道路配浅灰描边、黄色高速、灰色文字。配色是 Claude 按这个观感自行选的颜色值，不使用谷歌的瓦片、图标或任何素材。

范围不变：只改底图配色，以及把 MVR-T7 中为深色底调整的色块 / 图例数值恢复到适合浅色底的值。Phase 3 的 service 高精度底图、区域底图回退、准入范围、白名单逻辑**全部不变**。不改数据、API、选择 / 过滤 / 着色判定、颜色分配算法和 19 色调色板。不新增前端文件、import 路径、依赖。

### P4-1 底图配色（谷歌白天）

- `BASEMAP_FLAVOR` 以本地 `@protomaps/basemaps` 5.7.2 的 LIGHT（`namedFlavor("light")`）为基础，74 个顶层键，再用下表覆盖。未列出的键保持 LIGHT 原值（包括 `pois`）。
- `background` 与 `water` 同为 `#aadaff`；`.map-page #route-map` 背景 `#aadaff`；tile-pane filter 保持 `none`。
- 不恢复 Phase 3 的浅色覆盖值；以本表为准。更新来源注释：基于 LIGHT，覆盖为谷歌白天风格，BSD-3-Clause / © Protomaps。

| 键 | 值 |
|---|---|
| background / water | `#aadaff` |
| earth | `#f5f3f0` |
| park_a / park_b / zoo | `#c3eccb` / `#b5e3bd` / `#c3eccb` |
| wood_a / wood_b | `#cfe8cf` / `#b9dfb9` |
| scrub_a / scrub_b | `#e4efdc` / `#dcebd2` |
| glacier / sand / beach | `#ffffff` / `#f3eedf` / `#f3eedf` |
| hospital / industrial / school / pedestrian / military | `#fbe3e3` / `#ebe9ee` / `#efe9de` / `#f1efec` / `#eceae6` |
| aerodrome / runway / pier / buildings | `#e9eaf0` / `#d9dbe2` / `#ffffff` / `#e8e9ed` |
| tunnel_*_casing（5 个） / tunnel_*（5 个） | `#dadce0` / `#f1f3f4` |
| minor_service_casing / minor_casing / major_casing_late / major_casing_early | `#e2e3e6` / `#dadce0` / `#dadce0` / `#dadce0` |
| link_casing / highway_casing_late / highway_casing_early | `#e9bc62` |
| other / minor_service / minor_a / minor_b / major | `#ffffff` |
| link / highway | `#fde293` / `#fdd774` |
| railway / boundaries | `#c4c7cc` / `#9aa0a6` |
| bridges_*_casing：other / minor / major；link / highway | `#dadce0`；`#e9bc62` |
| bridges_other / bridges_minor / bridges_major；bridges_link；bridges_highway | `#ffffff`；`#fde293`；`#fdd774` |
| roads_label_minor / _halo；roads_label_major / _halo | `#70757a` / `#ffffff`；`#5f6368` / `#ffffff` |
| ocean_label | `#4c7fae` |
| subplace_label / _halo | `#70757a` / `#ffffff` |
| city_label / _halo | `#3c4043` / `#ffffff` |
| state_label / _halo；country_label | `#80868b` / `#ffffff`；`#5f6368` |
| address_label / _halo | `#80868b` / `#ffffff` |
| landcover（7 个子键） | grassland `rgba(212, 238, 205, 1)`、barren `rgba(240, 236, 226, 1)`、urban_area `rgba(240, 238, 235, 1)`、farmland `rgba(232, 240, 220, 1)`、glacier `rgba(255, 255, 255, 1)`、scrub `rgba(222, 238, 212, 1)`、forest `rgba(197, 230, 197, 1)` |

### P4-2 色块与图例（恢复浅色底数值）

MVR-T7 为深色底调整的数值**全部恢复**到 MVR-T7 之前的值（即 MVR-C / P2 生效的值）：

| 状态 | fillOpacity | 边框 color / opacity / weight |
|---|---|---|
| normal | 0.34（difficultyFillOpacity 0.55） | `#0A101E` / 0.55 / 0.8 |
| focused | 0.6 | `#0A101E` / 0.6 / 0.8 |
| selectedRoute | 0.85 | `#0A101E` / 0.9 / 1.2 |
| selectedZip | 0.9 | `#334155` / 1 / 3 |
| dimmed | 0.15 | `#0A101E` / 0.25 / 0.6 |
| outside | 0.05 | `#0A101E` / 0.12 / 0.5 |
| hover | +0.2（上限 0.9） | `#ffffff` / 1 / 2 |

- 图例状态示例的底图方块 `.map-legend-sample`：背景改为谷歌白天的 earth `#f5f3f0`，保留 1px 细边框，颜色改为 `rgba(0,0,0,.12)`（浅底上能看出方块边界）。
- Claude 在浏览器中对照后可微调，结果写回本表。

### P4-3 验收标准

- **P4-AC1** `BASEMAP_FLAVOR` = LIGHT 74 键 + P4-1 覆盖表（逐项测试）；`background` / `water` `#aadaff`；`#route-map` 背景 `#aadaff`；tile-pane filter `none`；不含 DARK 值和 Phase 3 覆盖值。
- **P4-AC2** `POLYGON_STYLE` 与 P4-2 表一致（与 MVR-T7 之前完全相同）；判定逻辑不变；图例示例方块按 P4-2。
- **P4-AC3** Phase 3 的 service / 区域底图行为测试全部继续通过。
- **P4-AC4** Chromium 截图：北加片区总览、SFO01（选中一条线路、再选中一个 ZIP）、按难易度、按 DSP。底图为谷歌白天风格，线路色块和编号标签清楚，选中描边可见，仓库 marker 可见；console / pageerror 为 0；浏览器按 handoff 第 8 节关闭并检查无残留。
- **P4-AC5** `npm test` 全部通过；MVR-T7 中改过的断言恢复或按本节更新并逐条说明；`git diff --check` 通过。
- **P4-AC6** Claude 在浏览器中对照检查，Product Owner 预览签字。

### P4-4 任务

| 任务 | 内容 | 授权 |
|---|---|---|
| MVR-T7 | 第一版：官方 dark（已实现，未提交） | Product Owner 2026-11-12（“换成 dark”） |
| MVR-T7 第 1 轮 | 改为谷歌白天：P4-1 + P4-2 | Product Owner 2026-11-12（“谷歌白天”） |

### P4-5 实现记录（Implementation Notes）

### MVR-T7（2026-11-12）

- BASEMAP_FLAVOR 由本地 @protomaps/basemaps 5.7.2 的 namedFlavor("dark") 生成，74 个顶层键及嵌套值与包导出直接深比较，仅 background / water 改为 #31353f。直接移除原浅色覆盖值，无死配置；保留 BSD-3-Clause / © Protomaps 来源注释。
- 仅调整指定 POLYGON_STYLE、地图背景及图例示例样式；选择、过滤、颜色分配、19 色、标签、tooltip、ML 布局、service / 区域底图准入与回退、API、白名单和依赖未变。
- 旧断言逐项更新，保留行为检查：
  1. RM2 / P3：水色 #93dde5 → #31353f，白色道路 halo → DARK 对应值，light 键集合 → dark；新增完整 74 键深比较及容器背景检查。
  2. RM11 / RM12：focused .6 → .68、dimmed .15 → .18、outside .05 → .06、outside hover .25 → .26；保留选择优先、DSP / Station 过滤与颜色变换检查。
  3. R1：focused hover 变为 .88，高于 selectedRoute .85；原 route > hover 改为分别检查 route > normal、ZIP > hover、hover > normal > dimmed，保留 hover 增量、上限、颜色及描边检查。
  4. ZIP 搜索 / RM5 / RM5b：已覆盖 ZIP 选中边框 #334155 → #e2e8f0；未覆盖 ZIP 继续读取 uncoveredZipStyle，原深灰边框和虚线不变。
  5. 图例边框预期改为读取各状态 color；底色 #e9e4d8 → #1f1f1f，并检查 1px rgba(255,255,255,.18) 边框；新增完整 POLYGON_STYLE 数值表断言。
- 现有 Playwright headless 访问已运行的 http://127.0.0.1:3000/map，未启动、停止或重启服务，未读取 .env / 真实 runtime 配置或保存 API 数据。npm test 按既有脚本运行（脚本自身加载环境文件），未输出凭据。
- 截图：`.handoff/MVR-T7-overview.png`（北加全部站点）、`.handoff/MVR-T7-SFO01-route.png`、`.handoff/MVR-T7-SFO01-zip.png`、`.handoff/MVR-T7-difficulty.png`、`.handoff/MVR-T7-dsp.png`。已查看总览、ZIP、难易度和 DSP：深色底图、线路色块、编号、浅色选中描边与仓库图标可见，淡化区域保留细轮廓。SFO01 选择线路后点击 ZIP，ZIP 面板正常显示；检测到 7 个仓库 marker。页面既有自动更新部分失败提示仍显示，未改数据。
- console error 0、pageerror 0；计算背景 rgb(49,53,63)、tile-pane filter none。launch 后全部步骤有 try/finally 关闭浏览器，设置 120 秒硬超时。结束后运行 `tasklist | findstr chrome-headless` 被环境拒绝（ERROR: Access denied）；替代 `Get-Process -Name '*chrome-headless*'` 检查未发现残留进程。
- 最终检查：`npm.cmd test` 865/865 通过，0 失败 / 跳过；`git diff --check` 通过，仅 LF/CRLF 提示。无 lint / build 命令。P4-AC1..AC5 已完成本次实现与检查；Claude 视觉复核和 Product Owner 预览签字（P4-AC6）待完成。未 commit / push / 部署，无新增前端文件或 import 路径。

### MVR-T7 第 1 轮修复（2026-11-12）

- 按更新后的 P4-1，将底图改为本地 @protomaps/basemaps 5.7.2 LIGHT 的 74 键加谷歌白天覆盖表，完整内联于 web/map-view.js；未覆盖的 pois 保留 LIGHT 原值。生成时对照 DAY，前端及测试没有 import handoff 文件；来源注释更新为 LIGHT、BSD-3-Clause / © Protomaps。background / water / 地图容器背景为 #aadaff，filter 为 none。
- POLYGON_STYLE 完整恢复到执行本轮时 HEAD:web/map-state.js 的值（git diff 该文件为空），判定逻辑未变。图例示例背景 #f5f3f0，边框 1px rgba(0,0,0,.12)。数据、API、颜色分配、19 色、标签、tooltip、ML 布局、service / 区域底图逻辑、白名单、依赖均未修改。
- 上轮 dark 断言逐项恢复 / 更新：
  1. RM2 水色改为 #aadaff，道路 halo 恢复 #ffffff；P3 逐键对照 LIGHT + 独立内联覆盖表，未覆盖键与 LIGHT 深比较（包含 pois），保留 74 键、landcover 键集合、service bounds 和准入行为检查。
  2. RM11 / RM12 恢复 focused .6、dimmed .15、outside .05；outside hover 恢复 .25，DSP / Station 过滤和颜色变换断言保留。
  3. R1 恢复 ZIP > route > hover > normal > dimmed 的完整层级断言，hover 增量、上限、颜色和描边检查保留。
  4. ZIP 搜索 / RM5 / RM5b 已覆盖 ZIP 描边恢复 #334155；未覆盖 ZIP 继续按 uncoveredZipStyle 检查，虚线不变。
  5. 新增的完整 POLYGON_STYLE 数值表测试按 P4-2 恢复；图例色块继续检查各状态的边框参数，CSS 测试改为 #f5f3f0 和 1px rgba(0,0,0,.12)；地图容器背景断言改为 #aadaff。
- 使用已有 Playwright headless 访问正在运行的 3000/map，未重启服务，未读取 .env 或真实 runtime 配置；npm.cmd test 按既有命令运行（该命令自身加载环境文件），未输出凭据。
- 五个场景截图：.handoff/MVR-T7-r1-overview.png、.handoff/MVR-T7-r1-SFO01-route.png、.handoff/MVR-T7-r1-SFO01-zip.png、.handoff/MVR-T7-r1-difficulty.png、.handoff/MVR-T7-r1-dsp.png。查看总览、ZIP、难易度及 DSP 截图：浅蓝水面、浅绿植被、浅色陆地，色块和编号可见，选中描边可见，总览仓库图标可见。ZIP 面板正常显示；检测到 7 个仓库 marker。页面既有自动更新部分失败提示仍显示，本轮未改动。
- console error 0、pageerror 0；计算背景 rgb(170,218,255)，tile-pane filter none。launch 后所有步骤使用 try/finally 关闭浏览器，120 秒硬超时。浏览器脚本退出码 0。tasklist 被环境拒绝（Access denied）；随后 Get-Process -Name '*chrome-headless*' 以及 chrome 进程中 ms-playwright 路径检查均无残留。
- 最终检查：npm.cmd test 865/865 通过，0 失败 / 跳过；git diff --check 通过（仅 LF/CRLF 提示）。无 lint / build 命令。P4-AC1..AC5 本轮实现及验证完成；P4-AC6 Claude 视觉复核与 Product Owner 预览签字待完成。未 commit / push / 部署。

## 12. 拖动性能：松手后再绘制底图（MVR-P5，Approved，Product Owner 2026-11-13）

Product Owner 2026-11-13 反馈：拖动地图时一卡一卡的。

**Claude 排查**（3200，Playwright headless，1440×900，DPR 1.2，5 次拖动 + 1 次缩放）：

- 正常 CPU：中位帧 17ms，超过 50ms 的帧有 4 个。
- CPU 降速 4 倍：中位帧 133ms，超过 50ms 的帧有 568 个。
- 时间几乎全部花在 `protomaps-leaflet` 在主线程绘制矢量底图瓦片（canvas `lineTo` / `fill`）。`map-view.js` 只占约 0.1%。
- 临时替换参数对比（不改代码）：
  - `devicePixelRatio: 1`：超过 50ms 的帧 591 个，没有改善；
  - 去掉底图标注：616 个，没有改善；
  - **`updateWhenIdle: true`：51 个，中位帧 17ms**。

**决策**：底图图层（service 和 regional 两层）设置 `updateWhenIdle: true`。拖动过程中不请求、不绘制新瓦片，松手后再补齐。

- 代价：拖到新区域时，边缘先显示底色，松手后约 0.5–1 秒补齐。
- ZIP 色块、线路编号、悬停提示不受影响。
- 预渲染栅格底图（方案 2）暂不做。先请同事在真实电脑上试用，不够再考虑精简底图内容，最后才考虑方案 2。

**验收**：

- **MVR-P5-AC1** 两个底图图层的 options 包含 `updateWhenIdle: true`，其余底图选项不变。
- **MVR-P5-AC2** 用同样的测量方法，在 CPU 降速 4 倍时，超过 50ms 的帧比现状减少 80% 以上。
- **MVR-P5-AC3** 现有地图行为不变：覆盖率提示、底图失败提示、色块、选择、编号开关都正常。`npm test`、`git diff --check` 通过。
- **MVR-P5-AC4** Product Owner 在 3200 预览签字后，再提交和发布。

| 任务 | 内容 | 授权 |
|---|---|---|
| MVR-T8 | 两个底图图层加 `updateWhenIdle: true`，选项集中成常量，更新测试 | Product Owner 2026-11-13（“好，先做方案 1”） |
