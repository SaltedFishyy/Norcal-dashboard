# Open Questions（未决问题）

未确认的业务规则、需求、权限和部署问题。确认后把结论写入对应文档，并在此标记为已解决。

---

## 仓库与部署

- [x] `SaltedFishyy/Norcal-dashboard` 是 public 还是 private？→ **private**（2026-09-30）。仓库内数据按内部项目处理；credentials / cookies / session / tokens 仍绝不提交。Legacy HTML 内嵌的 Station / DSP / ZIP volume 和 price 数据已记录，不单独处理。
- [x] 旧仓库 → public historical reference，不再往里放新的内部数据（2026-09-30）。
- [ ] 本仓库是否要开启 GitHub Pages？（现阶段不开 public Pages，2026-09-30）应用在 `nc-ops-console-main/` 子目录，而 GitHub Pages “Deploy from a branch” 只支持仓库根目录或 `/docs`。若要部署，需要决定：接受 `/nc-ops-console-main/` 子路径，还是调整目录结构，还是用 GitHub Actions 部署子目录。
- [ ] 旧仓库 `cassielu0/nc-ops-console` 的 GitHub Pages 站点是否仍对外使用？是否需要与本仓库同步，还是冻结为历史版本？
- [ ] `AGENTS.md.bak-20260928`（旧版规则，已被 git 跟踪）是否保留在仓库中？它的角色描述（“Codex 是唯一开发 agent”）与当前 `AGENTS.md` 冲突，建议删除（git 历史里仍可找回）。

## Claude → Codex 自动交接

- [x] 修复 `scripts/codex-handoff.sh` 使其在 Windows Git Bash 下可用 → 已修复并通过 smoke test（2026-09-30），Mode A 为优先方式。见 `docs/workflow/claude-codex-handoff.md` 第 6 节。

## DMS 数据刷新

第一版 Q1–Q8 已于 2026-09-30 由 Product Owner 回答，结论见 `docs/features/dms-refresh.md` 第 0 节。剩余细节（详见该文件第 10 节）：

