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

**先确认 spec / task brief 已写好：** 目标、涉及范围、可检查的验收标准（AC1、AC2…）。任务文件必须放在仓库内（正式 spec 放 `docs/features/`；临时 task brief 可放 `.handoff/briefs/`，已被 gitignore）。

### Mode A — 自动交接（优先）

2026-09-30 起在 Windows 11 + Git Bash 上验证通过（见第 6 节），**默认优先使用**。

```text
1. 第 0 轮：bash scripts/codex-handoff.sh <task.md>
2. Claude 审查（自动进行，不需要 Product Owner 转述）：
   - 读 last-message.md（Codex 总结）和 changes.diff / changed-files.txt（本轮实际变化）
   - 检查实际文件，必要时运行测试
   - 按 AGENTS.md 第 8 节逐条对照 spec 和验收标准
3. 有问题：Claude 写 review 文件 .handoff/reviews/<slug>-r<轮次>.md，自动交回 Codex 修复
      bash scripts/codex-handoff.sh <task.md> --fix <review.md> --round 1
   仍有问题最多再来一轮 --round 2（脚本拒绝 --round 3 及以上）
4. Claude 向 Product Owner 汇报：改了什么、验收结果、仍存在的问题、如何本地预览
```

**以下情况立即停止自动修复，直接向 Product Owner 汇报**（不为了用满两轮而让 Codex 猜）：

- 需求冲突（requirement conflict）
- 架构决策（architecture decision）
- 安全 / 权限问题（security / permission issue）
- 数据含义不明确（data ambiguity）
- 其他需要 Product Owner 决定的问题

脚本或 Codex 失败时：Claude 读取 `stderr.log` 和 `exit-code`，原样报告错误，不声称交接成功；需要时改用 Mode B。

### Mode B — 手动交接（fallback）

适用于：Mode A 失败；任务需要 Codex 沙箱做不到的操作（例如联网安装依赖，见第 6 节已知限制）；或 Product Owner 希望自己在 Codex CLI 里交互执行。

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

- 修复最多 **2 轮**。两轮后仍未通过，Claude 停止并如实汇报。遇到上面列出的需要 Product Owner 决定的问题时立即停止（`AGENTS.md` 第 7.4 节）。
- review 问题写明：位置、现象、期望、对应验收标准。
- UI 功能在 Product Owner 预览确认前不算完成（`AGENTS.md` 第 9 节）。

## 3. 脚本说明：`scripts/codex-handoff.sh`

1. `set -euo pipefail`；启动前检查 `git`、`codex`，缺失时立即退出（退出码 127）。任务文件不存在、不在仓库内、修复轮缺少 review 文件、轮次超过 2 时也会立即退出。
2. **运行前快照：** 记录 `git status`，并用临时 git index 把整个工作区（tracked + untracked，排除 gitignored）写成一个 tree 对象。不修改真实 index，也不修改任何文件；快照失败时停止，不会启动 Codex。
3. 生成 `prompt.md`：要求 Codex 先读 AGENTS.md 和任务文件、检查当前仓库结构、不假设项目是纯静态站、只做任务范围内改动、不清楚就停止、禁止 commit / push / 部署 / 写入凭据、按第 11 节格式总结。
4. 调用：`codex exec -C <仓库根> -s workspace-write --color never --json -o last-message.md -`（Windows 下路径自动转换为原生格式）。
5. **运行后快照**，对比前后两个 tree 生成 `changes.diff` 和 `changed-files.txt`。因此：
   - 运行前已存在的未提交改动（例如另一个进行中的任务）**不会**被算作本轮改动；
   - 新建的 untracked 文件会被捕获。
6. Codex 失败时也会生成全部产物。退出码非 0 或没有最终回复时，脚本以非 0 退出并打印 `stderr.log` 末尾。

每次运行的产物在 `.handoff/runs/<时间戳>-<任务名>-r<轮次>/`（已被 gitignore，仅本地保留）：

