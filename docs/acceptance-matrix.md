# Continuity Acceptance Matrix

This matrix defines product behavior that must keep working as Continuity grows
from manual checkpoint sync into scheduler-backed agent execution.

## Capability Vocabulary

`tools` are harness capabilities, not model families. A task that declares
`tools: [shell, git, browser]` needs a runner that can safely expose those
interfaces to the agent process.

`modelFamilies` are model-provider capabilities. Codex can satisfy OpenAI model
families, Claude can satisfy Anthropic model families, OpenCode may satisfy
multiple provider families, and future local harnesses may satisfy local
inference families.

```yaml
worker:
  id: codex-main
  agent: codex
  modelFamilies: [openai]
  tools: [shell, git]

task:
  project: rp-arielrodriguez/agent-continuity
  policy: exclusive
  requires:
    modelFamilies: [openai]
    tools: [shell, git]
```

The scheduler should route by the intersection of task requirements and worker
capabilities. It should not assume that every agent can run every model or that
every model harness has the same tools.

## Acceptance Levels

```text
unit
  Pure validation and parsing behavior.

local-e2e
  Real temporary daemons and real CLI commands on one machine.

cross-machine
  Two physical machines using discovery/sync without fixed peer IPs.

future
  Product behavior documented here but not implemented yet.
```

## Matrix

| Area | Behavior | Level | Proof |
|---|---|---:|---|
| Install/update | CLI builds and daemon binary starts | local-e2e | `npm run build:all`, `daemon-start`, `daemon-status` |
| Manual continuity | Agent can checkpoint and resume through daemon | local-e2e | `checkpoint --daemon`, `resume --daemon` |
| Peer listener | Remote read-only listener serves blocks and rejects writes | unit/local-e2e | `daemon/internal/continuityd/peer_test.go`, acceptance smoke |
| Signed invite | Invite creates a trust payload and rejects tampering | unit | `test/peer-onboarding.test.ts` |
| Bulk trust guard | `--add` requires trusted names or node IDs | unit/local-e2e | `test/peer-onboarding.test.ts`, acceptance smoke |
| File rendezvous | Signed presence publishes and discovers from a directory | unit/local-e2e | `test/rendezvous-backend.test.ts`, acceptance smoke |
| Git rendezvous | Signed presence commits/pushes and discovers from branch | unit/local-e2e/cross-machine | `test/rendezvous-backend.test.ts`, acceptance smoke, remote validation |
| S3/R2 rendezvous | S3-compatible CLI contract uses `aws s3 cp/sync` | unit/local-e2e | `test/rendezvous-backend.test.ts`, acceptance smoke |
| HTTPS rendezvous | HTTPS PUT/index discovery works | unit/local-e2e | `test/rendezvous-backend.test.ts`, acceptance smoke |
| mDNS lifecycle | Daemon can start/status/stop mDNS advertisement | unit/local-e2e | `daemon/internal/continuityd/mdns_test.go`, acceptance smoke |
| mDNS discovery | Peer is discovered without fixed IP | cross-machine | A0263/Mac Studio validation output |
| Duplicate discovery | Same name with multiple node IDs/endpoints is deterministic | future | Needs acceptance case |
| Trust persistence | Trusted peers survive daemon DB state | unit | `daemon/internal/continuityd/peer_test.go` |
| Trust pinning | Node ID/public key mismatch does not silently update trust | future | Needs key-pinning policy |
| Trust revocation | Disabled/revoked peers are not used for sync | unit/future | Address book supports enabled state; revocation UX pending |
| Sync import | Trusted sync imports remote blocks with zero rejections | local-e2e/cross-machine | `test/e2e/multi-daemon.test.ts`, acceptance smoke, remote validation |
| Sync idempotency | Repeated sync inserts zero duplicate blocks | unit/local-e2e | `daemon/internal/continuityd/peer_test.go`, acceptance smoke |
| Sync partial success | One good peer plus one offline/divergent peer gives deterministic warnings | future | Needs acceptance case |
| Resume after sync | Resume prints synced canon from remote task history | local-e2e/cross-machine | `test/e2e/multi-daemon.test.ts`, acceptance smoke, remote validation |
| Invalid signatures | Tampered blocks and presence files are rejected | unit | `test/block.test.ts`, `test/peer-onboarding.test.ts` |
| Expiry | Expired signed presence is rejected | unit | `validatePeerPresence` coverage should be expanded |
| Divergence | Divergent lane blocks report per-block rejection | unit | `daemon/internal/continuityd/peer_test.go` |
| Lane isolation | Syncing one lane does not alter adjacent tasks or lanes | future | Needs acceptance case |
| Daemon restart | DB state survives daemon restart | unit/local-e2e | SQLite store tests; acceptance restart scenario should be added |
| Scheduler queue | Task intents enter a daemon-backed scheduler lane | unit/local-e2e | `test/scheduler.test.ts`, acceptance smoke |
| Background workers | Worker loop syncs trusted peers and runs newly submitted tasks without prompt paste | local-e2e | acceptance smoke |
| Exclusive scheduling | Fresh completed result prevents duplicate local execution | unit/local-e2e | `test/scheduler.test.ts`, cluster lab |
| Speculative scheduling | Offline workers publish forked candidate results and adjudication selects a winner | unit/local-e2e/real-agent | `test/scheduler.test.ts`, cluster lab, real-agent acceptance |
| Worker routing | Agent/model/tool capabilities choose eligible workers | unit/local-e2e | `test/scheduler.test.ts`, cluster lab |
| Worker safety | Project/command/timeout policy gates runner execution | unit/local-e2e | `test/scheduler.test.ts`, acceptance smoke |
| Worker presets | Codex/Claude/OpenCode presets fill worker and command defaults | unit/local-e2e | `test/scheduler.test.ts`, acceptance smoke |
| Real agent execution | Codex, Claude, and OpenCode execute scheduler tasks and produce verified filesystem changes | real-agent | `npm run test:real-agents` |
| Worktree isolation | Runner executes from an assignment-specific worktree directory, including same-machine speculative workers | unit/real-agent | `test/scheduler.test.ts`, real-agent acceptance |
| tmux attach | Human can start/status/attach/stop worker loop sessions | local smoke | CLI tmux smoke |

