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
AGENT CONTINUITY: resume from daemon continuity first, then use markdown only as a projection.
Run: continuity resume --daemon --project-id <PROJECT-ID> --task-id $task_id
If project id is missing and cannot be inferred from a git checkout, run: continuity session-resume --last
Fallback if daemon is unavailable: continuity resume --task-id $task_id
MSG
elif [[ "$prompt" =~ checkpoint|dump[[:space:]]+context|save[[:space:]]+progress ]]; then
  cat <<'MSG'
AGENT CONTINUITY: checkpoint through daemon continuity. Do not edit markdown checkpoint files as the authority.
Run continuity checkpoint --daemon with --project-id, --task-id, --status, --progress, --next, and --canon-file when a reconciled canon is available.
For long sessions or compaction recovery, also run continuity session-start with --project-id and --task-id to persist the exact recovery command.
Fallback if daemon is unavailable: run the same checkpoint command without --daemon for PostgreSQL compatibility.
MSG
fi
