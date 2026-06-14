# Agent Continuity

Durable checkpoint and resume state for coding agents, backed by
[Absurd](https://github.com/earendil-works/absurd) and PostgreSQL.

Agent Continuity makes checkpoint writes an explicit durable workflow instead of
local dotfile glue. The agent still owns the semantic summary, but Absurd owns
the execution boundary: append the journal, rewrite the canon, and export current
markdown projections as one retry-safe workflow.

## Why Agents Were Not Using Absurd Before

Claude and OpenCode integrations were only prompt/hook reminders. They told the
agent to read or write markdown files under `~/.config/opencode/checkpoints`, but
no agent-facing command existed that routed the write through Absurd. The missing
piece was a CLI and integration contract that agents can call deterministically.

This repo provides that contract:

- `continuity checkpoint` submits an Absurd task and waits for it to complete.
- PostgreSQL is the authority for journal entries and canon state.
- Markdown canon/journal files are exported projections for compatibility.
- OpenCode and Claude integrations instruct agents to use the CLI instead of
  editing checkpoint files directly.

## Architecture

```text
agent -> continuity CLI -> Absurd task -> PostgreSQL continuity tables
                                |
                                +-> markdown projection
```

The durable task has three checkpointed steps:

1. `append-journal`: insert an idempotent journal entry into Postgres.
2. `rewrite-canon`: upsert the canon row for the task.
3. `export-markdown`: atomically rewrite `<TASK-ID>.md` and `<TASK-ID>.canon.md`.

If the process crashes between steps, Absurd retries from the last completed
step. The database remains the source of truth; markdown is recoverable output.

## Quick Start

Install dependencies and build:

```bash
npm install
npm run build
```

Point the CLI at an Absurd-initialized database:

```bash
export CONTINUITY_DATABASE_URL="postgresql://postgres@127.0.0.1:5433/absurd_poc"
export CONTINUITY_QUEUE="default"
```

Write a checkpoint:

```bash
continuity checkpoint \
  --task-id agent-continuity-absurd \
  --status completed \
  --progress "Absurd-backed checkpoint write succeeded." \
  --next "Install agent integrations."
```

Fold an agent-authored canon file back into the database authority and exported
projection:

```bash
continuity reconcile \
  --task-id agent-continuity-absurd \
  --canon-file ~/.config/opencode/checkpoints/agent-continuity-absurd.canon.md
```

Resume from the database authority:

```bash
continuity resume --task-id agent-continuity-absurd
```

Inspect runtime state:

```bash
continuity status
```

## Configuration

| Variable | Default |
| --- | --- |
| `CONTINUITY_DATABASE_URL` | `ABSURD_DATABASE_URL`, then `postgresql://postgres@127.0.0.1:5433/absurd_poc` |
| `CONTINUITY_QUEUE` | `default` |
| `CONTINUITY_CHECKPOINT_DIR` | `~/.config/opencode/checkpoints` |
| `CONTINUITY_WORKER_TIMEOUT_SECONDS` | `30` |

For local development without publishing the package, create a user-local link:

```bash
npm run build
ln -sf "$PWD/dist/src/cli.js" ~/.local/bin/continuity
```

## Integrations

Integration templates live under `integrations/`.

- OpenCode: `integrations/opencode/canon-plugin.js`
- Claude: `integrations/claude/hooks/`

They are intentionally small. Their job is to inject the rule that agents call
`continuity` for resume/checkpoint operations. The CLI and database own the
durability guarantees.

## Development

```bash
npm run type-check
npm test
```

Database-backed integration checks are skipped unless
`CONTINUITY_TEST_DATABASE_URL` is set.
