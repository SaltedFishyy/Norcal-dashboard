# 开发版 / 正式版分离（Release Split，RS）

状态：**Implemented，待部署**。Product Owner 2026-11-13 批准需求并授权实现 SVC-T2 / RS-T1 / RS-T2 / RS-T4，已全部经 Claude review 通过（RS-T2 第一次交接因 spec 与 brief 依赖规则不一致停止，已统一后重做）。**RS-T3（首次发布、重新注册任务、重启 readonly）待 Product Owner 确认。**

## 1. 背景与目标

现状：局域网只读服务（`http://KENNY:3000`）、Worker（3100）都直接运行 OneDrive 里的开发工作目录。带来三个问题：

- 前端文件是从磁盘直接读的。Codex 改文件时，同事刷新页面可能拿到改了一半的版本，甚至黑屏。新增 web 文件还要重启服务，会断开。
- Claude / Codex 的浏览器检查都对着 3000 做，同事访问时会和这些检查抢资源。
- 没有“发布”这个动作：代码一改完就上线，没法先确认再给同事用。

目标：

- **正式版**：3000 运行一份**独立的发布副本**。只有 Product Owner 说“发布”时才更新，并且只发布已提交的版本。
- **开发版**：一个只在本机能打开的预览服务 `http://127.0.0.1:3200`，运行开发工作目录。Codex 实现、Claude 审查、Product Owner 预览都用它。
- 发布要能**回滚**到上一个版本。

不变：数据库、API、数据、抓取逻辑、只读安全检查（reader 权限、loopback / 局域网规则）都不变。开发版和正式版连同一个数据库，都用 reader 只读角色。

## 2. 方案

### RS-A 开发预览服务（3200）

- 新增启动脚本（如 `scripts/dev-preview.ps1`，或在 `package.json` 增加 `preview:dev` 脚本，由 Codex 选择并说明）：
  - 用现有的仓库外 `readonly.env` 启动 `server/bin/server.js`。
  - 进程环境变量覆盖 `LISTEN_HOST=127.0.0.1`、`PORT=3200`。Node 的 `--env-file` 规定进程环境优先于文件，这一点需要实测确认。
  - 只监听 loopback，局域网访问不到。
- 不加入计划任务，按需启动：Claude 用 `.claude/launch.json` 的 preview 配置启动，Product Owner 也可以手动启动。
- 不读取 repo `.env`，不接触 DMS / writer 凭据。

### RS-B 发布副本（3000）

- 位置：`%LOCALAPPDATA%\nc-ops-console\releases\<短 commit>\`，不放在 OneDrive。
- 当前版本：`%LOCALAPPDATA%\nc-ops-console\releases\current.txt`，记录目录名。
- 发布脚本（如 `scripts/services/release.ps1 -Commit <sha>`）：
  1. 只接受**已提交**的 commit，默认取 `HEAD`。工作区有未提交改动也照常执行，因为只导出 commit 的内容，但要提示。
  2. 用 `git archive <commit>` 导出到新目录。不用 git worktree，发布副本和 OneDrive 里的 `.git` 没有任何关联。
  3. 依赖按以下顺序处理（Claude 2026-11-13 统一，属于普通技术选择）：`package-lock.json` 与当前发布版本相同时，从当前发布版本复制 `node_modules`；否则如果与开发目录的相同，从开发目录复制，首次发布走这一条，不用联网；都不同时，执行 `npm ci --omit=dev`。这样只会安装 lockfile 已有的依赖，不新增依赖。
  4. 冒烟检查：用新目录在临时 loopback 端口（如 3299）启动一次只读服务，请求 `/api/districts` 返回 200 后关闭。失败时**不切换**。
  5. 原子更新 `current.txt`。
  6. 重启只读服务的 node 子进程：结束当前 readonly node，guardian 会从新版本重新启动。不重启 guardian，也不动数据库和 Worker。
  7. 输出：新版本、旧版本、冒烟结果。
- 回滚：`release.ps1 -Rollback`（或 `-Version <目录名>`）把 `current.txt` 指回之前的版本，然后重启 readonly node。
- 旧版本保留，脚本**不自动删除**；清理时先问 Product Owner。
- `run-service.ps1 -Name readonly`：每次启动 node 前读一次 `current.txt`。
  - 目录存在：以该目录作为工作目录和代码目录。
  - `current.txt` 不存在：回退到 repo 根目录，并在 `services.log` 写一条警告，保持现有行为。

### RS-C Worker（3100）

第一版**保持运行开发工作目录**，原因：

- Worker 读取 repo 根目录的 `.env`（DMS / writer / Lark 凭据）。让它运行发布副本，需要移动或复制凭据，属于凭据操作。
- 3100 只在本机给 Product Owner 用，同事不访问。
- Node 代码在 Worker 重启后才生效，不会出现“改了一半”的情况。只有 3100 的管理页面文件仍是直接读磁盘。

见 open question RS-Q1。

### RS-D 自愈触发器修正（并入，原 SVC-T1 遗留）

SVC-T1 实测发现：挂在“登录时”触发器上的 5 分钟重复不会生效，`NextRunTime` 为空，手动运行任务时也不会开始重复。

修正：`register-tasks.ps1` 保留登录触发器，**另加一个独立的时间触发器**。它从注册时刻开始，每 5 分钟重复，无限期。`Interactive` / `Limited` 不变，因此只在当前用户登录时运行。

验收：注册后 `Get-ScheduledTaskInfo` 的 `NextRunTime` 有值；结束 supervisor 后 5 分钟内被拉起，并且不出现重复的 guardian。

### RS-E 工作流文档

- `CLAUDE.md` §7、`AGENTS.md` 本地预览部分、`docs/workflow/claude-codex-handoff.md`：浏览器检查和 Product Owner 预览改用 `http://127.0.0.1:3200`，不再对 3000 做检查。
- `docs/deployment.md`：增加发布、回滚、发布副本目录的说明。
- 发布流程：
  1. Codex 实现；
  2. Claude 在 3200 上审查；
  3. Product Owner 在 3200 上预览、签字；
  4. Product Owner 确认提交；
  5. commit + push；
  6. Product Owner 说“发布”；
  7. Claude 运行 `release.ps1` 并汇报。
