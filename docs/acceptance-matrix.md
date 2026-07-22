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

## Evidence Axes

```text
unit
  Pure TypeScript/Go behavior without long-running daemons.

local-daemon
  Real temporary continuityd processes plus the built CLI on one host.

acceptance
  Product smoke that starts daemons and drives public CLI flows.

container
  Clean Docker nodes that install from source and communicate through rendezvous.

cross-machine
  Two physical machines using discovery/sync without fixed peer IPs.
```

## Rubik Matrix

Every supported product use case has an ID and at least one executable evidence
path. `N/A` means that axis is not meaningful for that behavior, not that the
behavior is untested.

| ID | Plane | Use case | Unit | Local daemon | Acceptance | Container | Cross-machine |
|---|---|---|---|---|---|---|---|
| AC-INSTALL-001 | install | CLI builds, daemon installs, and daemon health is observable | `test/bootstrap-install.test.ts`, `test/daemon-install.test.ts` | `npm run test:e2e` | `npm run test:acceptance` | `npm run test:cluster` | target machine local test suite |
| AC-MANUAL-001 | manual continuity | Agent checkpoint/resume works through daemon source of truth | `test/daemon-workflow.test.ts` | `test/e2e/multi-daemon.test.ts` | `npm run test:acceptance` | `npm run test:cluster` via harness checkpoint | physical sync/resume transcript |
| AC-HARNESS-ORIENT-001 | agent harness | `orient` renders canon, owner, head, and sync context for an agent prompt | `test/agent-harness.test.ts` | `test/e2e/multi-daemon.test.ts` | `npm run test:acceptance` | `npm run test:cluster` | physical `resume --daemon --sync` plus `orient` |
| AC-HARNESS-CLAIM-001 | agent harness | `claim` bootstraps empty lanes and pauses on fresh foreign ownership | `test/agent-harness.test.ts`, `test/provider.test.ts` | `test/e2e/multi-daemon.test.ts` | `npm run test:acceptance` | `npm run test:cluster` | physical lease conflict smoke |
| AC-HARNESS-SAVE-001 | agent harness | `save` is a compact daemon checkpoint UX for interactive agents | `test/daemon-workflow.test.ts` | `test/e2e/multi-daemon.test.ts` | `npm run test:acceptance` | `npm run test:cluster` via `agent-run` checkpoint | physical checkpoint/resume transcript |
| AC-HARNESS-HANDOFF-001 | agent harness | `handoff` transfers ownership or releases the lane | `test/agent-harness.test.ts`, `test/provider.test.ts` | `test/e2e/multi-daemon.test.ts` | `npm run test:acceptance` | N/A | physical handoff smoke |
| AC-HARNESS-RUN-001 | agent harness | `agent-run` injects continuity env, runs allowed command, and checkpoints stdout/stderr | `test/agent-harness.test.ts` | `test/e2e/multi-daemon.test.ts` | `npm run test:acceptance` | `npm run test:cluster` | physical installed CLI smoke |
| AC-HARNESS-RUN-002 | agent harness | `agent-run` refuses unsafe commands and pauses before execution when another owner is fresh | `test/agent-harness.test.ts` | `test/e2e/multi-daemon.test.ts` | `npm run test:acceptance` command allowlist | N/A | physical lease conflict smoke |
| AC-INTENT-001 | intent contract | Typed intent/recovery contracts define agent-natural resume, checkpoint, delegation, recovery, and adjudication semantics | `test/block.test.ts` | `test/daemon-provider.test.ts` | CLI `session-start`/`run-event-add` smoke | N/A | physical agent prompt/recovery smoke |
| AC-INTENT-002 | intent contract | Versioned human/JSON contracts and command help are discoverable without executing commands or searching source | `test/agent-contract.test.ts`, `test/cli.test.ts` | CLI `agent-contract`/`checkpoint --help` smoke | hook intent smoke | container clean-install help smoke | physical clean-agent prompt smoke |
| AC-INTEGRATION-001 | agent integrations | Installer owns current Codex, Claude, and OpenCode hooks/skills and removes known legacy SessionStart hooks | `test/install.test.ts` | N/A | isolated-home install/idempotency smoke | clean-container install | target machine integration update |
| AC-INTEGRATION-002 | agent integrations | Hooks and skills delegate syntax to the executable contract and contain no stale authority guidance | `test/agent-contract.test.ts` | N/A | prompt-hook output smoke | clean-container natural-intent smoke | physical Codex/Claude/OpenCode natural-intent smoke |
| AC-RECOVERY-001 | recovery | Daemon-backed orientation fails loudly when project identity is missing instead of falling back to stale compatibility state | `test/cli.test.ts`, `test/project.test.ts` | CLI `resume --daemon` error smoke | `npm run test:acceptance` strict identity path | N/A | physical non-git cwd resume smoke |
| AC-RECOVERY-002 | recovery | Session envelopes persist cwd, exact recovery command, related projects, and survive compaction-style resume | `test/block.test.ts`, `test/daemon-provider.test.ts` | CLI `session-start`/`session-resume --last` smoke | `npm run test:acceptance` session envelope path | `npm run test:cluster` session envelope path | physical post-compact recovery smoke |
| AC-RUNEVENT-001 | recovery | Operational blockers such as auth, disk, network, daemon, git, and tool failures survive resume/orient as run events | `test/block.test.ts`, `test/daemon-provider.test.ts` | CLI `run-event-add`/`run-event-list` smoke | `npm run test:acceptance` run-event path | `npm run test:cluster` run-event path | physical 1Password/disk blocker recovery smoke |
| AC-DISCOVERY-001 | discovery | Signed file rendezvous publish/discover works without fixed peer IPs | `test/rendezvous-backend.test.ts` | N/A | `npm run test:acceptance` | `npm run test:cluster` | physical file/git rendezvous transcript |
| AC-DISCOVERY-002 | discovery | Git rendezvous publish/discover works with trusted filters | `test/rendezvous-backend.test.ts` | N/A | `npm run test:acceptance` | N/A | physical git rendezvous transcript |
| AC-DISCOVERY-003 | discovery | S3/R2 and HTTPS rendezvous contracts are executable | `test/rendezvous-backend.test.ts`, `test/peer-onboarding.test.ts` | N/A | `npm run test:acceptance` with local HTTP/fake S3 | N/A | environment-backed smoke when credentials exist |
| AC-DISCOVERY-004 | discovery | Daemon-managed mDNS can start/status/stop and physical peers can be found without fixed IPs | `daemon/internal/continuityd/mdns_test.go` | N/A | `npm run test:acceptance` lifecycle | N/A | A0263/Mac Studio mDNS transcript |
| AC-TRUST-001 | trust | Bulk trust requires explicit name/node filters; invites and presence reject tampering | `test/peer-onboarding.test.ts`, `test/block.test.ts` | N/A | `npm run test:acceptance` trusted-filter guard | `npm run test:cluster` trust-names | physical trusted-name discovery transcript |
| AC-SYNC-001 | sync | Delta sync advertises inventory and fetches only missing blocks | `daemon/internal/continuityd/peer_test.go` | `test/e2e/multi-daemon.test.ts` | `npm run test:acceptance` | `npm run test:cluster` | physical peer-sync transcript |
| AC-SYNC-002 | sync | Repeated sync is idempotent and inserts zero duplicate blocks | `daemon/internal/continuityd/peer_test.go` | `test/e2e/multi-daemon.test.ts` | `npm run test:acceptance` | `npm run test:cluster` | physical repeat-sync transcript |
| AC-STORAGE-001 | storage | Lane inventory is scoped by project/task/lane and shows heads/archive/blob refs | `test/daemon-provider.test.ts`, Go store tests | `test/e2e/multi-daemon.test.ts` | `npm run test:acceptance` | N/A | physical lane-inventory smoke |
| AC-STORAGE-002 | storage | Snapshot/retention compacts old active blocks and fresh peers sync the compacted lane | `test/provider.test.ts`, `daemon/internal/continuityd/peer_test.go` | `test/e2e/multi-daemon.test.ts` | cross-covered by e2e | N/A | physical snapshot/retention transcript |
| AC-STORAGE-003 | storage | Large canons/artifacts externalize to content-addressed blobs and can be read back | `daemon/internal/continuityd/store_test.go`, `test/daemon-provider.test.ts` | `blob-get` CLI smoke after large checkpoint | N/A | N/A | physical blob smoke when large artifact exists |
| AC-SCHED-001 | scheduler | Task intents enter daemon-backed scheduler lanes and dashboards render state | `test/scheduler.test.ts`, `test/dashboard.test.ts` | `test/e2e/multi-daemon.test.ts` | `npm run test:acceptance` | `npm run test:cluster` | physical scheduler sync transcript |
| AC-SCHED-002 | scheduler | Background workers sync trusted peers and run tasks without prompt paste | `test/scheduler.test.ts` | N/A | `npm run test:acceptance` | `npm run test:cluster` | physical worker-loop smoke |
| AC-SCHED-003 | scheduler | Exclusive scheduling prevents duplicate execution after a fresh result | `test/scheduler.test.ts` | N/A | `npm run test:acceptance` | `npm run test:cluster` | physical worker-loop smoke |
| AC-SCHED-004 | scheduler | Speculative scheduling keeps competing forked results and adjudication collapses heads | `test/scheduler.test.ts` | N/A | N/A | `npm run test:cluster` | physical speculative/adjudication smoke |
| AC-SCHED-005 | scheduler | Agent/model/tool capabilities route work to eligible Codex/Claude/OpenCode profiles | `test/scheduler.test.ts` | N/A | `npm run test:acceptance` | `npm run test:cluster` | physical mixed-agent smoke |
| AC-SCHED-006 | scheduler | Project allowlist, command allowlist, and runner timeout gate execution | `test/scheduler.test.ts`, `test/agent-harness.test.ts` | N/A | `npm run test:acceptance` | `npm run test:cluster` | physical runner safety smoke |
| AC-SCHED-007 | scheduler | Evaluator contracts record rubric scores, UX use-case evidence, risks, and recommendations before adjudication | `test/block.test.ts`, `test/scheduler.test.ts`, `test/local-store.test.ts`, `daemon/internal/continuityd/store_test.go` | CLI `scheduler-evaluate` smoke | N/A | `npm run test:cluster` evaluator lane smoke | physical evaluator/adjudication smoke |
| AC-TMUX-001 | operator UI | Worker loops can be started, tailed, attached, and stopped through tmux commands | `test/scheduler.test.ts` for loop core | CLI tmux smoke when `tmux` exists | install `--start-worker` smoke | container tmux smoke if image has tmux | physical tmux attach smoke |
| AC-REAL-AGENTS-001 | real agents | Codex, Claude, and OpenCode execute scheduler tasks and leave verified filesystem proof | N/A | `npm run test:real-agents` | `npm run test:real-agents` | N/A | physical agent CLI auth required |

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
- agent-native `claim`, `save`, `agent-run`, `handoff`, release, peer sync, and
  synced `orient`
