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

## For Agents

Read `AGENTS.md` first. It is the agent-facing source of truth for installation,
configuration, resume/checkpoint usage, verification, and safety rules.

## Architecture

```text
agent -> continuity CLI -> Absurd task -> PostgreSQL continuity tables
                                |
                                +-> markdown projection
```

The product-grade decentralized runtime direction is documented in
[`docs/decentralized-runtime.md`](docs/decentralized-runtime.md). The daemon
runtime now provides the provider-first path: signed task blocks, project/task
and lane state, lease validation, peer sync, dashboard rendering, and a migration
bridge from the existing PostgreSQL/Absurd state.

The SDK pieces are available from `agent-continuity/sdk`: signed task blocks,
the transition validation contract, `MemoryProvider`, the persistent
SQLite-backed `SQLiteProvider`, durable node signer storage, and
`LocalDaemonProvider`. `LocalDaemonProvider` talks to `continuityd` over
JSON-RPC on a Unix socket, exposes explicit peer sync via `syncPeers`, trusted
address-book sync via `syncTrustedPeers`, durable peer trust management, signed
peer invites, signed rendezvous presence, local mDNS/DNS-SD discovery, and
optional Tailscale/ZeroTier candidate discovery via `discoverPeers`.
`migratePostgresTaskToProvider` migrates existing PostgreSQL/Absurd journal and
canon state into signed task blocks.

The Go daemon lives under `daemon/`; it exposes the local SQLite store over
JSON-RPC on a Unix socket and can optionally serve a read-only TCP peer listener
with `continuityd --peer-listen <host:port>`.
`continuity dashboard --project-id <PROJECT> --task-id <TASK>` renders a
tmux-friendly lane snapshot from the local daemon.
`continuity daemon-install` builds or updates the local `continuityd` binary
from the packaged Go source; `--launchd` writes a macOS launch agent plist
without loading it implicitly.

The durable task has three checkpointed steps:

1. `append-journal`: insert an idempotent journal entry into Postgres.
2. `rewrite-canon`: upsert the canon row for the task.
3. `export-markdown`: atomically rewrite `<TASK-ID>.md` and `<TASK-ID>.canon.md`.

If the process crashes between steps, Absurd retries from the last completed
step. The database remains the source of truth; markdown is recoverable output.

## Quick Start

Install the CLI:

```bash
npm install -g agent-continuity
```

Install the local runtime, integrations, and daemon:

```bash
continuity install
continuity doctor
```

`continuity install` is idempotent. It creates/reuses a Docker-managed
PostgreSQL container and named volume, initializes Absurd and the
`continuity.*` tables, writes `~/.config/agent-continuity/config.json`, installs
the OpenCode and Claude integrations, builds `~/.local/bin/continuityd`, starts
the daemon, and reports doctor checks. Re-running it should report
existing/skipped resources rather than duplicating them.

Install and migrate an existing task into the daemon-backed block store:

```bash
continuity install \
  --project-id rp-arielrodriguez/agent-continuity \
  --task-id agent-continuity-decentralized-runtime \
  --lane-id main
```

Install only agent integrations, without touching the runtime:

```bash
continuity install --target all
continuity install --target opencode
continuity install --target claude
```

Uninstall local artifacts:

```bash
continuity uninstall
continuity uninstall --delete-data
```

Default uninstall stops the daemon, removes integrations, removes config,
removes the Docker container, and keeps data. `--delete-data` also removes the
Docker volume and default daemon state directory. The CLI binary itself is owned
by npm or your local development symlink and is not removed by `continuity
uninstall`.

OpenCode is configured as an npm plugin (`"agent-continuity"` in
`opencode.json`), not as a copied `file://` plugin. OpenCode installs npm
plugins into its own cache at startup, so publish the package before using this
mode outside local development.

If `~/.config/agent-continuity/config.json` already points at a database and no
Docker options are passed, `setup --local` reuses and verifies that database
instead of replacing the config.

Lower-level setup remains available when you need direct control:

```bash
continuity setup --local --daemon
continuity setup --local --daemon --daemon-launchd --daemon-peer-listen 100.64.0.2:9987
```

`--daemon` builds `continuityd`, writes daemon paths into the local config, and
keeps PostgreSQL configured as the compatibility source for legacy
checkpoint/resume operations. `--daemon-launchd` also writes a macOS launch
agent plist; it does not load it implicitly.

