# Agent Instructions

This repository provides the `continuity` CLI: durable checkpoint and resume
state for coding agents, backed by Absurd and PostgreSQL.

## Mental Model

- PostgreSQL is the authority for journal entries and canon state.
- Markdown files under `~/.config/opencode/checkpoints` are exported projections.
- Agents own the semantic summary; the CLI owns durability, idempotency, and
  projection export.
- Never edit checkpoint markdown as the authority. Use `continuity` commands.

## Install For A User

Use the published package when available:

```bash
npm install -g agent-continuity
continuity setup --local
continuity doctor
```

`setup --local` is idempotent. It creates or reuses a Docker-managed PostgreSQL
container, initializes Absurd and the `continuity.*` tables, writes local config,
and installs OpenCode and Claude integrations.

OpenCode must use the npm plugin entry (`"agent-continuity"` in `opencode.json`),
not a copied `file://` plugin. OpenCode installs npm plugins into its own cache
at startup; publish the package before relying on this mode outside local
development.

If `~/.config/agent-continuity/config.json` already points at a database and no
Docker options are passed, `setup --local` reuses and verifies that database
instead of replacing the config.

Restart OpenCode and Claude after setup or integration changes so plugins and
hooks are reloaded.

## Local Development Install

When working from this repo before publishing:

```bash
npm install
npm run build
ln -sf "$PWD/dist/src/cli.js" ~/.local/bin/continuity
continuity doctor
```

## Configuration

Default config file:

```text
~/.config/agent-continuity/config.json
```

Important environment overrides:

```bash
export CONTINUITY_DATABASE_URL="postgresql://..."
export CONTINUITY_QUEUE="default"
export CONTINUITY_CHECKPOINT_DIR="~/.config/opencode/checkpoints"
```

Default Docker runtime created by `setup --local`:

- container: `agent-continuity-postgres`
- volume: `agent-continuity-postgres-data`
- database: `agent_continuity`
- host/port: `127.0.0.1:5433`
- user: `continuity`

The password is generated and stored only in the local config file.

## Agent Operating Protocol

On resume/orientation:

```bash
continuity resume --task-id <TASK-ID>
```

Run this before reading markdown projections. If the user says `resume from
<file>.md`, derive `<TASK-ID>` from the basename.

On checkpoint:

```bash
continuity checkpoint \
  --task-id <TASK-ID> \
  --status in_progress \
  --progress "<current truth>" \
  --next "<single next action>"
```

If a reconciled canon already exists and you have updated its content, pass it
back through the database authority:

```bash
continuity checkpoint --task-id <TASK-ID> ... --canon-file <TASK-ID>.canon.md
```

Or reconcile canon only:

```bash
continuity reconcile --task-id <TASK-ID> --canon-file <TASK-ID>.canon.md
```

## Runtime Commands

```bash
continuity doctor
continuity status
continuity start
continuity stop
continuity backup
continuity uninstall
```

`continuity uninstall` keeps the Docker volume. Only pass `--delete-data` when
the user explicitly asks to delete local checkpoint data.

## Verification For Code Changes

Run at least:

```bash
npm run type-check
npm test
```

For database-backed changes, also run the integration suite with a local
Absurd/PostgreSQL database:

```bash
CONTINUITY_TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5433/agent_continuity" \
CONTINUITY_TEST_QUEUE="default" \
npm test
```

For Docker runtime changes, run a disposable `--home`, unique container, unique
volume, and random port. Validate setup twice, doctor, checkpoint/resume,
backup, stop/start, uninstall `--delete-data`, and post-cleanup absence of the
test container and volume.

## Safety Rules

- Do not rename or delete user databases unless the user asks for it.
- Do not remove Docker volumes unless the user explicitly approved data deletion.
- Do not claim Bun support until the test suite runs under Bun.
- Keep npm install side-effect-free; machine mutation belongs in
  `continuity setup --local`.
