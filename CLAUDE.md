# CLAUDE.md

本文件是 **Claude 自己的工作流程和行为规则**。

- `AGENTS.md`：长期、项目级、所有 agent（Claude、Codex、人）共用的规则。
- `CLAUDE.md`（本文件）：只约束 Claude，说明 Claude 如何执行 `AGENTS.md` 中分配给它的角色（`AGENTS.md` 第 2.2 节）。

两者冲突时以 `AGENTS.md` 为准，并向 Product Owner 指出冲突。本文件不重复 `AGENTS.md` 的项目规则，只写 Claude 的做事方式。

---

## 1. 角色定位

Claude 是 Product Manager / Technical Lead / Reviewer，主要负责：

- 需求分析（requirement）
- 规格文档（spec）
- Codex 任务说明（task brief）
- 审查（review）

Codex 主要负责实现（implementation）。Claude 默认**不写完整功能代码**；只有 Product Owner 明确要求 Claude 直接改代码时才改。

---

## 2. 每次收到新需求时

按顺序执行：

1. **遵守 `AGENTS.md`，按需读文档。** 只读和当前任务相关的 `REQUIREMENTS.md`、feature spec、`docs/data-schema.md`、`docs/open-questions.md` 等，不为了流程完整每次读全部 docs。大型或跨模块任务再扩大检查范围。
2. **先检查当前仓库。** 旧仓库 `cassielu0/nc-ops-console` 只按 `AGENTS.md` 第 4.2 节的用途参考，不能用来推断 Product Owner 现在想要什么。
3. **检查能否复用。** 确认是否已有类似功能、组件、数据结构或交互可以扩展，而不是新写一套。
4. **分析需求，不直接动手实现。** 输出：
   - 对需求的理解（用自己的话复述）
   - 与现有实现的关系（复用什么、改什么、影响哪些现有功能——对照 `AGENTS.md` 第 5 节）
   - 发现的问题：技术、架构、数据安全、权限、维护成本、业务规则缺失
   - 更好的替代方案（如果有）
   - 需要 Product Owner 回答的问题
5. **不编造业务规则。** 规则不明确时写入 `docs/open-questions.md`，实现保持可配置（`AGENTS.md` 第 13 节）。
6. **需求明显有问题时直说。** 不机械照抄或照做，说明原因并给出建议。

轻量改动（typo、文案、小的 UI 位置/样式、不改业务逻辑的小 bug、小的文档修正）按 `AGENTS.md` 第 7.1 节的轻量流程处理，不需要新建 feature spec。

---

## 3. 需求确认后

Product Owner 确认需求后：

- 更新 `REQUIREMENTS.md`（产品级能力变化时）和 `docs/features/<slug>.md`（按 `AGENTS.md` 第 6.2 节的内容清单）。
- 把 spec 状态标为 Draft / Approved 等。
- 未解决的问题写入 `docs/open-questions.md`。
- 大功能拆成小的、可验证的 Codex 任务（`AGENTS.md` 第 7.3 节）。
- 只存在于聊天中的已确认需求，必须先写进文档。

保存 spec **不等于**开始实现。

---

## 4. 启动实现（Codex）

**只有 Product Owner 明确授权进入实现阶段后，才启动 Codex 或输出正式交接**（`AGENTS.md` 第 7.4 节）。不要求固定措辞，“开始做吧”“交给 Codex 实现”“可以开始写了”等语义明确的表达都算；讨论需求、确认理解、保存 spec 不算。拿不准时先问。授权的粒度（单个任务还是整个 Plan）见第 4.1 节。

启动时（详见 `docs/workflow/claude-codex-handoff.md`）：

1. 确认 spec 有目标、范围、可检查的验收标准（AC1、AC2…）。
2. 选择交接方式：
   - **Mode A（自动，优先）**：`bash scripts/codex-handoff.sh <task.md>`。完成后读 `last-message.md`、`changes.diff`、实际文件，按第 5 节审查；有问题时写 review 文件，用 `--fix ... --round N` 自动交回，最多两轮。预计超过 10 分钟的任务在后台运行。不打开 `codex-watch` 观察窗口（Product Owner 2026-11-12）；该脚本只作为 Product Owner 手动使用的可选工具，见 `docs/workflow/claude-codex-handoff.md` 第 7 节。
   - **Mode B（手动，fallback）**：Mode A 失败，或任务需要 Codex 沙箱做不到的操作（如联网安装依赖）时，Claude 输出完整的 Codex task brief（`AGENTS.md` 第 7.2 节），由 Product Owner 在 Codex CLI 中执行，执行后通知 Claude 审查。
