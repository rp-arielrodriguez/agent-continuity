#!/usr/bin/env bash
set -euo pipefail

input="$(cat || true)"
prompt="${CLAUDE_USER_PROMPT:-}"

if [[ -z "$prompt" && -n "$input" ]]; then
  prompt="$(INPUT="$input" node -e '
const input = process.env.INPUT || "{}";
try {
  const data = JSON.parse(input);
  console.log(data.prompt || data.tool_input?.prompt || "");
} catch {
  console.log("");
}
' 2>/dev/null)"
fi

if [[ "$prompt" =~ ([Rr]esume|[Cc]ontinue)[[:space:]]+from[[:space:]]+([^[:space:]]+\.md) ]]; then
  file="${BASH_REMATCH[2]}"
  base="$(basename "$file")"
  task_id="${base%.md}"
  task_id="${task_id%.canon}"
  cat <<MSG
AGENT CONTINUITY: resume from PostgreSQL first, then use markdown only as a projection.
Run: continuity resume --task-id $task_id
MSG
elif [[ "$prompt" =~ checkpoint|dump[[:space:]]+context|save[[:space:]]+progress ]]; then
  cat <<'MSG'
AGENT CONTINUITY: checkpoint through Absurd/PostgreSQL. Do not edit markdown checkpoint files as the authority.
Run continuity checkpoint with --task-id, --status, --progress, --next, and --canon-file when a reconciled canon is available.
MSG
fi
