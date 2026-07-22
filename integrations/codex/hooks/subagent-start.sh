#!/usr/bin/env bash
set -euo pipefail

continuity_bin="$(command -v continuity 2>/dev/null || true)"
if [[ -z "$continuity_bin" && -x "$HOME/.local/bin/continuity" ]]; then
  continuity_bin="$HOME/.local/bin/continuity"
fi

if [[ -n "$continuity_bin" ]]; then
  "$continuity_bin" agent-contract --intent orient
  printf '%s\n' "subagent-rule: use only the assigned task/lane authority. Persist state only when ownership was delegated; otherwise return findings and a canon delta to the parent."
else
  printf '%s\n' "AGENT CONTINUITY: the continuity CLI is unavailable. Report this blocker before relying on projected state."
fi
