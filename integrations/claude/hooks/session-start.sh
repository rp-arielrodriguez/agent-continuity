#!/usr/bin/env bash
set -euo pipefail

cat <<'MSG'
AGENT CONTINUITY: use `continuity resume --task-id <TASK-ID>` to orient from PostgreSQL/Absurd, and `continuity checkpoint ...` to save progress. Markdown checkpoint files are exported compatibility projections, not the source of truth.
MSG
