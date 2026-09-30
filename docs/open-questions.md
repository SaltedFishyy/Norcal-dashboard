# Open Questions（未决问题）

未确认的业务规则、需求、权限和部署问题。确认后把结论写入对应文档，并在此标记为已解决。

---

## 仓库与部署

- [ ] `SaltedFishyy/Norcal-dashboard` 是 public 还是 private？（决定 `AGENTS.md` 第 14 节中“公开页面”限制的具体适用范围）
- [ ] 本仓库是否要开启 GitHub Pages？应用在 `nc-ops-console-main/` 子目录，而 GitHub Pages “Deploy from a branch” 只支持仓库根目录或 `/docs`。若要部署，需要决定：接受 `/nc-ops-console-main/` 子路径，还是调整目录结构，还是用 GitHub Actions 部署子目录。
- [ ] 旧仓库 `cassielu0/nc-ops-console` 的 GitHub Pages 站点是否仍对外使用？是否需要与本仓库同步，还是冻结为历史版本？
- [ ] `AGENTS.md.bak-20260928`（旧版规则，已被 git 跟踪）是否保留在仓库中？它的角色描述（“Codex 是唯一开发 agent”）与当前 `AGENTS.md` 冲突，建议删除（git 历史里仍可找回）。

## Claude → Codex 自动交接

- [ ] 是否要修复 `scripts/codex-handoff.sh` 使其在 Windows Git Bash 下可用？现状见 `docs/workflow/claude-codex-handoff.md` 第 6 节。修复前默认使用手动交接（Mode B）。

## Route Difficulty

- [ ] 什么 PPH 范围算 Hard？
- [ ] 难度按 ZIP 级还是 Route 级判定？
- [ ] Volume 是否影响难度？