- `AGENTS.md` 是项目级规则，修改要 Product Owner 确认。

## 3. 验收标准

- **RS-AC1** 3200 只在 loopback 监听，局域网 IP 访问不到；页面和数据与 3000 一致；不读取 repo `.env`。
- **RS-AC2** 修改开发目录里的 `web/` 文件后，3200 立即看到变化，3000 不变。
- **RS-AC3** `release.ps1` 导出指定 commit，冒烟检查通过后切换。3000 改为运行新版本，中断时间不超过 15 秒。`/api/districts` 返回 200，局域网可以访问。
- **RS-AC4** 冒烟检查失败时不切换，3000 保持旧版本继续运行。
- **RS-AC5** 回滚能恢复上一版本，3000 正常。
- **RS-AC6** `current.txt` 缺失时，readonly 回退到 repo 根目录，并在日志中警告。
- **RS-AC7** 计划任务 `NextRunTime` 有值；结束 supervisor 后 5 分钟内被拉起；guardian 不重复。
- **RS-AC8** 发布副本里没有 `.env`、凭据或 runtime 数据；`git archive` 不包含未跟踪文件。
- **RS-AC9** `npm test` 和 `git diff --check` 通过；新增脚本有结构测试；`release.ps1` 有 dry-run 或临时目录测试。

## 4. 任务拆分

| 任务 | 内容 | 执行 | 授权 |
|---|---|---|---|
| SVC-T2 | RS-D 独立时间触发器 | Codex | 随 RS 实现授权 |
| RS-T1 | RS-A 3200 开发预览 + `.claude/launch.json` | Codex | 随 RS 实现授权 |
| RS-T2 | RS-B `release.ps1`、回滚、`run-service.ps1` 读 `current.txt` | Codex | 随 RS 实现授权 |
| RS-T3 | 部署：首次发布、重新注册任务、重启 readonly、按 AC 验证 | Claude | **另行确认**（服务重启、计划任务） |
| RS-T4 | RS-E 工作流文档（含 `AGENTS.md`） | Claude | 随 RS 实现授权，`AGENTS.md` 改动给 Product Owner 过目 |

## 5. 风险

- **首次发布的 `npm ci` 需要联网。** Codex 沙箱做不到，由 Claude 在 RS-T3 执行。
- **发布副本和开发目录的 Node 版本相同。** 都用 `C:\Program Files\nodejs\node.exe`。
- **guardian 读 `current.txt` 时的竞态。** 脚本先写临时文件，再整体替换。
- **磁盘占用。** 每个版本大约等于 `node_modules` 的大小。旧版本手动清理。