Default local runtime:

- container: `agent-continuity-postgres`
- volume: `agent-continuity-postgres-data`
- host/port: `127.0.0.1:5433`
- database: `agent_continuity`
- user: `continuity`
- password: generated and stored only in the local config file

The Absurd SQL schema is fetched from a pinned upstream commit during setup when
the target database does not already have the `absurd` schema.

Write and resume daemon-backed continuity state:

```bash
continuity checkpoint \
  --daemon \
  --task-id agent-continuity-decentralized-runtime \
  --status completed \
  --progress "Daemon-backed checkpoint write succeeded." \
  --next "Continue from daemon canon."

continuity resume --daemon --task-id agent-continuity-decentralized-runtime
```

`--project-id` is optional inside a git checkout with `remote.origin.url`; the
CLI infers `<owner>/<repo>`. Use `--project-id <OWNER>/<REPO>` outside a git
checkout or when the inferred project is not the desired continuity namespace.

Resume the same task from another trusted machine:

```bash
# On the machine that has useful task state, expose a read-only peer listener.
continuity daemon-start --peer-listen :9987

# Recommended one-peer bootstrap: create a signed invite on the source machine.
continuity peer-invite-create \
  --endpoint tcp://10.44.110.222:9987 \
  --name ariel-main \
  --provider zerotier

# Accept that invite once on the machine that wants to resume the task.
continuity peer-invite-accept --invite 'continuity://peer?...'

# Pull blocks from trusted peers before printing the daemon canon.
continuity resume \
  --daemon \
  --sync \
  --project-id rp-arielrodriguez/agent-continuity \
  --task-id agent-continuity-decentralized-runtime
```

`peer-add`, `peer-list`, `peer-remove`, and `peer-sync` operate on the local
daemon address book. Signed invite, signed rendezvous presence, and mDNS are the
provider-agnostic onboarding paths. `presence-publish` and `presence-discover`
are the direct file/directory primitives:

```bash
# Shared directory, git checkout, bucket mount, NAS path, or private VPS path.
continuity presence-publish \
  --rendezvous /shared/continuity \
  --port 9987 \
  --project-id rp-arielrodriguez/agent-continuity

continuity presence-discover \
  --rendezvous /shared/continuity \
  --project-id rp-arielrodriguez/agent-continuity \
  --trusted-node-ids <NODE_ID> \
  --add
```

`rendezvous-publish` and `rendezvous-discover` wrap that signed presence model in
first-class backends. Git stores presence files on a branch; S3 also covers
S3-compatible providers such as R2 through `--s3-endpoint-url`; HTTPS reads
`index.json` and can publish with authenticated `PUT`:

```bash
# Git-backed rendezvous. The default branch is continuity-rendezvous.
continuity rendezvous-publish \
  --backend git \
  --repo git@github.com:OWNER/REPO.git \
  --branch continuity-rendezvous \
  --dir rendezvous \
  --port 9987 \
  --project-id rp-arielrodriguez/agent-continuity

continuity rendezvous-discover \
  --backend git \
  --repo git@github.com:OWNER/REPO.git \
  --branch continuity-rendezvous \
  --dir rendezvous \
  --project-id rp-arielrodriguez/agent-continuity \
  --trusted-names ariel-main \
  --add

# S3, R2, or another S3-compatible object store.
continuity rendezvous-publish \
  --backend s3 \
  --url s3://bucket/continuity \
  --s3-endpoint-url https://ACCOUNT_ID.r2.cloudflarestorage.com \
  --port 9987

continuity rendezvous-discover \
  --backend s3 \
  --url s3://bucket/continuity \
  --s3-endpoint-url https://ACCOUNT_ID.r2.cloudflarestorage.com \
  --trusted-names ariel-main \
  --add

# Private HTTPS rendezvous.
continuity rendezvous-publish \
  --backend https \
  --url https://rendezvous.example/continuity \
  --http-token "$CONTINUITY_RENDEZVOUS_TOKEN" \
  --port 9987

continuity rendezvous-discover \
  --backend https \
  --url https://rendezvous.example/continuity \
  --trusted-names ariel-main \
  --add
```

