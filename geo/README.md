# geo/ — 地图边界文件

规格：`docs/features/route-map.md`（RM3 R3-5）。这里只放**截取后**的边界文件；全国原始文件不进 Git。

## 服务区边界库 `zcta2020_ca_nv_or.geojson`（唯一正式来源）

| 项 | 内容 |
|---|---|
| 数据来源 | U.S. Census Bureau，Cartographic Boundary Files（公开数据，public domain） |
| 数据集 | `cb_2020_us_zcta520_500k`（2020 ZIP Code Tabulation Areas，1:500,000） |
| 下载地址 | https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_zcta520_500k.zip |
| 数据年份 | 2020（ZCTA 随十年一次的人口普查更新） |
| 范围 | ZIP 前缀为 CA（`90`–`96`）、NV（`889`–`898`）、OR（`97`）的**全部** 2020 ZCTA；规则 `^(9[0-6]|889|89[0-8]|97)` |
| 原始 join key | `ZCTA5CE20` |
| 本文件 join key | `postal_code`：5 位字符串（由 `ZCTA5CE20` 补齐），唯一的属性 |
| 坐标系 | WGS84（原始为 NAD83，截取时转换），坐标精度 6 位小数 |
| 结果 | 2,519 个 polygon（Polygon / MultiPolygon），每个 ZIP 一个；约 12.5 MB |
| 元数据 | `zcta2020_ca_nv_or.meta.json`：dataset、vintage、来源、生成时间、范围规则、feature 数 |
| 生成时间 | 2026-10-02（Claude 在 Product Owner 本机执行） |

用途：
- Route Map 各 Station 的 ZIP polygon（server 端按 Route-ZIP 关系取用）；
- 邮编搜索，包括当前没有线路覆盖的 ZIP。

前端不直接读取本文件；只由 server 端的 boundary store 读取和校验。

### 生成方法

1. 下载上面的 zip 到仓库外目录（`%LOCALAPPDATA%\nc-ops-console\geo-source\`）并解压。
2. 用临时工具 mapshaper（`npx --yes mapshaper@0.6`，**不加入 `package.json`**）：

   ```text
   mapshaper cb_2020_us_zcta520_500k.shp
     -filter "/^(9[0-6]|889|89[0-8]|97)/.test(ZCTA5CE20)"
     -each "postal_code=String(ZCTA5CE20).padStart(5,'0')"
     -filter-fields postal_code
     -proj wgs84
     -o geo/zcta2020_ca_nv_or.geojson format=geojson precision=0.000001
   ```

   不做额外简化（1:500k 本身已经是制图综合后的边界）。
3. 重写 `zcta2020_ca_nv_or.meta.json`（`feature_count`、`generated_at` 等）。
4. 只有在 Census 发布新一期 ZCTA，或需要扩大州范围时才重新生成。新增 Station / Route / ZIP **不需要**重新生成。

### 缺失分类

- ZIP 在范围规则内、但本文件中没有 → `no_zcta`（本文件对这些前缀是完整的，等于 Census 确认没有 ZCTA）。
- ZIP 不在范围规则内 → `not_checked`（需要扩大边界库范围）。

## 历史

- 2026-10-02 之前使用过单站点文件 `zcta2020_sfo01.geojson` / `.meta.json`（SFO01 的 254 个 ZCTA）。已被本边界库取代并删除（Product Owner 同意）；本边界库中这 254 个 polygon 与旧文件完全一致。旧版本可在 Git 历史中找回（如曾提交）。

## 限制

- **ZCTA ≠ USPS 实际投递 ZIP 边界。** ZCTA 是 Census 用人口普查街区拼出来的近似区域，边缘与真实投递范围不完全一致。地图只用于看 Route 大致覆盖哪一片，**不能用来判断某个具体地址属于哪条 Route**。
- **有些 ZIP 没有 ZCTA，因此没有 polygon。** PO Box 专用 ZIP、单一机构使用的 ZIP、地址很少的 ZIP，以及 2020 年之后新设的 ZIP，通常没有对应的 ZCTA。对这些 ZIP **不伪造、不猜测 polygon**。
- 没有 USPS 官方 ZIP 列表时，无法区分“不存在的 ZIP”和“没有 ZCTA 的 ZIP”。

### 当前覆盖（SFO01，2026-10-02）

Total 269 / Mapped 254 / Missing 15（全部 `no_zcta`）：94537、94604、94615、94617、94623、94624、94662、94701、95036、95056、95151、95152、95156、95164、95173。
