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

- [ ] 是否要修复 `scripts/codex-handoff.sh` 使其在 Windows Git Bash 下可用？现状见 `docs/workflow/claude-codex-handoff.md` 第 6 节。修复前默认使用手动交接（Mode B）。

## DMS 数据刷新

第一版 Q1–Q8 已于 2026-09-30 由 Product Owner 回答，结论见 `docs/features/dms-refresh.md` 第 0 节。剩余细节（详见该文件第 10 节）：

- [ ] D1 Station 列表来自配置文件还是 DMS？
- [ ] D2 First-mile Distance 的单位和口径
- [ ] D3 Address Type Distribution 的类型和形式（占比 / 数量）
- [ ] D4 Route Difficulty 是否由 DMS 直接提供（不是则第一阶段不显示，不自行推算）
- [ ] D5 DMS Route Name 能否与 legacy route（如 `SFO02-042`）对应
- [ ] D6 Pickup Volume 的统计窗口
- [x] D7 session 和 runtime data 不允许被 OneDrive 同步 → 默认放在 `%LOCALAPPDATA%\nc-ops-console\`，可配置覆盖（2026-09-30）

## Route Difficulty

- [ ] 什么 PPH 范围算 Hard？
- [ ] 难度按 ZIP 级还是 Route 级判定？
- [ ] Volume 是否影响难度？
