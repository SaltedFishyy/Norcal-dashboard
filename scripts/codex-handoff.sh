#!/usr/bin/env bash
# Claude → Codex 交接脚本：把一份功能 Markdown 交给 Codex CLI 实现，并保存可供 Claude 审查的结果。
#
# 用法：
#   scripts/codex-handoff.sh <spec.md>                          # 第 0 轮：首次实现
#   scripts/codex-handoff.sh <spec.md> --fix <review.md> --round 1   # 第 1 轮修复
#   scripts/codex-handoff.sh <spec.md> --fix <review.md> --round 2   # 第 2 轮修复（上限）
#
# 每次运行输出到 .handoff/runs/<时间戳>-<spec名>-r<轮次>/：
#   prompt.md        发给 Codex 的完整指令
#   events.jsonl     Codex 执行事件流（--json）
#   last-message.md  Codex 最后一条回复（实现总结）
#   stderr.log       Codex 标准错误输出
#   changes.diff     本轮运行前后文件差异（仓库不是 git 仓库，用快照对比）
#   exit-code        Codex 退出码
#
# 本脚本不会 git commit / push，也不会部署。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAX_FIX_ROUNDS=2

usage() { sed -n '2,20p' "$0"; exit 2; }

SPEC=""; FIX=""; ROUND=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fix)   FIX="${2:-}"; shift 2 ;;
    --round) ROUND="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) if [[ -z "$SPEC" ]]; then SPEC="$1"; shift; else echo "未知参数: $1" >&2; usage; fi ;;
  esac
done

[[ -n "$SPEC" && -f "$SPEC" ]] || { echo "错误：找不到 spec 文件: ${SPEC:-<空>}" >&2; exit 2; }
[[ "$ROUND" =~ ^[0-9]+$ ]] || { echo "错误：--round 必须是数字" >&2; exit 2; }
if (( ROUND > MAX_FIX_ROUNDS )); then
  echo "错误：已超过最多 ${MAX_FIX_ROUNDS} 轮修复，停止交接，请向 Product Owner 汇报。" >&2; exit 3
fi
if (( ROUND > 0 )) && [[ -z "$FIX" || ! -f "$FIX" ]]; then
  echo "错误：修复轮（--round ${ROUND}）必须用 --fix 提供审查问题文件" >&2; exit 2
fi
command -v codex >/dev/null 2>&1 || { echo "错误：未找到 codex CLI（PATH 中没有 codex）" >&2; exit 127; }

SPEC_ABS="$(cd "$(dirname "$SPEC")" && pwd)/$(basename "$SPEC")"
SPEC_REL="${SPEC_ABS#"$ROOT"/}"
NAME="$(basename "$SPEC" .md)"
RUN_DIR="$ROOT/.handoff/runs/$(date +%Y%m%d-%H%M%S)-${NAME}-r${ROUND}"
mkdir -p "$RUN_DIR"

# 运行前快照，用于生成本轮 diff
EXCLUDES=(--exclude .handoff --exclude .DS_Store --exclude '*.bak-*' --exclude .git)
rsync -a "${EXCLUDES[@]}" "$ROOT/" "$RUN_DIR/before/"

# 组装 Codex 指令
{
  cat <<EOF
你是本仓库的 Software Engineer（Codex）。请严格遵守仓库根目录 AGENTS.md 的规则。

本次任务的需求文档（spec）：${SPEC_REL}

执行要求：
1. 先阅读 AGENTS.md 和上述 spec，再检查相关现有代码。
2. 只实现 spec 中列出的范围；spec 不清楚或与现有代码冲突时，停止并在最终回复中说明，不要猜测。
3. 保持改动最小，不要修改与任务无关的文件。
4. 禁止：git commit、git push、部署、发布到 GitHub Pages、写入任何凭据。
5. 应用代码位于 nc-ops-console-main/（静态站点，无构建步骤）。项目没有 lint/build/test 工具链，不要声称运行过它们；可以做能做的手动/脚本检查并如实报告。
6. 完成后可在 spec 的 “实现记录（Implementation Notes）” 小节补充技术说明，但不要改动需求和验收标准。
7. 最终回复按 AGENTS.md 第 11 节格式给出总结（Files Changed / What Changed / Data Changes / Checks Run / Assumptions / Remaining Work），并逐条说明每个验收标准是否满足。
EOF
  if (( ROUND > 0 )); then
    cat <<EOF

这是第 ${ROUND} 轮修复（最多 ${MAX_FIX_ROUNDS} 轮）。Claude 审查发现以下问题，请只修复这些问题：

EOF
    cat "$FIX"
  fi
} > "$RUN_DIR/prompt.md"

echo "▶ 启动 Codex（第 ${ROUND} 轮）… 输出目录: ${RUN_DIR#"$ROOT"/}"

codex exec \
  -C "$ROOT" \
  -s workspace-write \
  --skip-git-repo-check \
  --color never \
  --json \
  -o "$RUN_DIR/last-message.md" \
  - < "$RUN_DIR/prompt.md" \
  > "$RUN_DIR/events.jsonl" 2> "$RUN_DIR/stderr.log"
CODE=$?
echo "$CODE" > "$RUN_DIR/exit-code"

# 运行后差异（排除快照目录本身）
diff -ruN "${EXCLUDES[@]/--exclude/-x}" "$RUN_DIR/before" "$ROOT" \
  | sed "s#$RUN_DIR/before#a#g; s#$ROOT#b#g" > "$RUN_DIR/changes.diff"
rm -rf "$RUN_DIR/before"

echo "── Codex 退出码: $CODE"
echo "── 变更文件:"
grep '^diff ' "$RUN_DIR/changes.diff" | awk '{print "   " $NF}' | sed 's#^   b/#   #' || true
[[ -s "$RUN_DIR/changes.diff" ]] || echo "   （无文件变更）"

if [[ $CODE -ne 0 || ! -s "$RUN_DIR/last-message.md" ]]; then
  echo "✖ Codex 执行失败或没有返回结果。stderr 末尾：" >&2
  tail -n 30 "$RUN_DIR/stderr.log" >&2
  exit "${CODE/#0/1}"
fi

echo "── Codex 最终回复: ${RUN_DIR#"$ROOT"/}/last-message.md"
echo "RUN_DIR=$RUN_DIR"
