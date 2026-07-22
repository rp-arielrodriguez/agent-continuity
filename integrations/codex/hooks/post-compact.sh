#!/usr/bin/env bash
set -euo pipefail

continuity_bin="$(command -v continuity 2>/dev/null || true)"
if [[ -z "$continuity_bin" && -x "$HOME/.local/bin/continuity" ]]; then
  continuity_bin="$HOME/.local/bin/continuity"
fi

if [[ -n "$continuity_bin" ]]; then
  guide="$("$continuity_bin" agent-contract --intent recover)"
else
  guide="AGENT CONTINUITY: the continuity CLI is unavailable. Report this blocker before relying on projected state."
fi

GUIDE="$guide" node -e 'process.stdout.write(JSON.stringify({ continue: true, systemMessage: process.env.GUIDE }))'