| 文件 | 内容 |
|---|---|
| `prompt.md` | 发给 Codex 的完整指令 |
| `status-before.txt` / `status-after.txt` | 运行前 / 后的 `git status --porcelain`（含 untracked） |
| `changes.diff` | 本轮 Codex 造成的变化 |
| `changed-files.txt` | 本轮变化的文件清单（A / M / D） |
| `last-message.md` | Codex 最终回复（失败时可能为空） |
| `events.jsonl` | Codex 事件流 |
| `stderr.log` | Codex 标准错误输出 |
| `exit-code` | Codex 退出码 |
| `snapshot.log` | 快照过程的 git 警告（通常为空） |

## 4. 安全边界

- 脚本、Claude 和 Codex 都不会 `git commit`、`git push`、部署或发布 GitHub Pages。
- 不向 Codex 传递任何凭据；Codex 使用本机已登录的账户。
- gitignored 文件（如 `.env`）不会进入快照和 diff。
- 涉及真实内部数据上公开页面时，仍需 Product Owner 按 `AGENTS.md` 第 14 节确认。

## 5. 手动运行脚本

脚本是 bash 脚本。在 PowerShell 中不能直接执行 `.sh`，需要通过 Git Bash：

```powershell
cd C:\Users\kenny\OneDrive\Desktop\Norcal-dashboard
bash scripts/codex-handoff.sh docs/features/<slug>.md
```

（macOS / Linux 下可直接运行 `scripts/codex-handoff.sh ...`。）`.gitattributes` 固定 `*.sh` 为 LF 换行，Windows checkout 后仍可执行。

## 6. 平台兼容性与验证记录

| 日期 | 环境 | 结果 |
|---|---|---|
| 2026-09-28 | macOS（原开发机），旧版脚本（rsync 快照） | `docs/features/handoff-smoke-test.md` 冒烟测试通过 |
| 2026-09-30 | Windows 11 + Git Bash（MSYS2 bash 5.3），codex-cli 0.159.2，旧版脚本 | 不可用：缺 `rsync`，会误报“无文件变更” |
| 2026-09-30 | 同上，**新版脚本（git 快照）** | **通过。** 第 0 轮：Codex 新建临时文件，`changes.diff` 正确捕获（A），`exit-code` 为 0，`last-message.md` 正常，`status-before/after` 只多出该文件；当时工作区有 T1 的未提交改动，未被误算。第 1 轮（`--fix --round 1`）：修改该文件，diff 正确捕获（M）。模拟 Codex 失败（退出码 7）：全部产物保留，脚本以 7 退出。`--round 3`、缺少 `git` / `codex` 时正确拒绝。测试文件已清理。单次运行约 40 秒 |
| 2026-10-01 | 同上，codex-cli 0.159.2，Windows Terminal，**新增 `scripts/codex-watch.mjs`（第 7 节）**，`codex-handoff.sh` 未改 | **通过。** Mode A 冒烟任务（两次约 20 秒的等待、一次故意失败、新建并修改一个临时文件）：Claude 在后台启动脚本后，用 `--window` 成功打开 Windows Terminal 观察窗口（标题 `Codex watch: <run>`）；进程列表中只有一条 `codex exec`。另一个 watcher 采样显示事件实时出现（命令开始约 20 秒后显示“命令完成”）。运行中结束窗口里的 watcher 进程，Codex 继续运行；再次 `--window` 打开时会先补显示已有事件再继续跟踪。Codex 退出码 0，`stderr.log` 为空，`changes.diff` / `changed-files.txt` 只包含该临时文件（A），工作区里 T6 的未提交改动没有被算进去。失败命令显示为 `✖ 命令失败` 并附带输出。`npm test` 85/85。临时文件已清理 |

已知限制：