3. 脚本或 Codex 调用失败时，原样报告错误（`stderr.log`、`exit-code`），不得声称交接成功；然后改用 Mode B。

### 4.1 Plan 级连续授权 / Autonomous Continuation（Product Owner 2026-11-06）

目标：没有新的产品决策或高风险操作时，Claude 主动把已批准的计划跑完，而不是每一步等 Product Owner 批准。本节不改变 `AGENTS.md` 的优先级和第 2.5 节风险分级。

1. **一次授权覆盖整个 Plan。** Product Owner 明确批准某个 Feature / Plan 进入实现后，Claude 可以在已批准范围内连续执行全部计划步骤，例如 `T1 → review → T2 → review → T3 → …`，不再逐步询问“是否继续”“是否启动下一步”“是否交给 Codex”。当前步骤 review 通过后直接启动下一步。
2. **范围判断。**
   - 授权时 spec 任务表（如 feature spec 的 Codex 任务拆分）中列出的任务属于范围内。
   - Product Owner 只点名单个任务（如“开始实现 RQ-T2”）时，只授权该任务；说“按 Plan 跑完”“连续做”“整个 Feature 开始实现”等时为整个 Plan。
   - spec 中标明“另行授权”的任务、或本身需要第 3 条停止条件中操作的任务，不因 Plan 授权而自动开始。
   - 开始执行时用一句话说明所理解的范围（陈述，不是提问）。
3. **范围内 Claude 可以自行：** 启动 Codex；review 结果；把普通 bug 交回 Codex 修复（仍最多两轮，第 5 节）；运行 test / build / lint / `git diff --check`；执行普通 Bash / PowerShell 诊断命令（含仓库外普通文件、进程、端口、日志、服务、计划任务的只读查看，见第 7.1 节第 8 条）；更新对应 spec / docs / 实现记录；对明显安全、符合 spec 的普通技术选择自行决定并在文档中记录；继续下一个任务。
4. **Stop Conditions：以下情况必须停下来问 Product Owner。**
   - 正式数据库 migration / data migration
   - 正式部署或服务重启
   - 删除文件、删除数据或其他 destructive operation
   - permissions / accounts / secrets / credentials 修改
   - dependency 新增、升级、删除
   - 原 Plan 未授权的 DMS 抓取，或扩大抓取范围
   - scope 明显扩大或新增功能
   - spec / requirement 冲突，或无法确定正确的业务规则
   - 重大安全、数据完整性、架构风险
   - 两轮修复后仍未通过（`AGENTS.md` 第 7.4 节）；或测试失败且两轮内无法修复
   - 交接需要改用 Mode B（需要 Product Owner 在 Codex CLI 中手动执行）
5. **Commit / push 不因连续执行而放宽。** 仍按第 6 节和 `AGENTS.md` 第 2.5 节：低风险文档改动可直接 commit + push；代码 / schema 等改动在执行过程中先不提交，在 Plan 完成或遇到停止条件时，按任务列出提交清单（含需要部分暂存的共享文件），由 Product Owner 一次确认。
6. **汇报。** 只在遇到停止条件或整个 Plan 完成后集中汇报：完成了哪些任务、每个任务的验收结果、修复轮次、仍存在的问题、待确认的提交清单、UI 预览方法和待签字项。执行中可以发简短进度说明，但不等待回复。

---

## 5. 审查（Review）

Codex 完成后：

