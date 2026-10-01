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

- [ ] D1 Station 列表来自配置文件还是 DMS？
- [x] D2 First-mile Distance 的单位 → mile（T2）
- [x] D3 Address Type Distribution → 占比，10 种类型（T2）
- [x] D4 Route Difficulty 由 DMS 直接提供（T2）
- [x] D4b 两者都存：`roadAreaDifficulty` 作为 `route_difficulty`（前端默认展示），人工值存 `route_difficulty_manual`，空值为 null（2026-09-30）
- [ ] D8 多 Station：现在不自动切换页头全局站点；T3 稳定后再设计受控测试（记录原站点 → MFR01 → 验证 → 切回），需 Product Owner 明确授权才执行（2026-09-30）
- [x] D9 现在就保存 `roadAreaId` 作为 `route_id`（首选唯一标识）；`station + route_name` 用于展示和校验（2026-09-30）
- [ ] D5 DMS Route Name 能否与 legacy route（如 `SFO02-042`）对应
- [ ] D6 Pickup Volume 的统计窗口（目前只确认 `receiptQty` = 页面“领件量”；不猜测，不称为 Daily Volume，保留原值）
- [x] D7 session 和 runtime data 不允许被 OneDrive 同步 → 默认放在 `%LOCALAPPDATA%\nc-ops-console\`，可配置覆盖（2026-09-30）

## Route Difficulty

- [ ] 什么 PPH 范围算 Hard？
- [ ] 难度按 ZIP 级还是 Route 级判定？
- [ ] Volume 是否影响难度？
