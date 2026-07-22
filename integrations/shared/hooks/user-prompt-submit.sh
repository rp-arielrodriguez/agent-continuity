#!/usr/bin/env bash
set -euo pipefail

input="$(cat || true)"
prompt="${CLAUDE_USER_PROMPT:-}"

if [[ -z "$prompt" && -n "$input" ]]; then
  prompt="$(INPUT="$input" node -e '
const input = process.env.INPUT || "{}";
try {
  const data = JSON.parse(input);
  process.stdout.write(String(data.prompt || data.tool_input?.prompt || data.user_prompt || ""));
} catch {
  process.stdout.write("");
}
' 2>/dev/null)"
fi

continuity_bin="$(command -v continuity 2>/dev/null || true)"
if [[ -z "$continuity_bin" && -x "$HOME/.local/bin/continuity" ]]; then
  continuity_bin="$HOME/.local/bin/continuity"
fi

print_contract() {
  local intent="$1"
  if [[ -n "$continuity_bin" ]]; then
    "$continuity_bin" agent-contract --intent "$intent"
  else
    printf '%s\n' "AGENT CONTINUITY: the continuity CLI is unavailable. Report this blocker instead of reconstructing task state from markdown or chat."
  fi
}

resume_re='([Rr]esume|[Cc]ontinue)[[:space:]]+from[[:space:]]+`?([^`[:space:]]+\.md)'
checkpoint_re='checkpoint|dump[[:space:]]+context|save[[:space:]]+progress|document[[:space:]]+state|guardar?[[:space:]]+progreso|guard[aá]'
orient_re='where[[:space:]]+are[[:space:]]+we|current[[:space:]]+state|what[[:space:]]+did[[:space:]]+we[[:space:]]+do|d[oó]nde[[:space:]]+estamos'

if [[ "$prompt" =~ $resume_re ]]; then
  file="${BASH_REMATCH[2]}"
  base="$(basename "$file")"
  task_id="${base%.md}"
  task_id="${task_id%.canon}"
  print_contract resume
  printf '%s\n' "task-hint: $task_id (project id must still be explicit, inferable from git, or recovered from a session envelope)"
elif [[ "$prompt" =~ $checkpoint_re ]]; then
  print_contract checkpoint
elif [[ "$prompt" =~ $orient_re ]]; then
  print_contract orient
fi