1. **Codex 沙箱的限制：** `workspace-write` 下 Codex 默认不能联网，在 Windows 上曾因 EACCES / EPERM 无法完成 `npm install` 等操作（T1 时遇到）。`codex exec` 是非交互的，无法中途请求批准。需要安装依赖或联网的任务，改用 Mode B，或由 Product Owner 先完成安装。
2. **gitignored 文件的变化不会被捕获**（例如 `node_modules/`、`.env`、`.handoff/`）。这是有意的设计；需要时 Claude 另行检查。
3. **运行期间不要手动修改仓库文件**，否则这些修改会被计入本轮 Codex 的改动。
4. **Claude 工具超时：** Claude 的单条命令最长 10 分钟。预计更长的任务，Claude 应在后台运行脚本，并等待完成通知。
5. 快照会在 `.git/objects` 中留下少量松散对象，不影响仓库，`git gc` 会清理。

## 7. 可选的只读观察窗口（codex-watch）

`scripts/codex-watch.mjs` 是可选的旁观者：只读取 run 产物，不参与任务执行，不写任何文件，不启动 Codex。它不改变 Mode A 的 artifacts，也不改变 review / fix 流程。关闭 watcher 窗口或按 Ctrl+C 只退出 watcher，不影响后台 Codex。

Claude 可在 Mode A 已生成 run 目录后，自动执行下面的命令打开一个独立 Windows Terminal 窗口；该窗口结束时等待按 Enter 关闭：

```powershell
node scripts/codex-watch.mjs --window .handoff/runs/<run-name>
```

Product Owner 也可以在 VS Code / PowerShell 终端手动观察：

```powershell
node scripts/codex-watch.mjs
node scripts/codex-watch.mjs .handoff/runs/<run-name>
node scripts/codex-watch.mjs --hold .handoff/runs/<run-name>
```

无参数时选择目录名排序后的最新 run；没有 run 时等待第一个 run 出现。选定后持续观察该 run，不自动切换。指定目录可以是相对当前工作目录的路径或绝对路径；默认 run 搜索位置由脚本位置确定，不依赖当前工作目录。

回看已完成的 run：

```powershell
node scripts/codex-watch.mjs --once .handoff/runs/<run-name>
node scripts/codex-watch.mjs --help
```

watcher 每约 500ms 读取新增事件，显示会话、命令、文件变化和 Codex 消息。它显示的是 JSONL 事件，而不是逐字输出或完整命令日志。非法 JSON 行会警告并跳过。run 结束摘要包含 Codex 退出码、变更文件和最终回复路径；watcher 正常退出码为 0，与 Codex 的退出码无关。默认结束时最多等待约 15 秒生成 `changed-files.txt`；`--once` 不等待，缺失时显示“尚未生成”。

`--window` 依赖本机可用的 `wt.exe`，无 run 时会报错，启动失败会给出手动命令。2026-10-01 已在本机验证（见第 6 节）。其余模式仅需要 Node，无新增依赖。路径不应包含 `;`（Windows Terminal 会将其作为命令分隔符）。

watcher 的已知限制：

1. **只显示 Codex 用自己的编辑工具改的文件。** Codex 通过 shell 命令写文件时（例如 PowerShell `WriteAllText`），watcher 只显示那条命令，不会显示 `＋ 新增文件` / `✎ 修改文件`。本轮实际改了哪些文件，以 `changes.diff` / `changed-files.txt` 为准。
2. **显示的是事件，不是逐字输出。** 一条命令只在开始和结束时各显示一行；命令运行期间没有新输出。
3. **失败命令的退出码以 Codex 报告的为准。** Codex 在 Windows 上通过 PowerShell 包装执行命令，内部的退出码（例如 3）可能显示为 1。
4. **无参数模式只选启动时的最新 run。** Claude 打开窗口时应传入本次 run 目录（脚本启动时会输出 `输出目录: ...`），避免选到上一次 run。

Claude 的固定做法：后台启动 `codex-handoff.sh` → 从输出中读取 run 目录 → 运行 `node scripts/codex-watch.mjs --window <run-dir>`。打开窗口失败时把手动命令告诉 Product Owner，交接本身照常进行。