```bash
# Local network discovery when DNS-SD is available.
continuity mdns-advertise --port 9987 --name ariel-main
continuity mdns-advertise --port 9987 --name ariel-main --background
continuity mdns-advertise-status
continuity mdns-advertise-stop
continuity mdns-discover --trusted-names ariel-main --add

# Daemon-managed mDNS advertisement. The daemon keeps the registration alive.
continuity mdns-advertise --daemon --port 9987 --name ariel-main
continuity mdns-advertise-status --daemon
continuity mdns-advertise-stop --daemon
```

`peer-discover --peer-port <PORT> --trusted-names <NAME> --add` remains an
optional convenience resolver for Tailscale/ZeroTier local state. It is not the
core trust or discovery model. The trust decision stays local and explicit, and
bulk `--add` requires a trusted name or node-id filter. Remote peer listeners are
read-only; all writes still go through the local Unix socket and signed-block
validation.

Compatibility PostgreSQL checkpoint/resume remains available:

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

Resume from the PostgreSQL compatibility authority:

```bash
continuity resume --task-id agent-continuity-absurd
```

Render a daemon-backed lane dashboard:

```bash
continuity dashboard \
  --project-id rp-arielrodriguez/agent-continuity \
  --task-id agent-continuity-decentralized-runtime \
  --lane-id main
```

Build or update the local daemon binary:

```bash
continuity daemon-install
continuity daemon-install --dry-run --launchd --peer-listen 100.64.0.2:9987
```

Run the daemon-backed daily path:

```bash
continuity daemon-start
continuity daemon-status
continuity daemon-migrate \
  --project-id rp-arielrodriguez/agent-continuity \
  --task-id agent-continuity-decentralized-runtime \
  --lane-id main
continuity dashboard \
  --project-id rp-arielrodriguez/agent-continuity \
  --task-id agent-continuity-decentralized-runtime \
  --lane-id main
continuity daemon-stop
```

By default the daemon socket is `<stateDir>/continuityd.sock`. If that path
would exceed the Unix socket path limit, the CLI deterministically falls back to
a short `/tmp/continuityd-<hash>.sock` path and prints the chosen socket in
`daemon-install`, `daemon-status`, and lifecycle output.

Inspect runtime state:

```bash
continuity status
```

Lifecycle helpers:

```bash
continuity start
continuity stop
continuity backup
continuity uninstall          # keeps the Docker volume
continuity uninstall --delete-data
```

## Configuration

| Variable | Default |
| --- | --- |
| `CONTINUITY_DATABASE_URL` | Overrides `~/.config/agent-continuity/config.json` database URL |
| `CONTINUITY_QUEUE` | `default` |
| `CONTINUITY_CHECKPOINT_DIR` | `~/.config/opencode/checkpoints` |
| `CONTINUITY_WORKER_TIMEOUT_SECONDS` | `30` |

You can bypass the local config file with:

```bash
export CONTINUITY_DATABASE_URL="postgresql://..."
export CONTINUITY_QUEUE="default"
```

## Runtime Compatibility

- CLI: supported on Node.js 18+.
- OpenCode integration: plain ESM JavaScript plugin for OpenCode's plugin loader.
- Bun: not claimed yet. The plugin is ESM, but the CLI depends on `pg` and
  `absurd-sdk`; run the test suite under Bun before treating it as supported.

For local development without publishing the package, create a user-local link:

```bash
npm run build
ln -sf "$PWD/dist/src/cli.js" ~/.local/bin/continuity
```

The installer supports `--target opencode`, `--target claude`, `--target all`,
`--dry-run`, and `--home <path>` for isolated testing. Restart the agent runtime
after installing so config-time plugins/hooks are reloaded.

## Integrations

Integration templates live under `integrations/`.

- Claude: `integrations/claude/hooks/` prompt-submit hook

The OpenCode plugin is exported from the npm package via `./server`. The Claude
hook is intentionally small. Its job is to inject the rule that agents call
`continuity` for resume/checkpoint operations when the user prompt asks for that
workflow. The CLI and database own the durability guarantees.

## Development

```bash
npm run type-check
npm test
npm run build:daemon
cd daemon && go test ./...
npm run test:e2e
```

Database-backed integration checks are skipped unless
`CONTINUITY_TEST_DATABASE_URL` is set.
