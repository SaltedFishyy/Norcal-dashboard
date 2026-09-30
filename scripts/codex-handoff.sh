#!/usr/bin/env bash
# Claude → Codex 交接脚本（Mode A）：把一份 spec / task brief 交给 Codex CLI 执行，并保存可供 Claude 审查的结果。
#
# 用法（在仓库任意位置，Windows 下用 Git Bash：bash scripts/codex-handoff.sh ...）：
#   scripts/codex-handoff.sh <task.md>                                  # 第 0 轮：首次实现
#   scripts/codex-handoff.sh <task.md> --fix <review.md> --round 1      # 第 1 轮修复
#   scripts/codex-handoff.sh <task.md> --fix <review.md> --round 2      # 第 2 轮修复（上限）
#
# 每次运行输出到 .handoff/runs/<时间戳>-<任务名>-r<轮次>/（.handoff/ 已被 gitignore）：
#   prompt.md          发给 Codex 的完整指令
#   status-before.txt  运行前 git status（porcelain，含 untracked）
#   status-after.txt   运行后 git status
#   changes.diff       本轮 Codex 造成的变化（运行前后工作区快照对比，含 untracked，
#                      不包含运行前就已存在的未提交改动，也不包含 gitignored 文件）
#   changed-files.txt  本轮变化的文件清单（A/M/D + 路径）
#   events.jsonl       Codex 执行事件流（--json）
#   last-message.md    Codex 最后一条回复（实现总结）
#   stderr.log         Codex 标准错误输出
#   exit-code          Codex 退出码
#
# 本脚本不会 git commit / push，也不会部署；不修改真实的 git index。

set -euo pipefail

MAX_FIX_ROUNDS=2

usage() { sed -n '2,19p' "$0"; exit 2; }
die() { echo "错误：$1" >&2; exit "${2:-2}"; }

# ---------- 依赖检查 ----------
for cmd in git codex; do
  command -v "$cmd" >/dev/null 2>&1 || die "未找到 $cmd（PATH 中没有 $cmd），停止交接。" 127
done

TOPLEVEL="$(git -C "$(dirname "${BASH_SOURCE[0]}")/.." rev-parse --show-toplevel 2>/dev/null)" \
  || die "脚本所在目录不在 git 仓库中。"
# 统一成 shell 的路径格式（Git Bash 下 rev-parse 返回 C:/...，pwd 返回 /c/...）
ROOT="$(cd "$TOPLEVEL" && pwd)"

# Windows（Git Bash）下把路径转成原生格式再传给 codex
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }

