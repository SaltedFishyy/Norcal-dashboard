# Claude → Codex → Claude 交接流程

本文件说明 AGENTS.md 第 7 节工作流的自动化执行方式。角色与规则以 AGENTS.md 为准。

## 1. 触发规则

| Product Owner 的话 | Claude 做什么 | 是否启动 Codex |
|---|---|---|
| 描述 / 讨论需求 | 分析需求、检查现有代码、提出问题和替代方案 | 否 |
| “保存需求 / 写成文档” | 写或更新 `docs/features/<slug>.md`（必要时 `docs/open-questions.md`） | 否 |
| **“开始实现”** 或 **“运行工作流”** | 执行下面第 2 节的完整流程 | **是** |

没有这两句明确指令时，Claude 不会调用 Codex。

## 2. 完整流程

```text
1. Claude 确认 spec 已写好：目标、涉及范围、可检查的验收标准（AC1、AC2…）
2. 第 0 轮：scripts/codex-handoff.sh docs/features/<slug>.md
3. Claude 审查：读取 last-message.md、changes.diff、实际代码，必要时本地运行页面，逐条核对验收标准
4. 如有具体问题：Claude 写 review 文件，交回 Codex 修复
      scripts/codex-handoff.sh docs/features/<slug>.md --fix <review.md> --round 1
   再审查；仍有问题最多再来一轮 --round 2
5. Claude 向 Product Owner 汇报：改了什么、验收结果、仍存在的问题、如何本地预览
```

- 修复最多 **2 轮**（脚本对 `--round 3` 及以上直接拒绝）。两轮后仍未通过，Claude 停止并如实汇报。
- review 文件建议放在 `.handoff/reviews/<slug>-r<轮次>.md`，每个问题写明：位置、现象、期望、对应验收标准。
- UI 功能在 Product Owner 预览确认前不算完成（AGENTS.md 第 9 节）。

## 3. 脚本说明：`scripts/codex-handoff.sh`

它做的事：

1. 运行前给仓库做快照（仓库目前不是 git 仓库，无法用 `git diff`）。
2. 生成指令 `prompt.md`：要求 Codex 读 AGENTS.md 和 spec、只做 spec 范围、禁止 commit/push/部署、按第 11 节格式总结。
3. 调用：`codex exec -C <仓库根> -s workspace-write --skip-git-repo-check --json -o last-message.md`
   - `workspace-write`：Codex 只能写仓库目录，默认无网络。
4. 运行后生成 `changes.diff`，打印变更文件和退出码。
5. Codex 退出码非 0 或没有最终回复时，脚本以非 0 退出并打印 stderr 末尾，Claude 必须原样报告错误。

每次运行的产物在 `.handoff/runs/<时间戳>-<slug>-r<轮次>/`（已加入 `.gitignore`，仅本地保留）。

## 4. 安全边界

- 脚本和 Codex 都不会 `git commit`、`git push`、部署或发布 GitHub Pages。
- 不向 Codex 传递任何凭据；Codex 使用本机已登录的 `~/.codex` 账户。
- 涉及真实内部数据上公开页面时，仍需 Product Owner 按 AGENTS.md 第 14 节确认。

## 5. 手动使用

Product Owner 也可以自己运行：

```bash
cd ~/Desktop/北加州数据看板
scripts/codex-handoff.sh docs/features/<slug>.md
```

## 6. 已验证

- 2026-09-28：`docs/features/handoff-smoke-test.md` 冒烟测试，结果见该文件的实现记录。