- distributed scheduler task execution through `scheduler-worker-loop`
- background scheduler worker loop discovering and running a new task without
  manual prompting

`npm run test:real-agents` requires authenticated local Codex, Claude, and
OpenCode CLIs. It validates:

- each agent completes an exclusive scheduler task through `scheduler-worker-loop`
- each agent produces a verified proof file in its isolated worktree
- a speculative task can collect real results from all three agents
- evaluator contracts can preserve UX/use-case evidence before winner selection
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
  continuity orient --project-id <project> --task-id <task> --sync
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
- `agent-run` on one machine produces a checkpoint that the other machine can sync
  and inspect through `orient`
- local test matrix passes on the target machine

## Deliberate Non-Matrix Work

These are product extensions, not currently claimed as supported acceptance:

- key-pinning policy for changed peer public keys
- disabled-peer revocation UX beyond the stored enabled flag
- persisted named worker profile files
- strict project identity resolution for daemon-backed orientation: `resume`,
  `orient`, and session-start hooks must require an explicit or inferable project
  id, and must fail loudly instead of falling back to stale compatibility state
  when project inference fails outside a git checkout
- real S3/R2/private HTTPS smoke tests outside local shims
- richer remote orchestration that starts real Codex/Claude/OpenCode sessions on a
  second physical machine without SSH/operator intervention