# ---------- 参数 ----------
TASK=""; FIX=""; ROUND=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fix)   [[ $# -ge 2 ]] || usage; FIX="$2"; shift 2 ;;
    --round) [[ $# -ge 2 ]] || usage; ROUND="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) if [[ -z "$TASK" ]]; then TASK="$1"; shift; else echo "未知参数: $1" >&2; usage; fi ;;
  esac
done

[[ -n "$TASK" && -f "$TASK" ]] || die "找不到任务文件（spec / task brief）: ${TASK:-<空>}"
[[ "$ROUND" =~ ^[0-9]+$ ]] || die "--round 必须是数字"
(( ROUND <= MAX_FIX_ROUNDS )) || die "已超过最多 ${MAX_FIX_ROUNDS} 轮修复，停止交接，请向 Product Owner 汇报。" 3
if (( ROUND > 0 )); then
  [[ -n "$FIX" && -f "$FIX" ]] || die "修复轮（--round ${ROUND}）必须用 --fix 提供审查问题文件"
fi

TASK_ABS="$(cd "$(dirname "$TASK")" && pwd)/$(basename "$TASK")"
case "$TASK_ABS" in "$ROOT"/*) ;; *) die "任务文件必须位于仓库内：$TASK_ABS" ;; esac
TASK_REL="${TASK_ABS#"$ROOT"/}"
NAME="$(basename "$TASK" .md)"
RUN_DIR="$ROOT/.handoff/runs/$(date +%Y%m%d-%H%M%S)-${NAME}-r${ROUND}"
mkdir -p "$RUN_DIR"

# ---------- 工作区快照 ----------
# 用临时 index 把整个工作区（tracked + untracked，排除 gitignored）写成 tree 对象。
# 不改变真实 index，也不改变工作区文件。
snapshot() {
  local idx="$RUN_DIR/.index-$1"
  rm -f "$idx"
  GIT_INDEX_FILE="$idx" git -C "$ROOT" -c core.safecrlf=false add -A . 2>>"$RUN_DIR/snapshot.log"
  GIT_INDEX_FILE="$idx" git -C "$ROOT" write-tree
  rm -f "$idx"
}
status_to() { git -C "$ROOT" status --porcelain=v1 --untracked-files=all > "$1"; }

status_to "$RUN_DIR/status-before.txt"
TREE_BEFORE="$(snapshot before)" || die "运行前快照失败，停止交接（详见 $RUN_DIR/snapshot.log）。" 4
[[ -n "$TREE_BEFORE" ]] || die "运行前快照为空，停止交接。" 4

# ---------- 组装 Codex 指令 ----------
{
  cat <<EOF
你是本仓库的 Software Engineer（Codex）。请严格遵守仓库根目录 AGENTS.md。

本次任务文件（spec 或 task brief）：${TASK_REL}

执行要求：
1. 先阅读 AGENTS.md 和上述任务文件；任务文件引用的 spec 也要阅读。
2. 检查当前仓库结构和相关现有代码后再动手。不要假设项目是纯静态站：项目正在从 legacy 静态站（nc-ops-console-main/）过渡到 frontend/backend 架构，以仓库实际内容为准。
3. 只做任务文件范围内的改动；不要修改与任务无关的文件。
4. 任务不清楚、与现有代码或文档冲突、或需要 Product Owner 决定时：停止，在最终回复中说明，不要猜测。
5. 禁止：git commit、git push、部署、发布 GitHub Pages、写入任何凭据（账号、密码、cookie、token、session）。
6. 如果项目配置了 lint / build / test 命令（例如 package.json scripts），运行相关命令并如实报告；没有的就说明没有，不要声称运行过。
7. 完成后可在对应 spec 的“实现记录（Implementation Notes）”小节补充技术说明，但不要改动需求和验收标准。
8. 最终回复按 AGENTS.md 第 11 节格式总结（Files Changed / What Changed / Data Changes / Checks Run / Assumptions / Remaining Work），并逐条说明每个验收标准是否满足。
EOF
  if (( ROUND > 0 )); then
    cat <<EOF

这是第 ${ROUND} 轮修复（最多 ${MAX_FIX_ROUNDS} 轮）。Claude 审查发现以下问题，请只修复这些问题：

EOF
    cat "$FIX"
  fi
} > "$RUN_DIR/prompt.md"

echo "▶ 启动 Codex（第 ${ROUND} 轮）… 输出目录: ${RUN_DIR#"$ROOT"/}"

# ---------- 执行 Codex（失败也继续收集产物）----------
CODE=0
codex exec \
  -C "$(native "$ROOT")" \
  -s workspace-write \
  --color never \
  --json \
  -o "$(native "$RUN_DIR/last-message.md")" \
  - < "$RUN_DIR/prompt.md" \
  > "$RUN_DIR/events.jsonl" 2> "$RUN_DIR/stderr.log" || CODE=$?
echo "$CODE" > "$RUN_DIR/exit-code"
# Codex 失败时可能不会写 last-message.md；保证产物齐全，空文件表示没有最终回复
[[ -f "$RUN_DIR/last-message.md" ]] || : > "$RUN_DIR/last-message.md"

# ---------- 运行后快照与 diff ----------
status_to "$RUN_DIR/status-after.txt"
TREE_AFTER="$(snapshot after)" || die "运行后快照失败（Codex 退出码 $CODE），请手动检查 git status。" 4
git -C "$ROOT" diff --binary "$TREE_BEFORE" "$TREE_AFTER" > "$RUN_DIR/changes.diff"
git -C "$ROOT" diff --name-status "$TREE_BEFORE" "$TREE_AFTER" > "$RUN_DIR/changed-files.txt"

echo "── Codex 退出码: $CODE"
echo "── 本轮变更文件:"
if [[ -s "$RUN_DIR/changed-files.txt" ]]; then
  sed 's/^/   /' "$RUN_DIR/changed-files.txt"
else
  echo "   （无文件变更）"
fi

if [[ $CODE -ne 0 || ! -s "$RUN_DIR/last-message.md" ]]; then
  echo "✖ Codex 执行失败或没有返回结果。stderr 末尾：" >&2
  tail -n 30 "$RUN_DIR/stderr.log" >&2 || true
  (( CODE != 0 )) && exit "$CODE" || exit 1
fi

echo "── Codex 最终回复: ${RUN_DIR#"$ROOT"/}/last-message.md"
echo "RUN_DIR=$RUN_DIR"