- [x] D1 Station 列表 → 来自配置文件 `config/districts.json`；不可抓取的 Station 用 `scrape_disabled` 标记（Product Owner 2026-10-07，见 `docs/features/central-db.md` 第 5 节）
- [x] D2 First-mile Distance 的单位 → mile（T2）
- [x] D3 Address Type Distribution → 占比，10 种类型（T2）
- [x] D4 Route Difficulty 由 DMS 直接提供（T2）
- [x] D4b 两者都存：`roadAreaDifficulty` 作为 `route_difficulty`（前端默认展示），人工值存 `route_difficulty_manual`，空值为 null（2026-09-30）
- [x] D8 多 Station → **已授权（Product Owner 2026-10-06）**：通过页头 Station 下拉框自动切站，双重验证后串行处理 9 个站点；结束时恢复原站点。见 `docs/features/multi-station.md`
- [x] D9 现在就保存 `roadAreaId` 作为 `route_id`（首选唯一标识）；`station + route_name` 用于展示和校验（2026-09-30）
- [ ] D5 DMS Route Name 能否与 legacy route（如 `SFO02-042`）对应
- [ ] D6 Pickup Volume 的统计窗口（目前只确认 `receiptQty` = 页面“领件量”；不猜测，不称为 Daily Volume，保留原值）
- [x] D7 session 和 runtime data 不允许被 OneDrive 同步 → 默认放在 `%LOCALAPPDATA%\nc-ops-console\`，可配置覆盖（2026-09-30）

## Route Detail / ZIP Profile

见 `docs/features/route-detail.md`。

- [ ] RD-Q1 `postalCodeTag` 的含义：样本中 `"1"` 对应页面 `94617NEW`，其余为 `"0"`。确认前只保存原值，不解释（2026-10-02）
- [ ] RD-Q2 ZIP 难易度接口只有文字没有 code，颜色按五级文字匹配；DMS 若改文字会落到灰色。是否需要找到带 code 的来源（2026-10-02）
- [ ] RD-Q3 第一版只按单条 Route 手动抓取。以后是否需要多条 / 全部 Route，以及可接受的 DMS 请求量（全部 51 条约 560 个请求）（2026-10-02）→ **部分回答（2026-10-05）**：Product Owner 要求 SFO01 全部 Route 一次性受控批量抓取（RD3，Draft）。已确认 4 秒间隔、先 `--max-routes 3` 试跑（已授权）；全量等试跑结果后再授权。仍待定：以后多久刷新一次
- [x] RD-Q5 批量抓取中任意一条 Route 失败 → **停止整个批次**，不记录后继续；依靠 cache 断点续抓（Product Owner 2026-10-05）
- [ ] RD-Q4 ZIP 指标的统计窗口（「路区画像由近 30 天的数据生成」是否同样适用于标签详情）

## Tableau Route Map

见 `docs/features/tableau-route-map.md`。

- [x] TBL-Q1 → **已解决（2026-10-02）**：使用 Route Profile 列表接口的 `postalCodeList`，存为 `postal_codes`（TBL1.5 阶段 A 结论，见 spec 第 4.1 节）。原问题：Station → Route → ZIP 的正式来源：TBL1.5 探索 DMS 是否有 Station 级批量来源；没有时在 A（人工 CSV）/ B（旧 roster）/ C（逐 Route 抓取，约 560 请求 / Station）中选择（2026-10-02）
- [ ] TBL-Q2 ZIP 归属冲突（同 Station 多 Route、或多 Station）出现时的业务规则。当前做法：抓取 / 导出失败并报告，不自动消解（2026-10-02）；SFO01 实测 0 冲突
- [ ] TBL-Q3 无 ZCTA polygon 的 ZIP 以后是否用点显示；点位坐标从哪里来（2026-10-02）
- [ ] TBL-Q4 边界截取的州范围（至少 CA + NV）和服务区 Station 清单（2026-10-02）
- [ ] TBL-Q5 `.twbx` 和导出数据以后的存放位置（Tableau Server / Cloud 或其他内部位置）（2026-10-02）
- [x] TBL-Q6 → 随 D8 解决（2026-10-06），见 `docs/features/multi-station.md`

## Web Route Map

见 `docs/features/route-map.md`。

- [x] RM-Q1 Route Profile 页面和 modal 的难度颜色 → **本轮统一为地图同一套五色**，只改显示颜色（Product Owner 2026-10-05）
- [x] RM-Q2 难易度模式选中线路时 → 其他线路**保持各自的 Route 难度颜色并淡化**，不变灰（Product Owner 2026-10-05）

## Central DB / Shared Dashboard

见 `docs/features/central-db.md`。已确认的决定（不再作为问题）：公用电脑是唯一抓取节点；刷新范围为全部或单个 District；Station 按各自完整性检查结果生效；失败后再刷新时新建 run；使用 PostgreSQL；保留 JSON 后备（观察约 2 周或至少 10 次成功刷新后再决定）；公用电脑一直开机。

- [ ] CD-Q1 刷新**运行中**意外不可用的 Station（例如菜单项消失、切站失败）：spec 的默认做法是按现有安全规则停止整个 run，确认原因后再在 `scrape_disabled` 中配置。是否接受？（2026-10-07）
- [ ] CD-Q2 公用电脑上的 DMS 使用谁的账号登录？session 过期后由谁到公用电脑上重新登录？公司政策是否允许多人共用这个账号？（2026-10-07）
- [ ] CD-Q3 办公室局域网中的任何人（包括访客 Wi-Fi）都可以不登录直接查看 Dashboard，是否可以接受？访客网络是否已与办公网络隔离？（2026-10-07）
- [ ] CD-Q4 PostgreSQL 的备份方式和保存位置，以及由谁负责公用电脑的维护（重启、更新、备份检查）？（2026-10-07，P2 / P3 前确认）
- [x] CD-Q5 → **用户登录时启动**（Product Owner 2026-10-08）；公用电脑需要开启自动登录或一直保持登录。原问题：开机启动方式：MVP 采用“当前用户登录时启动”（不需要管理员权限，有界面的浏览器可以运行），要求公用电脑设置自动登录或一直保持登录。是否需要“开机但没人登录也启动”？（需要管理员权限、保存的 Windows 密码，并且只能用无界面浏览器抓取，后者还没有在真实 DMS 上验证过）（2026-10-08）
- [x] CD-Q6 → **这台就是公用电脑，办公网络改为 Private**（Product Owner 2026-10-08），由 Product Owner 在管理员 PowerShell 中执行。原问题：这台电脑的 Wi-Fi 当前是 **Public** 网络配置文件，而 3000 端口按要求只对 Private / Domain 开放。是否把办公网络设为 Private（需要管理员权限，并确认这是可信的办公网络）？这台电脑是否就是最终的公用电脑？（2026-10-08）
- [x] CD-Q7 → **P3 暂不迁移 repo**，记为技术债 TD7（Product Owner 2026-10-08）。原问题：repo 目前在 OneDrive 的 Desktop 目录下。如果这台就是公用电脑，是否把 repo 迁到同步目录之外（例如 `C:\nc-ops-console`）？（2026-10-08）

## 仓库管理 / Warehouse

见 `docs/features/warehouses.md`。已确认的决定（D1–D13）见该文件第 2 节。

- [x] WH-Q1 → **50 km，只提醒，不阻止，确认后可以保存**（Product Owner 2026-10-09）。原问题：“离 District 太远”的阈值。spec 暂定为离该片区已上图 ZIP 外包矩形超过 50 km 时要求确认（可配置常量），是否合适？（2026-10-09）
- [x] WH-Q2 → **不为本功能新建**（Product Owner 2026-10-09），以 `docs/features/warehouses.md` 为主 spec。来源：`AGENTS.md` 第 2.2、6.1、7.1 节和 `CLAUDE.md` 第 3 节都提到维护 `REQUIREMENTS.md`，但第 6.1 节同时写明“Not all of these files exist yet. Create them when they are first needed.”，所以不是必须现在就建。原问题：`REQUIREMENTS.md` 在仓库中不存在，是否现在新建？（2026-10-09）
- [x] WH-Q3 → **接受**。误删后手动重新添加，不做 soft delete 或 audit（Product Owner 2026-10-09）。原问题：仓库删除无法恢复且局域网无登录（D4）。中央 DB 备份方案（CD-Q4）确定前，是否接受误删只能手动重新添加？（2026-10-09）

## 南加州片区 / Southern California

见 `docs/features/district.md`“南加州片区（2026-10-09）”。

- [ ] SC-Q1 这 15 个 Station 是否都在 DMS 的站点菜单中，当前账号是否都有权限？现有规则是：刷新过程中遇到菜单里没有的 Station，会停止整个 run；只有在 `scrape_disabled` 中配置过的 Station 才会被跳过。确认之前不预先配置 `scrape_disabled`。南加州排在配置末尾，所以“全部刷新”时，北加州和丹佛会先完成并各自生效。（2026-10-09）
  - **第一次抓取（2026-10-09，run `87934135…`，`--scope district:south-cal --new-run`）：**
    - CNO01 completed：41 条 Route。
    - LAX01 completed：26 条 Route。
    - LAX02 切站失败，诊断信息为 `Station LAX02 菜单项数量为 0`（`switch:StationSwitchError`）。run stopped，其余 12 个 Station 没有尝试。
    - 共 1205 个请求，没有 429、5xx 或登录问题。
    - 待 Product Owner 决定：是否给 LAX02 配置 `scrape_disabled: not_in_dms_menu`，然后继续抓取。
  - **后续（2026-10-09）：**
    - LAX03 同样出现 `菜单项数量为 0`。Product Owner 确认当前没有 LAX03，先跳过，不再尝试。
    - Product Owner 要求先抓剩下的 Station。Claude 在现有 CLI 外面加了一层串行驱动：每次切站失败就新开一个 run，从下一个 Station 继续；安全节奏不变。
    - 结果：SFV02、VTC01、SMX01、BKD01、FAT01、PLM01、SAN01、YUM02、YUM01、HNL01 全部完成（run `4373fb92…`，1457 个请求）。
    - LAX02 和 LAX03 的 `scrape_disabled` 以后统一决定，目前没有配置。
- [ ] SC-Q4 SFV01 的 Route `SFV01-006`（route_id 2958）在“画像详情”这一步两次都点击超时（`capture:SelectorError`，`locator.click: Timeout 1000ms exceeded`），所以 SFV01 整个 Station 没有激活，已经缓存了 13 条 Detail。Product Owner 2026-10-09 决定重试一次，失败就跳过，所以已跳过。需要查清：DMS 页面上这条 Route 是不是没有“画像详情”按钮？是否要改抓取逻辑或单独处理这条 Route？（2026-10-09）
- [ ] SC-Q2 YUM01 / YUM02 服务的亚利桑那 ZIP（853xx）在边界库中没有 ZCTA，会进入“缺少边界的邮编”。是否要按 `geo/README.md` 的方法补一个 AZ 边界文件？这只是数据文件，不需要改代码。南加州（857 个 ZIP）和夏威夷（98 个 ZIP）已经覆盖。（2026-10-09）
- [ ] SC-Q3 南加州、Yuma、夏威夷目前只有全美的低精度底图（`us`，z0–6），放大后会比较模糊。是否需要新增一个区域底图？需要生成 PMTiles，并在底图白名单中加一项。（2026-10-09）

## 片区管理 / District Management

见 `docs/features/district-admin.md`。已确认的决定（A1–A12）见该文件第 2 节。

- [x] DA-Q1 → **本期不做**（PO 2026-10-09，A13）。原问题：刷新预览中，是否标注“上次不可用”的 Station（例如上一个 run 中切站失败的 LAX02、LAX03）？只作为提示，不自动跳过，跳过仍然只由 `scrape_disabled` 决定。本期默认**不做**。（2026-10-09）
- [x] DA-Q2 → **加入 `DISTRICT_SOURCE=file|db` 开关，默认为 file**（PO 2026-10-09，A14）。原问题：部署窗口：DA-T2 把读取路径切换到数据库之后，正式服务必须在“migration 004 + 种子导入”完成后才能重启，否则选择器会因为 503 `district_config_unavailable` 而无法使用。由于服务直接从 repo 工作区运行，实现到部署之间不能重启正式服务。是否接受？还是希望 DA-T2 增加一个临时开关（例如 `DISTRICT_SOURCE=file|db`），先合入代码、部署时再切换？（2026-10-09）
- [x] DA-Q3 → **新加入的 Station 排在片区末尾，不提供排序调整**（PO 2026-10-09，A15）。原问题：新加入片区的 Station 默认排在片区末尾，本期不提供排序调整。是否可以？（2026-10-09）
- [x] DA-Q4 → **不做审计**（PO 2026-10-09，A16）。原问题：片区归属的变更不记录操作人和历史（与仓库功能一致，不做审计），只保留 `district_config_version` 和 `updated_at`。是否可以？（2026-10-09）

## Route Difficulty

- [ ] 什么 PPH 范围算 Hard？
- [ ] 难度按 ZIP 级还是 Route 级判定？
- [ ] Volume 是否影响难度？

## Route Quotation / DSP 报价

见 `docs/features/route-quotation.md`（设计 Approved 2026-11-05）。以下问题基于 7 份已填写的报价模板样例。

- [x] RQ-Q1 → **报价日期允许为空，只作为来源元数据，不参与当前价格判断；当前价格只看生效 / 结束日期**（PO 2026-11-05，RQ-D11）。原问题：报价模板没有「报价日期 / Quotation Date」列。报价日期从哪里来：「GOFO派费报价确认」PDF 的确认日期、Lark 中新增字段，还是不显示？确认前该字段可为空，详情显示 `—`。（2026-11-05）
- [x] RQ-Q2 → **临时报价结束后原长期报价自动恢复；`effective_date <= 当日 <= end_date`，结束日当天有效，`end_date` 为空长期有效；同日多条取生效日期最新者，生效日期也相同则导入时报冲突**（PO 2026-11-05，RQ-D12 / D13）。原问题：临时报价（样例：生效 1 周后结束）会与已有长期报价重叠。建议规则：有效期内生效日期最新的报价生效；临时报价结束后，如原长期报价仍在有效期内则恢复显示。是否正确？另外「报价结束日期」当天是否仍有效（按含结束日设计）？（2026-11-05）
- [ ] RQ-Q3 Station 列写法不统一（`OAR`、`SCK`、`SMF` 与 `SFO02` 并存）。建议只保存原值，Station 一律由 Route 在 DMS 中解析。是否可以？（2026-11-05）
- [ ] RQ-Q4 Fleet 列（如 `OAR-WDA`）与 DMS `dsp_name` 写法可能不同。不一致时只警告、不拒绝，详情显示 Fleet 原值。是否可以？（2026-11-05）
- [ ] RQ-Q5 「参考邮编（唯一值）」在样例中全部等于「邮编」，含义是什么？是否可能与邮编不同？确认前只保存原值，以「邮编」为键。（2026-11-05）
- [ ] RQ-Q6 坏数据（样例中结束日期出现 `11/1/20217`）：建议整批拒绝并报告行号，不自动修正。是否可以？（2026-11-05）
- [x] RQ-Q7 → **Route 找不到：不猜、不模糊匹配，拒绝该行并报告；不因个别行拒绝整个文件。Claude 评估后采用行级部分导入（文件级错误仍整份拒绝，相同内容重导跳过）**（PO 2026-11-05，RQ-D14，spec 第 8.1 节）。原问题：报价中的 Route 在 DMS active snapshot 中找不到（新线路尚未出现在 DMS）：建议整批拒绝，待 DMS 刷新后重新导入。ZIP 不在该 Route 当前 ZIP 中（切线先于 DMS 更新）：只警告。是否可以？（2026-11-05）
- [ ] RQ-Q8 第二个 sheet「电子围栏附加费」本阶段不做，以后单独设计。是否可以？（2026-11-05）
- [x] RQ-Q9 → **首批 XLSX 导入暂不处理，不加依赖；等正式报价文件 / Lark 数据源准备好后再做**（PO 2026-11-05，RQ-D15）。原问题：Lark 同步之前，首批报价数据怎么进库：是否有完整的北加州报价总表（本机只发现 `北加州报价表10.08.xlsx` 的锁文件，未找到文件本身），还是逐份导入变更文件？导入工具需要读 xlsx 时会涉及新依赖，需另行批准。（2026-11-05）
- [ ] RQ-Q10 模板表头有笔误 `1-5((lb)`，展示时是否统一为 `1-5(lb)`？（2026-11-05）

## Lark 报价同步 / Lark Quotation Sync

见 `docs/features/lark-quotation-sync.md`（Draft 2026-11-06）和配置交接 `docs/workflow/lark-quotation-handoff.md`。

- [x] LQ-Q1 同步语义：Lark 表格是完整的当前报价总表，还是只记录变更？建议按总表「镜像」处理：表格中某行被修改则作废旧行写入新行，被删除则作废该行（均保留历史）；读取或表头失败时不改动数据；有效行数较上次减少超过 20% 时中止。需要修改 RQ 第 8 节和 RQ-D13 对 `lark_sheet` 来源的适用范围。是否同意？（2026-11-06） → **镜像**（Product Owner 2026-11-06，LQ-D2）：修改报价时更新、删除行时作废旧报价、历史保留；读取或表头失败不改库；拒绝行不能当作删除。
- [x] LQ-Q2 表格结构：实际表头行位置、列名（截图 DSP 列为「转运中心/DSP」，模板为「车队名称/Fleet」）、是否有合并单元格 / 隐藏行 / 筛选视图 / 多个工作表？由 LQ-T0 后的只读验证确认，需要 Product Owner 确认验证结果。（2026-11-06） 验证结果（2026-11-06）：SFO 分表表头在第 1–3 行、数据从第 4 行开始；DSP 列实际为「转运中心/Sorting Center」；有合并表头；共 53 个工作表、结构不统一；详见 `docs/workflow/lark-quotation-handoff.md` 5.1。 → **已确认**（2026-11-06）：按交接文档 5.1 的验证结果实现。
- [x] LQ-Q3 显示范围：2026-11-05 已决定（RQ-D9）地图 hover 和线路档案只显示 0–1 lb 首票，其他首票重量档和续票只在价格详情显示，且已实现并预览签字。是否维持？如改为 hover 显示全部首票重量档，需要改 RQ-T3。（2026-11-06） → **维持**（Product Owner 2026-11-06，LQ-D4）：hover 和线路档案只显示 0–1 lb 首票。
- [x] LQ-Q4 价格为 0 是否是合法报价？确认前：空单元格拒绝该行（永不转为 0），显式 0 接受但记警告。（2026-11-06） → **价格 0 不是正常报价**，拒绝该行并记录原因（Product Owner 2026-11-06，LQ-D3）。
- [x] LQ-Q5 同步频率与开启时间：建议每 60 分钟；默认关闭，正式库 migration 与首次手动同步通过后再开启。（2026-11-06） → **每 60 分钟**（Product Owner 2026-11-06）；正式库 migration 与首次手动同步通过后于 2026-11-06 开启。
- [ ] LQ-Q6 「转运中心/DSP」列含义：是否就是该线路的 DSP / 车队？同一线路 + 邮编是否可能同时有多家 DSP 报价？（2026-11-06）
- [ ] LQ-Q7 谁维护表格、多久更新一次？表格修改后 Dashboard 允许的最大延迟是多少？（2026-11-06）
- [ ] LQ-Q8 测试库需要管理员用 `nc_admin` 创建 `nc_test_quotation` 角色并在本机 `.env` 配置 `NC_TEST_DB_QUOTATION_URL`，LQ-T1 才能运行写入权限测试。由谁、何时执行？（2026-11-06）
- [x] LQ-Q9 读取范围：2026-11-06 只读验证确认链接中的 `iwYw5J` 是「总表」（FILTER 公式汇总各分表，只有 7 个重量段，无续票、无生效 / 结束日期），无法作为来源；SFO 分表是 `uAaPvG`。建议只读站点分表、使用显式工作表白名单（每张表单独按表头文字校验），第一阶段只接 SFO（`uAaPvG`，覆盖 DMS SFO01 + SFO02），其他站点逐个验证后加入。是否同意？（2026-11-06） → **同意**（Product Owner 2026-11-06，LQ-D1）：第一阶段只读 SFO 分表 `uAaPvG`。
- [x] LQ-Q10 SFO 分表 V 列「是否使用第二票半价」（模板中没有）：261 行为「是」，8 行误填了备注文字。该标记是否改变续票价格列（M–S）的含义（例如续票 = 首票半价，而 M–S 只是参考）？建议先只原样保存并在价格详情显示，不参与计算；非「是 / 否」的值记警告。另外 `SFO02-002`（8 行）不在 DMS 当前线路中，按 RQ 规则拒绝，是否符合预期？（2026-11-06） → 不影响首票；本阶段只保存原值，不改变续票计算（LQ-D5）。`SFO02-002` 暂不导入，报告原因，不自动替换线路（LQ-D6）。
- [ ] LQ-Q11 SFV 分表（`sZuGSc`）有两个生效日期列：T「报价生效日期」和 X「生效日期」，而且 83 行数据在 T、U（结束日期）、X 三列**全部为空**。是表格还没有填日期，还是日期在别处？在表格维护方补齐日期、并确定以哪一列为准之前，SFV 保持表头无效、不导入（LQ-D16）。（2026-11-06）
- [ ] LQ-Q12 表格数据修正（由表格维护方处理，修正后定时同步自然生效）：Denver 有 5 行生效 / 结束日期单元格的内容就是文本 `########`（不是列宽导致，原始值相同），修正前按 `date_placeholder` 拒绝；BOI 有 21 行没有日期；IDA / BIL 共 24 行线路名为空（疑似合并单元格，不自动填充，LQ-D15）；IFP 表的线路名与 DMS IFP01 一条都对不上。（2026-11-06）
- [ ] LQ-Q13 LQ-T7 后摸底发现的格式问题（详见 `docs/workflow/lark-quotation-handoff.md` 5.3）：(a) 是否接受 `YYYY-MM-DD` 日期（LAX01 17 行）？(b) 是否接受两位年份 `MM/DD/YY` 并按 20YY 解释（STG）？(c) 数字日期序列号（LAX02 / LAV 各 2 行）是否继续拒绝？(d) OAR 的 `40-999999(Ib)` 是否视为「40(lb)以上」？(e) 南加州 8 张表的生效日期大多为空、IFP 线路名带空格，需要表格维护方修正。（2026-11-06）