## Current Executable Acceptance

Run:

```bash
npm run test:acceptance
npm run test:real-agents
```

`npm run test:acceptance` starts two temporary `continuityd` processes and
validates:

- daemon startup and health
- source daemon checkpoint
- daemon-managed mDNS start/status/duplicate-start/stop
- file rendezvous publish/discover
- git rendezvous publish/discover plus explicit trusted filter guard
- HTTPS rendezvous PUT/index discovery
- S3-compatible rendezvous through an `aws` CLI shim
- trusted peer list
- trusted peer sync
- daemon resume after sync
- repeated sync idempotency
- distributed scheduler task execution through `scheduler-worker-loop`
- background scheduler worker loop discovering and running a new task without
  manual prompting

`npm run test:real-agents` requires authenticated local Codex, Claude, and
OpenCode CLIs. It validates:

- each agent completes an exclusive scheduler task through `scheduler-worker-loop`
- each agent produces a verified proof file in its isolated worktree
- a speculative task can collect real results from all three agents
- `scheduler-adjudicate` records a winning result and collapses scheduler heads

## Cross-Machine Acceptance

The cross-machine acceptance path must use no fixed peer IP:

```text
source node
  continuity mdns-advertise --daemon --port 9987 --name <name>
  continuity rendezvous-publish --backend git ...

target node
  continuity mdns-discover --trusted-names <name> --add
  continuity rendezvous-discover --backend git ... --trusted-names <name> --add
  continuity peer-sync --project-id <project> --task-id <task>
  continuity peer-sync --project-id <project> --task-id <task> --json
  continuity resume --daemon --sync --project-id <project> --task-id <task>
```

The accepted proof is:

- both discovery paths produce the same logical peer
- trusted peer list contains that peer
- initial sync reports zero rejected blocks and inserts advertised missing blocks
- repeat sync reports advertised blocks but zero missing/fetched/inserted blocks
- resume prints the expected canon
- `lane-snapshot` followed by `lane-retain` leaves a compacted active snapshot
- a fresh daemon can sync and resume from that compacted snapshot without the old
  archived parent blocks
- local test matrix passes on the target machine

## Gaps To Close Next

- Add unit coverage for expired presence rejection.
- Add a local-e2e restart persistence scenario.
- Add duplicate discovery, key-pinning, disabled-peer, and lane isolation
  acceptance cases.
- Add physical cross-machine worker-loop acceptance with both nodes already
  running workers.
- Add persisted worker profiles/config files for multiple named workers.
- Add real S3/R2 and private HTTPS environment-backed smoke tests when
  credentials/endpoints are available.
