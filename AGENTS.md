# Agent Instructions

This repository provides the `continuity` CLI and daemon: durable state,
coordination, recovery, scheduling, and peer sync for coding agents.

## Mental Model

- Accepted `continuityd` blocks and daemon projections are task authority.
- PostgreSQL/Absurd is a compatibility and migration path for the original
  checkpoint store.
- Markdown files under `~/.config/opencode/checkpoints` are compatibility
  projections.
- Agents own semantic intent and summary content; the CLI/daemon own identity,
  validation, durability, idempotency, sync, and projections.
- Never edit checkpoint markdown as the authority. Use `continuity` commands.
- Do not duplicate agent command syntax in hooks or skills. Query the executable
  contract with `continuity agent-contract --intent <INTENT>`.

## Install For A User

Use the published package when available:

```bash
npm install -g agent-continuity
continuity setup --local
continuity doctor
```

`setup --local` is idempotent. It creates or reuses a Docker-managed PostgreSQL
container, initializes the compatibility schema, writes local config, and
installs Codex, OpenCode, and Claude integrations.

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

Inspect the current agent-facing contract before relying on remembered syntax:

```bash
continuity agent-contract --intent resume
continuity <command> --help
```

On resume/orientation, prefer daemon authority and explicit project identity:

```bash
continuity resume --daemon --sync --project-id <PROJECT-ID> --task-id <TASK-ID> --lane-id main
```

Run this before reading markdown projections. If project identity is missing,
use `continuity session-resume --last`, infer it from the active git checkout, or
ask. Never silently select compatibility state for a same-named task.

On checkpoint:

```bash
continuity checkpoint --daemon \
  --project-id <PROJECT-ID> \
  --task-id <TASK-ID> \
  --status in_progress \
  --progress "<current truth>" \
  --next "<single next action>"
```

If a reconciled canon already exists and you have updated its content, pass it
through daemon authority with `--canon-file`:

```bash
continuity checkpoint --daemon --project-id <PROJECT-ID> --task-id <TASK-ID> ... --canon-file <TASK-ID>.canon.md
```

`continuity reconcile` and checkpoint commands without `--daemon` exist only for
the announced PostgreSQL/Absurd compatibility path:

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