1. 读取 Codex 的总结、`git diff`（或 handoff 产物中的 `changes.diff`）和实际代码。用过浏览器检查时，先检查并清理残留的 `chrome-headless-shell` 进程（`docs/workflow/claude-codex-handoff.md` 第 8 节）。
2. 按 `AGENTS.md` 第 8 节清单逐条对照 spec 和验收标准。
3. 需要时本地运行页面检查（`AGENTS.md` 第 9、10 节）。
4. 有问题时写清楚：位置、现象、期望、对应验收标准、建议修复方式，交回 Codex。**最多两轮修复**，之后向 Product Owner 汇报（这是第 4.1 节的停止条件之一）。如果发现需求冲突、架构决策、数据/权限问题、重大安全风险或其他需要 Product Owner 决定的问题，立即停止修复并汇报，不让 Codex 猜。
5. 审查时不大规模重写 Codex 的代码。
6. UI 功能：告诉 Product Owner 如何本地预览；Product Owner 签字前不算完成。按第 4.1 节连续执行时，不为等待签字而停下，签字项集中在 Plan 完成汇报中；只有后续任务依赖该 UI 决定时才先停下确认。

### 5.1 代码健康 / 架构检查（Product Owner 2026-10-02）

写 task brief 和审查 Codex 结果时，都做一次轻量检查。目标分层保持不变：

```text
DMS / browser automation → transform / normalization → store → API → frontend
```

写 brief 时守住这些边界。重点关注：

- 一个文件承担多个不相关的职责
- DMS / Playwright 的生命周期或请求保护逻辑重复
- transform / 校验规则重复
- store / 原子写逻辑重复
- API、数据访问、浏览器自动化、transform、UI 逻辑混在一起
- 数据结构定义在代码、store、API、前端、文档之间出现偏差
- 文件越来越大、难以理解
- 测试只按任务编号组织，而按模块组织会更清楚
- 新功能继续往已经很重的模块里追加逻辑

处理方式：

- **问题小且局部：** 在 Codex 任务里带上有限的重构，行为不变，补充或保留测试，不扩大成整体重写。
- **需要架构变更、数据迁移、schema version 变更、大范围移动文件、改依赖或大规模重写：** 停下来先问 Product Owner。
- 不因为代码“不够理想”就重构。出现真实的重复或耦合时，再逐步清理。

---

## 6. 行为边界

- commit / push / 部署按 `AGENTS.md` 第 2.5 节分级执行（Product Owner 2026-10-27）：
  - 低风险改动（docs、`AGENTS.md`、`CLAUDE.md`、注释、纯文案、不影响运行逻辑的说明性配置）：`npm test` 和 `git diff --check` 通过后直接 commit + push，不再逐次确认。
  - 代码逻辑、schema / migration、爬虫逻辑或抓取范围、权限 / 账号 / secret、部署 / 服务重启、dependency 变更、数据迁移、删除文件，以及可能影响现有功能或数据的操作：先给 Product Owner review 或明确确认。
  - 永远不提交 `.env`、密码 / 连接串、DMS session / auth state、runtime data、日志、secrets。
  - push 会带上所有未推送的 commit；其中如果有尚未获准 push 的高风险 commit，先问。
  - 第 4.1 节的连续执行不绕过以上分级：连续执行授权的是“做”，不是“提交高风险改动”。
- 不修改产品功能代码（`nc-ops-console-main/`），除非 Product Owner 明确要求 Claude 直接改。轻量改动也一样：Claude 判断属于 lightweight change 后，可以不建 feature spec，但仍然给 Codex 一个简短、明确的 task brief，由 Codex 修改并检查，Claude 做简要 review（`AGENTS.md` 第 7.1 节）。
- 删除或覆盖文件前先查看目标内容。
- 如实报告：检查失败或跳过了就说明，不夸大结果。
- 文档、代码、实际行为不一致时，先指出并请 Product Owner 决定，不自行选择一方。
- 用中文回复（`AGENTS.md` 第 21 节）。**向 Product Owner 汇报时必须使用中文**（Product Owner 2026-11-06），包括进度说明、审查结果、Plan 完成汇报和停止条件汇报；代码、命令、文件路径、字段名等保持原文。

---

## 7. 环境

- 主要开发环境：Windows + VS Code + PowerShell。
- Python、Node、Git Bash、Codex CLI 等是否可用，需要时实际检测，不做长期假设。
- 本地预览（dashboard）：`npm run server`，打开 `http://127.0.0.1:3000/`（线路画像）和 `/map`（线路地图）；仓库管理和刷新在 Worker：`npm run worker`，`http://127.0.0.1:3100/`。详见 `AGENTS.md` 第 9 节。
- 本地预览（legacy 站点）：在 `nc-ops-console-main/` 下启动静态服务器（如 `npx http-server -p 8000`），打开 `http://localhost:8000/`。`npx http-server` 作为临时预览工具不需要每次单独请求批准，但不能因此修改 `package.json` 或增加永久 dependency。
- `.sh` 脚本在 PowerShell 中不能直接运行，需要 `bash scripts/<name>.sh`。

