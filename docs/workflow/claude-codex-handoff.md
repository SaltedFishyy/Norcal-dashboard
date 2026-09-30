# Claude → Codex → Claude 交接流程

本文件说明 `AGENTS.md` 第 7.4 节交接流程的具体执行方式。角色与规则以 `AGENTS.md` 为准，Claude 的行为细节见 `CLAUDE.md`。

## 1. 触发规则

| Product Owner 的话 | Claude 做什么 | 是否启动 Codex |
|---|---|---|
| 描述 / 讨论需求 | 分析需求、检查现有代码、提出问题和替代方案 | 否 |
| “保存需求 / 写成文档” | 写或更新 `docs/features/<slug>.md`（必要时 `docs/open-questions.md`） | 否 |
| 明确授权实现（如“开始实现”“开始做吧”“交给 Codex 实现”） | 执行下面第 2 节的流程 | **是** |

不要求固定措辞，但必须是明确授权（`AGENTS.md` 第 7.4 节）。确认理解、保存 spec 不算。

## 2. 两种交接方式

**先确认 spec 已写好：** 目标、涉及范围、可检查的验收标准（AC1、AC2…）。

### Mode A — 自动交接（可选）

仅在 `scripts/codex-handoff.sh` 已在当前环境验证可用时使用（当前 Windows 环境**未满足**，见第 6 节）。

```text
1. 第 0 轮：bash scripts/codex-handoff.sh docs/features/<slug>.md
2. Claude 审查：last-message.md、changes.diff、实际代码，逐条核对验收标准
3. 有问题：Claude 写 review 文件，交回 Codex 修复
      bash scripts/codex-handoff.sh docs/features/<slug>.md --fix <review.md> --round 1
   仍有问题最多再来一轮 --round 2
4. Claude 向 Product Owner 汇报
```

脚本失败时：Claude 原样报告错误，不声称交接成功，改用 Mode B。

### Mode B — 手动交接（默认后备）

```text
1. Claude 输出完整的 Codex task brief（AGENTS.md 第 7.2 节），并注明 spec 路径
2. Product Owner 在仓库根目录打开 Codex CLI（例如在 VS Code 终端运行 codex），粘贴 task brief 执行
3. Codex 完成后，Product Owner 告诉 Claude “Codex 做完了”（可附上 Codex 的最终总结）
4. Claude 审查：git diff、实际代码、Codex 总结，逐条核对验收标准
5. 有问题：Claude 输出修复用的 review brief，Product Owner 交给 Codex；最多两轮
6. Claude 向 Product Owner 汇报
```

Task brief 建议包含以下固定开头，保证 Codex 读规则：

```text
你是本仓库的 Software Engineer（Codex）。请严格遵守仓库根目录 AGENTS.md。
本次任务的 spec：docs/features/<slug>.md
先读 AGENTS.md 和 spec，再检查相关现有代码；只做 spec 范围内的改动；
spec 不清楚或与现有代码冲突时停止并说明，不要猜测。
禁止 git commit / push / 部署 / 写入任何凭据。
完成后按 AGENTS.md 第 11 节格式总结，并逐条说明每个验收标准是否满足。
```

### 两种方式共同规则

- 修复最多 **2 轮**。两轮后仍未通过，Claude 停止并如实汇报。遇到需要 Product Owner 决定的问题时立即停止（`AGENTS.md` 第 7.4 节）。
- review 问题写明：位置、现象、期望、对应验收标准。Mode A 的 review 文件放在 `.handoff/reviews/<slug>-r<轮次>.md`。
- UI 功能在 Product Owner 预览确认前不算完成（`AGENTS.md` 第 9 节）。

## 3. 脚本说明：`scripts/codex-handoff.sh`

它做的事：

1. 运行前用 `rsync` 给仓库做快照，用于生成本轮 diff（脚本编写时仓库还不是 git 仓库；现在已是 git 仓库，也可以直接用 `git diff`）。
2. 生成指令 `prompt.md`：要求 Codex 读 AGENTS.md 和 spec、只做 spec 范围、禁止 commit/push/部署、按第 11 节格式总结。
3. 调用：`codex exec -C <仓库根> -s workspace-write --skip-git-repo-check --json -o last-message.md`
   - `workspace-write`：Codex 只能写仓库目录，默认无网络。
4. 运行后生成 `changes.diff`，打印变更文件和退出码。
5. Codex 退出码非 0 或没有最终回复时，脚本以非 0 退出并打印 stderr 末尾。

每次运行的产物在 `.handoff/runs/<时间戳>-<slug>-r<轮次>/`（已加入 `.gitignore`，仅本地保留）。

## 4. 安全边界

- 脚本、Claude 和 Codex 都不会 `git commit`、`git push`、部署或发布 GitHub Pages。
- 不向 Codex 传递任何凭据；Codex 使用本机已登录的账户。
- 涉及真实内部数据上公开页面时，仍需 Product Owner 按 `AGENTS.md` 第 14 节确认。

## 5. 手动运行脚本

脚本是 bash 脚本。在 PowerShell 中不能直接执行 `.sh`，需要通过 Git Bash：

```powershell
cd C:\Users\kenny\OneDrive\Desktop\Norcal-dashboard
bash scripts/codex-handoff.sh docs/features/<slug>.md
```

（macOS / Linux 下可直接运行 `scripts/codex-handoff.sh ...`。）

## 6. 平台兼容性与验证记录

| 日期 | 环境 | 结果 |
|---|---|---|
| 2026-09-28 | macOS（原开发机） | `docs/features/handoff-smoke-test.md` 冒烟测试通过 |
| 2026-09-30 | Windows 11 + Git Bash（MSYS2 bash 5.3），codex-cli 0.159.2 | **未通过完整运行（未启动 Codex）**。参数检查正常；但发现下列问题 |

Windows 下的已知问题（2026-09-30 检查，未修改脚本）：

1. **缺少 `rsync`**：Git for Windows 默认不带 `rsync`。脚本没有检查它，且未使用 `set -e`，因此快照失败后仍会继续启动 Codex；之后 `diff` 对比不存在的快照目录会直接报错，`changes.diff` 为空，脚本会打印“（无文件变更）”——即使 Codex 实际改了文件。审查结果会被误导。
2. **CRLF 换行**：本机 `core.autocrlf=true`，检出的 `.sh` 是 CRLF。本机 Git Bash 目前能执行，但不同 bash 环境可能报错。仓库没有 `.gitattributes` 固定 `*.sh` 为 LF。
3. **PowerShell 不能直接运行**：必须通过 `bash scripts/codex-handoff.sh`。
4. **文档路径过时**：旧版本文件中的 `cd ~/Desktop/北加州数据看板` 是原 macOS 路径（已在本版更正）。

可能的修复方向（需 Product Owner 同意后，作为单独的 Codex 任务）：

- 用 `git diff` / `git status` 代替 `rsync` 快照（仓库现在是 git 仓库）；或在缺少 `rsync` 时退回 `cp -a`。
- 启动 Codex 前检查所有依赖命令，缺失时立即退出。
- 新增 `.gitattributes`：`*.sh text eol=lf`。
- 修复后在 Windows 上重新跑一次冒烟测试，并更新本节记录。