## 6. 未决问题

见 `docs/open-questions.md` 的“开发版 / 正式版分离”部分。

## 7. 实现记录（Implementation Notes）

### RS-T1（2026-11-13）

- 新增 `scripts/dev-preview.ps1`，默认 3200、前台运行；从指定 env 文件启动现有 API server，清理继承配置后强制设置 loopback 与端口。缺失配置或端口占用时退出，不回退到 repo `.env`。
- `scripts/services/readonly-env.ps1` 统一只读环境清理；guardian 保留原有清理行为。环境字典使用 Windows PowerShell 5.1 的 `StringDictionary` 类型。
- `.claude/launch.json` 提供 `dev-preview` 配置，结构测试追加到既有 service-scripts 测试模块。
- 临时 JSON env（故意配置 `0.0.0.0:3000`）在 3299 实测：仅监听 `127.0.0.1:3299`，首页 200，响应与开发目录 `web/index.html` 相同；占用端口、缺失 env 的中文提示通过；Ctrl+C 后监听清除。未使用真实 readonly.env，未操作现有服务。
- `npm.cmd test`：890/890 通过；`git diff --check` 通过。项目没有 lint/build 命令。
- 未修改 web 文件验证即时更新；真实 DB 数据与 3000 一致性、3000 发布副本隔离仍待后续 review/RS-T3 验证。RS-T1 不代表 RS-AC1/RS-AC2 已全部验收。

### RS-T2（2026-11-13）

- 新增 `scripts/services/release.ps1`：commit 导出到 staging，按当前发布版本 → 开发目录 → `npm ci --omit=dev` 处理依赖，复用 RS-T1 的只读环境清理函数，在 loopback 冒烟后原子切换版本；支持历史回滚、指定已有版本、临时 Base 和跳过重启。发布锁防止并发切换；只清理本次创建且路径校验通过的 `.staging-*`，不删除正式版本。
- Windows PowerShell 5.1 的 `[IO.File]::Replace` 使用 `[NullString]::Value`，避免 `$null` 被转换为空备份路径。脚本以 UTF-8 BOM 保存，确保 PowerShell 5.1 正确解析中文消息。
- readonly guardian 每次启动 Node 前校验并读取版本指针；缺失时 guardian 启动记录一次回退提示，无效时每次启动警告。Worker 分支及现有只读环境清理行为保留。重启逻辑仅匹配同用户、同脚本路径、同 Base 的 readonly guardian 直接 Node 子进程，并复核进程创建时间；本任务未执行真实重启。
- 临时 `.handoff/rs-t2-base/` 实测：HEAD（`55bed67c64`）和 HEAD~1（`7886bc87ab`）均冒烟成功；回滚恢复 HEAD；已有版本重复发布及 `-Version` 切换成功；不存在的版本以非零退出。HEAD~2 配合 `DATA_SOURCE=bogus` 冒烟失败，current 指针保持不变，本次 staging 清理完成。使用同 lockfile 的开发/当前版本依赖复用路径，未触发联网安装；`npm ci` 回退分支未实测。
- 冒烟子进程由脚本 Kill/WaitForExit 收尾，随后确认 3299 无监听；失败后也确认没有 `.staging-*` 残留。CIM 进程枚举被环境拒绝（Access denied），不能独立枚举核实残留 Node。指针缺失与有效指针的 readonly 选择逻辑在隔离代码块中运行验证，通过；未启动或结束任何现有 guardian。
- 新增 3 项结构测试；service-scripts 共 9 项通过。`npm.cmd test`：893/893 通过；`git diff --check` 通过；两个 PowerShell 脚本语法解析通过。无 lint/build 配置。未修改前端，因此未做页面交互回归。
- RS-AC3 / AC5 的真实 3000 切换、重启时长、LAN 连通性，以及 AC4 的真实服务持续可用，均留待 RS-T3 授权后验证。测试发布副本未发现 `.env` / `readonly.env`；git archive 排除未跟踪文件，未写入真实 releases、未打开真实配置或凭据。
- 临时目录清理命令被自动审批以 `blocked by policy` 拒绝（未提供具体原因），路径校验后的逐项删除也被拒绝；`.handoff/rs-t2-base/` 和两个无凭据临时 env 文件暂留，需后续清理。不代表正式部署完成。