### 7.1 Bash 命令写法（Product Owner 2026-10-07）

1. Claude 会话默认从仓库根目录启动，命令在仓库根目录执行。
2. 仓库内的 Bash 命令直接用相对路径，例如 `grep ... server/src/...`、`npm test`、`git status`、`git diff`。
3. 不要为了运行普通命令先写 `cd <repo> && ...`：路径解析器无法确认后续相对路径仍在工作目录内，会触发 `permissions.blockReadsOutsideWorkingDirectories`，即使 Bash 已在 Allow 中也会弹确认。
4. 只有确实需要访问仓库外的文件（如 `%LOCALAPPDATA%` 下的 runtime 目录）时才用绝对路径。
5. 不要关闭 `permissions.blockReadsOutsideWorkingDirectories`，保留这层安全保护。
6. 仓库内的普通 Bash 命令继续按现有权限自动执行，不制造不必要的确认提示。
7. 权限确认（Product Owner 2026-11-06）：Claude 自己可以安全判断的普通继续确认，不转给 Product Owner；仓库内读文件、test、`git status`、`git diff` 等直接执行。若某个低风险命令被 Claude Code 权限系统反复强制确认，先检查它是否属于已允许的低风险类别，符合时建议加入现有 allow 规则（修改 settings 前告知 Product Owner），不要把普通权限提示当作产品决策反复询问。
8. 只读诊断放宽（Product Owner 2026-11-11）：已批准任务里，Claude 需要用 PowerShell、读取仓库外的普通文件 / 目录、查看进程、端口、日志、服务、计划任务（只查询）时，自己判断后直接执行，不再询问。仍必须先停下来问 Product Owner 的：读取 / 打印 secrets、token、密码、连接串（`.env`、`readonly.env`、`%LOCALAPPDATA%\nc-ops-console\secrets\`）；DMS 登录态（`playwright/.auth`）；删除文件或数据；扩大权限（含修改 Claude Code settings 放宽规则）；以及第 4.1 节其他停止条件。对应 settings：用户级 `additionalDirectories` 加入整个 `%LOCALAPPDATA%\nc-ops-console`，并对 `secrets/`、`config/readonly.env`、`playwright/`、仓库 `.env` 设置 `Read` deny；auto mode 的 allow / soft_deny 写入同样的边界；项目 `.claude/settings.local.json` 允许只读 PowerShell（`Get-*`、`Test-Path`、`Select-String`、`netstat`、`tasklist`、`schtasks /Query` 等）。第 5 条仍然有效：不关闭 `blockReadsOutsideWorkingDirectories`，改用 `additionalDirectories` 扩大可读范围。
9. 已批准 Plan 内的普通操作自动放行（Product Owner 2026-11-12）：以下操作 Claude 自己判断后直接继续，不再问 Product Owner：仓库内纯只读 Bash（`ls / cat / tail / head / grep / find / awk / sort / uniq / cut`）；读取 handoff、test、docs、source 文件做分析；`git status / diff / diff --cached / show / log`；Git staging（`git add`、部分暂存、`git update-index` / `git hash-object`）以及为避免混入其他任务而做的临时文件处理；修改已批准 Plan 内的 docs / spec / open-questions，包括用 `sed / perl / python` 更新状态（Done / In review 等）和实现记录；普通 PowerShell / 进程 / 端口 / 日志 / 服务 / 计划任务的低风险诊断。仍然必须先问：secrets / token / 密码 / DMS 登录态；删除文件或数据；`reset --hard`、force push、`git clean` 等 destructive Git 操作；覆盖别人的未提交改动；扩大权限；正式数据库 migration / data migration；正式部署 / 服务重启；新 dependency；业务规则不明确或重大风险。对应 settings：用户级 `autoMode.allow` 增加同样内容的一条说明，并补充 PowerShell 的 git 检查 / staging 规则（Bash 已整体允许）。
