# Chapter: Decentralized Continuity Runtime

This document is the architecture source for the product-grade decentralized
Continuity runtime. It is written for two readers:

- A human validating the mental model before implementation.
- An implementation agent that must build the system without inventing new
  product decisions.

The target product is local-first and provider-first. Agents should use a stable
client API, while the default backend is a local runtime that coordinates local
actors, persists signed task blocks, derives projections, and synchronizes with
trusted peers.

## 01 - Executive Mental Model

Continuity evolves from a local checkpoint CLI into a private task-state runtime.
The runtime is inspired by dApp/blockchain concepts, but it is not a public
chain dependency.

```text
agent/plugin/tmux
  -> Provider API
    -> local or remote provider backend
      -> validation contract
        -> signed task blocks
          -> derived projections
```

The source of truth is no longer "the latest canon row". The source of truth is
the accepted task block history. Canon, inventory, ownership, next actions, and
peer state are derived projections.

The first production backend should be a Go `continuityd` runtime. TypeScript
stays important as the SDK and integration layer for OpenCode, Claude, Codex,
and examples.

```text
TypeScript SDK / CLI / integrations
  -> JSON-RPC or HTTP over Unix socket / localhost
    -> Go continuityd
      -> local store + mempool + validation + peer sync
```

## 02 - Vocabulary

Use this vocabulary consistently in code and docs.

```text
project_id
  Namespace boundary. Usually a repo, workspace, or product area.

task_id
  Workstream inside a project, for example TARCH-175.

lane_id
  Concurrent sub-workstream inside a task, for example main, sdk-review,
  inventory, background-monitor.

node_id
  Machine/runtime identity owned by a local continuityd installation.

actor_id
  Agent/session/process identity. One node can run many actors.

provider
  Client-facing API abstraction. Agents talk to a provider, not directly to
  storage or peers.

provider backend
  Implementation behind the provider API: local daemon, remote daemon, embedded
  memory backend, or future contract backend.

block
  Immutable signed task event accepted into a project/task/lane chain.

tip
  Latest accepted block for a lane.

parent_tip
  The lane tip that a proposed block claims to extend.

lease_epoch
  Monotonic ownership version for a lane. It is the correctness guard.

lease_until
  Soft liveness hint used to decide when takeover may be attempted. It is not
  the only correctness guard.

mempool
  Pending proposed task events waiting for validation or conflict resolution.

projection
  Derived state computed from accepted blocks: canon, inventory, ownership,
  next actions, peer health.
```

Avoid Git vocabulary in the public model. Use `tip`, `parent_tip`, and `block`
instead of `head`, `parent_head`, and `commit`.

## 03 - Product Boundary

The product lives in `rp-arielrodriguez/agent-continuity`.

The product-grade split should be:

```text
agent-continuity/
  daemon/          Go continuityd runtime
  sdk/             TypeScript Provider API
  cli/             User CLI wrapping the Provider API
  proto/           Versioned wire API schemas
  docs/            Architecture, operations, and Level 3 explainers
  integrations/    OpenCode, Claude, Codex hook/plugin adapters
  tests/           Unit, daemon, provider, and multi-node e2e tests
```

The current TypeScript CLI and Postgres/Absurd implementation remain useful
during migration, but the long-term runtime boundary should not require agents
to write directly to a database.

## 04 - Architecture Layers

```text
+-----------------------------+
| Agent adapters              |
| Codex / Claude / OpenCode   |
+-------------+---------------+
              |
              v
+-------------+---------------+
| Provider API / SDK           |
| stable client contract       |
+-------------+---------------+
              |
              v
+-------------+---------------+
| Provider backend             |
| local daemon / remote daemon |
+-------------+---------------+
              |
              v
+-------------+---------------+
| Validation contract          |
| task/lane transition rules   |
+-------------+---------------+
              |
              v
+-------------+---------------+
| Task block store             |
| signed immutable events      |
+-------------+---------------+
              |
              v
+-------------+---------------+
| Projection index             |
| canon / inventory / owner    |
+-----------------------------+
```

The SDK should feel like a blockchain client:

```ts
const continuity = await Continuity.connect();
const lane = continuity.project("recarga/agent-continuity")
  .task("agent-continuity-decentralized-runtime")
  .lane("main");

const status = await lane.status({ actorId });
if (status.action === "continue") {
  await lane.checkpoint({ progress, canon, next });
}
```

Provider backends must be swappable:

```text
LocalDaemonProvider    unix://~/.continuityd.sock
RemoteDaemonProvider   https://node.tailnet.example
EmbeddedProvider       direct in-process store, mainly tests
MemoryProvider         deterministic unit tests
ContractProvider       future Ethereum/L2-style backend
```

## 05 - Data Model

The durable unit is a signed block.

```text
TaskBlock
  version
  block_id
  project_id
  task_id
  lane_id
  kind
  parent_tips[]
  node_id
  actor_id
  lease_epoch
  created_at
  payload_hash
  payload
  signature
```

Block kinds:

```text
bootstrap
  Creates a task/lane from existing context or migration input.

claim_lane
  Claims ownership for a lane and starts a new lease epoch.

heartbeat
  Extends soft liveness for the current owner without changing canon.

checkpoint
  Adds journal delta and usually updates focused canon.

canon_update
  Rewrites focused current truth for a lane.

inventory_update
  Updates broader task/workstream inventory without stealing active lanes.

handoff
  Transfers lane ownership to another actor.

release
  Owner voluntarily releases the lane.

pause
  Records that an actor stopped because another owner is active.

reconcile
  Records a conflict or lost-context reconciliation.
```

The hierarchy is:

```text
project_id
  task_id
    lane_id
      block tip
      blocks...
```

Example:

```text
project: rp-arielrodriguez/agent-continuity
  task: agent-continuity-decentralized-runtime
    lane: main
    lane: architecture-doc
    lane: sdk
    lane: daemon
    lane: inventory
```

## 06 - Validation Contract

The validation contract is normal application code in v1. It should be written
as if it could later become a smart contract.

Minimum rules:

```text
claim_lane:
  valid if lane has no owner, owner released, owner expired beyond grace, or
  explicit takeover policy allows it.

heartbeat:
  valid if signer is current owner and lease_epoch matches current lane state.

checkpoint:
  valid if signer is current owner, lease_epoch matches, parent_tip equals
  current lane tip, and referenced project/task/lane exist.

canon_update:
  valid under same ownership rule as checkpoint.

inventory_update:
  valid if actor has inventory lane or task-level reconcile permission. It does
  not steal main or implementation lanes.

handoff:
  valid if signer is current owner and target actor/node identity is known or
  explicitly allowed.

reconcile:
  valid if it references known block tips and declares the projections it
  updates.
```

Clocks are not trusted for correctness. Correctness uses:

```text
signer + lease_epoch + parent_tip
```

Wall-clock time is only a liveness hint:

```text
lease_until = soft expiry
lease_epoch = hard ownership version
```

If actor A owns epoch 4, actor B claims epoch 5, and actor A later submits a
checkpoint for epoch 4, the block is rejected even if actor A's clock believes
the old lease is valid.

## 07 - Rubik Matrix: Use Case x State

```text
+-----------------------------+-------------------+------------------+--------------------------+
| Use case                    | Observed state    | Daemon decision  | Agent instruction        |
+-----------------------------+-------------------+------------------+--------------------------+
| Start new task/lane         | no lane tip       | accept bootstrap | continue                 |
| Attach to free lane         | no owner          | accept claim     | continue                 |
| Attach to own lane          | same owner/epoch  | renew/continue   | continue                 |
| Attach to local active lane | other local owner | reject claim     | pause or choose lane     |
| Attach to remote active     | fresh remote owner| reject claim     | pause/drop local work    |
| Checkpoint current lane     | parent_tip current| accept block     | checkpoint accepted      |
| Checkpoint stale lane       | parent_tip stale  | reject block     | reconcile first          |
| Heartbeat current owner     | owner+epoch match | accept heartbeat | continue                 |
| Heartbeat stale owner       | epoch changed     | reject heartbeat | stop                     |
| Inventory update            | valid refs        | accept update    | inventory refreshed      |
| Import session context      | no conflict       | bootstrap/import | continue from imported   |
| Import stale context        | fresher tip exists| reject/import rq | reconcile first          |
| Handoff                     | owner signs       | accept handoff   | old pauses, new continues|
| Peer sync                   | valid new blocks  | index blocks     | update projections       |
| Peer conflict               | divergent tips    | mark reconcile   | ask for reconcile        |
+-----------------------------+-------------------+------------------+--------------------------+
```

## 08 - Rubik Matrix: Actor x Event

```text
+-------------------+-------------+-------------+------------+-----------+--------------+
| Actor type        | claim_lane  | checkpoint  | inventory  | handoff   | peer gossip  |
+-------------------+-------------+-------------+------------+-----------+--------------+
| Human-guided agent| yes         | yes         | maybe      | yes       | no direct    |
| Background agent  | scoped only | scoped only | yes        | no        | no direct    |
| Tmux UI           | request     | no          | observe    | request   | observe      |
| Local daemon      | validate    | validate    | validate   | validate  | yes          |
| Remote daemon     | validate    | validate    | validate   | validate  | yes          |
| Migration tool    | bootstrap   | no          | yes        | no        | no           |
+-------------------+-------------+-------------+------------+-----------+--------------+
```

Agents never gossip directly. Agents submit through the Provider API. Daemons
gossip and validate blocks.

## 09 - Rubik Matrix: Failure x Recovery

```text
+--------------------------+---------------------+----------------------+-------------------------+
| Failure                  | Detection           | Daemon response      | Recovery                |
+--------------------------+---------------------+----------------------+-------------------------+
| Actor crashed            | heartbeat expired   | lane claimable       | new actor claims epoch  |
| Stale actor returns      | old lease_epoch     | reject writes        | actor resumes/reconcile |
| Clock skew               | epoch mismatch      | reject stale writes  | trust lane state        |
| Remote peer offline      | peer health stale   | local work allowed   | sync when peer returns  |
| Network partition        | divergent tips      | mark conflict        | reconcile block         |
| Lost canon focus         | inventory scan      | accept inventory     | restore workstream map  |
| Corrupt block payload    | hash mismatch       | reject block         | refetch from peers      |
| Unknown signer           | trust lookup miss   | reject/quarantine    | explicit trust import   |
| Duplicate block          | block_id exists     | idempotent accept    | no-op                   |
| Stale migration import   | current tip newer   | reject import        | reconcile first         |
+--------------------------+---------------------+----------------------+-------------------------+
```

## 10 - Sequence: Node Startup And Peer Onboarding

```text
Human/CLI          Local Daemon       PeerBook          Remote Daemon
    |                   |                 |                  |
    | create signed invite on source      |                  |
    |------------------------------------------------------->|
    | continuity://peer?... with node_id, public_key, endpoint, signature
    |<-------------------------------------------------------|
    | accept invite       |                 |                  |
    |-------------------->| verify signature                  |
    |                     | validate endpoint                  |
    |                     |---------------->| store trusted peer
    |                     |<----------------|                  |
    | resume --sync       |                 |                  |
    |-------------------->| list trusted peers                 |
    |                     |---------------->|                  |
    |                     |<----------------| endpoints        |
    |                     | lane.blocks(ref)                   |
    |                     |----------------------------------->|
    |                     | signed blocks                      |
    |                     |<-----------------------------------|
    |                     | validate and index                 |
```

The same trust model supports multi-peer discovery without provider APIs:

```text
Source Daemon/CLI     Rendezvous or mDNS       Target CLI        Local Daemon
     |                  |                       |                         |
     | sign presence    |                       |                         |
     |----------------->| node_id/public_key/endpoints/projects/signature  |
     |                  |                       | discover presence       |
     |                  |<----------------------|                         |
     |                  | signed candidates     |                         |
     |                  |---------------------->| verify signature        |
     |                  |                       | filter trusted names/ids|
     |                  |                       |------------------------>|
     |                  |                       | trust selected endpoints|
     |                  |                       |------------------------>|
```

Tailscale, ZeroTier, LAN, SSH tunnels, NAS mounts, git repos, buckets, and VPS
paths are reachability or rendezvous layers. Continuity identity is always
`node_id + public key`.

Current implementation note: signed peer invites, signed rendezvous presence,
and mDNS/DNS-SD presence are provider-agnostic onboarding paths. Provider
resolvers such as Tailscale/ZeroTier discovery are optional convenience only.
Bulk discovery trust requires an explicit trusted name or node-id allowlist.
Durable trust is stored separately in the local daemon address book with
`peer.trustAdd`; `peer.syncTrusted` syncs only enabled address-book entries.
Remote peers are served through an optional read-only TCP JSON-RPC listener;
mutation RPCs remain available only on the local Unix control socket.

## 11 - Sequence: Agent Connects Through Provider

```text
Agent hook/plugin       TS SDK Provider       continuityd        Store
       |                      |                   |                |
       | connect()            |                   |                |
       |--------------------->| open socket/API   |                |
       |                      |------------------>| health/version |
       |                      |<------------------|                |
       | attach project/task/lane actor_id        |                |
       |--------------------->|------------------>| load lane      |
       |                      |                   |--------------->|
       |                      |                   | lane state     |
       |                      |                   |<---------------|
       |                      |<------------------| action         |
       |<---------------------| continue/pause/reconcile           |
```

The agent does not know if the backend is local or remote.

## 12 - Sequence: Lane Claim

```text
Agent              Provider          Daemon            Contract          Store
  |                   |                  |                  |                |
  | claim lane        |                  |                  |                |
  |------------------>| submit claim     |                  |                |
  |                   |----------------->| load lane state  |                |
  |                   |                  |------------------------------->   |
  |                   |                  | current owner/tip/lease           |
  |                   |                  |<-------------------------------   |
  |                   |                  | validate claim                    |
  |                   |                  |---------------->|                |
  |                   |                  | ok or reject                      |
  |                   |                  |<----------------|                |
  |                   |                  | write claim block if ok           |
  |                   |                  |------------------------------->   |
  |                   |<-----------------| accepted or pause                 |
  |<------------------|                  |                  |                |
```

The claim starts or advances a lane lease epoch.

## 13 - Sequence: Local Checkpoint Accepted

```text
Agent              Provider          Daemon            Contract          Store
  | checkpoint(payload,parent_tip,epoch)              |                |
  |------------------>| submit transaction             |                |
  |                   |----------------->| add to mempool               |
  |                   |                  | validate signer/epoch/tip    |
  |                   |                  |---------------->|           |
  |                   |                  | accepted                     |
  |                   |                  |<----------------|           |
  |                   |                  | build signed checkpoint block |
  |                   |                  |----------------------------->|
  |                   |                  | update canon projection       |
  |                   |                  |----------------------------->|
  |                   |                  | update inventory refs if any  |
  |                   |                  |----------------------------->|
  |                   |<-----------------| block_id + new tip            |
  |<------------------|                  |                              |
```

This is the "mint a task event" flow.

## 14 - Sequence: Same Machine, Same Lane Conflict

```text
Agent A           Agent B           Daemon              Store
   | attach T/main   |                 |                  |
   |---------------->| claim accepted  |----------------->|
   |<----------------| continue        |                  |
   |                 | attach T/main   |                  |
   |                 |---------------->| load lane owner  |
   |                 |                 |----------------->|
   |                 |                 | owner=Agent A    |
   |                 |<----------------| pause(local_active)
```

Same machine does not need network sync to prevent same-lane collisions.

## 15 - Sequence: Same Task, Different Lanes

```text
Codex Actor       Claude Actor       Daemon          Store
    |                 |                |              |
    | claim T/main    |                |              |
    |---------------->| accept main    |------------->|
    |<----------------| continue       |              |
    |                 | claim T/sdk    |              |
    |                 |--------------->| accept sdk   |
    |                 |<---------------|------------->|
    | checkpoint main |                |              |
    |---------------->| store M2       |------------->|
    |                 | checkpoint sdk |              |
    |                 |--------------->| store S2     |
    |                 |<---------------|------------->|
```

Task concurrency is valid when lanes are distinct.

## 16 - Sequence: Remote Active Owner Pauses Local Actor

```text
Peer(remote)          Daemon(local)          Store             Agent
    | gossip block         |                   |                 |
    |--------------------->| verify signature  |                 |
    |                      | validate block    |                 |
    |                      | store remote tip  |                 |
    |                      |------------------>|                 |
    |                      | mark lane remote_active             |
    |                      |------------------>|                 |
    |                      |                                     |
    |                      | later hook: can_work?               |
    |<----------------------------------------------------------|
    |                      | load lane state                     |
    |                      |------------------>|                 |
    |                      | remote lease fresh                  |
    |                      |<------------------|                 |
    |                      | return pause(remote_active)          |
    |---------------------------------------------------------->|
```

This implements the rule: if another machine is consistently working the same
lane, local actors stop instead of producing stale work.

## 17 - Sequence: Stale Parent Tip

```text
Agent              Daemon             Store              Peer/History
  | checkpoint parent_tip=B1            |                    |
  |---------------->| load current tip  |                    |
  |                 |------------------>| current tip=B3     |
  |                 |<------------------|                    |
  |                 | reject stale tip                       |
  |<----------------| needs_reconcile(current=B3,yours=B1)  |
  | request resume/inventory             |                    |
  |---------------->| derive projections                      |
  |                 |------------------>|                    |
  |                 | fetch missing blocks if needed          |
  |                 |---------------------------------------> |
  |                 |<--------------------------------------- |
  |<----------------| canon + inventory + diff                |
```

The rejected block is not discarded silently. The actor gets a deterministic
recovery instruction.

## 18 - Sequence: Inventory Reconcile

```text
Reconcile Actor       Daemon             Contract          Store
      | scan history      |                 |                |
      |------------------>| derive full inventory             |
      |                   |---------------------------------->|
      |                   | inventory projection               |
      |<------------------|                                  |
      | submit inventory_update block                         |
      |------------------>| validate no lane steal             |
      |                   |--------------->|                  |
      |                   | accepted       |                  |
      |                   |<---------------|                  |
      |                   | store block + projection           |
      |                   |---------------------------------->|
      |<------------------| accepted                          |
```

This preserves the useful current behavior where an agent can recover lost
workstream context from full history while leaving the focused canon intact.

## 19 - Sequence: Bootstrap Existing Agent Context

```text
Agent current session      Provider        Daemon          Store
        |                     |              |              |
        | summarize context   |              |              |
        | files/branch/diff   |              |              |
        | current canon/next  |              |              |
        |-------------------->| bootstrap    |              |
        |                     |------------->| check task   |
        |                     |              |------------->|
        |                     |              | no conflict  |
        |                     |              |<-------------|
        |                     |              | create bootstrap block
        |                     |              |------------->|
        |<--------------------| accepted + tip              |
```

If the task/lane already has a fresher tip, bootstrap is rejected with
`needs_reconcile`.

## 20 - Sequence: Lease Expiry And Epoch Takeover

```text
Actor A             Daemon             Actor B             Store
  | claim epoch 4      |                  |                  |
  |------------------->| store owner=A    |----------------->|
  | checkpoint epoch 4 |                  |                  |
  |------------------->| accepted         |----------------->|
  | goes silent        |                  |                  |
  |                    | lease_until passes + grace           |
  |                    |                  | claim lane       |
  |                    |<-------------------------------------|
  |                    | validate stale A                     |
  |                    | store owner=B epoch 5                |
  |                    |------------------------------------->|
  |                    | accepted         |                  |
  | later checkpoint epoch 4              |                  |
  |------------------->| reject stale_epoch                  |
```

Clocks only trigger takeover attempts. Epochs reject stale writes.

## 21 - Sequence: Handoff

```text
Actor A        Daemon A          Peer/Daemon B        Actor B
  | handoff T/main to Actor B       |                    |
  |------------>| create handoff block                    |
  |             |------------------->| gossip block       |
  |             |                    | lane owner=B       |
  |             |                    |------------------->|
  |             |                    | can_work?          |
  |             |                    |<-------------------|
  |             |                    | continue           |
  |<------------| released           |                    |
```

Handoff is preferred over accidental latest-writer takeover when the old owner
is healthy.

## 22 - Sequence: Peer Sync Over Overlay Transport

```text
CLI/Agent          Local Daemon       Trusted PeerBook      Remote Daemon
   | peer-add endpoint  |                    |                    |
   |------------------->| validate endpoint  |                    |
   |                    |------------------->| store enabled peer |
   |                    |<-------------------|                    |
   | resume --sync      |                    |                    |
   |------------------->| list enabled peers |                    |
   |                    |------------------->|                    |
   |                    |<-------------------| endpoints          |
   |                    | lane.blocks(ref)   |                    |
   |                    |----------------------------------------->|
   |                    | blocks[] over read-only JSON-RPC        |
   |                    |<-----------------------------------------|
   |                    | validate signatures/tip/epoch           |
   |                    | index accepted blocks                   |
   |                    | touch last_seen_at |                    |
   |                    |------------------->|                    |
   | read canon         |                    |                    |
   |<-------------------| projected canon    |                    |
```

Overlay transport is not identity. The current product-grade guard is explicit
local peer trust plus signed-block validation. A signed remote-node challenge is
still a future hardening step before endpoint trust can become key-pinned trust.

## 23 - Sequence: Tmux Frontend

```text
Tmux UI             Daemon              Store/PeerBook
  | subscribe tasks   |                    |
  |------------------>| watch lanes/actors |
  |                   |------------------->|
  |<------------------| TARCH-175/main owned by Claude
  |<------------------| TARCH-175/sdk owned by Codex
  |<------------------| peer workstation active
  | spawn pane actor  |                    |
  |------------------>| register actor     |
  | attach pane lane  |                    |
  |------------------>| claim/observe lane |
  | render dashboard  |                    |
```

tmux is a local dApp UI: it sees nodes, actors, lanes, mempool, peer health, and
active ownership.

## 24 - Migration From Current Continuity

The current system has:

```text
continuity.journal_entries
continuity.canons
markdown projections
```

Migration should produce:

```text
project bootstrap block
task bootstrap block
lane bootstrap block
checkpoint blocks for journal entries
canon_update block for current canon
inventory_update block when broader history is recovered
```

Migration rules:

```text
old task_id -> task_id
default project_id -> configured repo/workspace
default lane_id -> main
entry_timestamp -> block created_at
session_id -> actor_id where available
model_id/source -> actor metadata
canon row -> canon_update projection
```

The migration proof should use this task:

```text
agent-continuity-decentralized-runtime
```

It should be checkpointed with the old system until the new block model can
import it.

## 25 - Product-Grade Requirements

Do not ship this as a throwaway prototype.

Required from the first product-grade implementation:

```text
versioned wire API
versioned block schema
schema migrations
doctor command
backup/export/restore
structured logs
safe local-only default
explicit peer trust
no unauthenticated remote writes
idempotent block ingest
replayable projection derivation
multi-node e2e tests
```

Avoid shortcuts:

```text
no markdown as authority
no direct SDK database writes
no clock-only ownership
no daemon-only in-memory state
no Tailscale-only identity
no unversioned payloads
```

## 26 - Implementation Phases

The phases are shippable increments, not throwaway spikes.

```text
Phase 0: Architecture artifact and current continuity tracking
Phase 1: Provider API and memory provider
Phase 2: block schema and validation contract
Phase 3: local store and projection derivation
Phase 4: Go continuityd local daemon
Phase 5: TypeScript SDK integration with daemon provider
Phase 6: migration from current Postgres continuity
Phase 7: peer sync with static peers
Phase 8: overlay discovery for Tailscale and ZeroTier
Phase 9: tmux dashboard
Phase 10: package/install/update flow
Phase 11: default-runtime lifecycle and compatibility bridge
Phase 12: polished install/uninstall product flow
Phase 13: daemon-backed checkpoint/resume cutover
Phase 14: durable peer trust and cross-machine trusted resume
Phase 15: provider-agnostic signed peer onboarding
```

The first code implementation should not start until the provider API, block
schema, and validation contract are stable enough that SDK and daemon can be
implemented independently.

## 27 - Implementation Status

```text
Phase 0: done
  Architecture artifact, Level 3 HTML render, and current continuity tracking.

Phase 1: done in TypeScript SDK
  src/provider.ts defines the Provider API and MemoryProvider.

Phase 2: done in TypeScript SDK
  src/block.ts defines signed task blocks, canonical JSON, content hashes, and
  Ed25519 signing/verification.
  src/contract.ts defines transition validation for tip, owner, lease_epoch,
  soft lease expiry, and projection replay.

Phase 3: done in TypeScript SDK
  src/local-store.ts defines SQLiteTaskStore and SQLiteProvider.
  The store persists immutable accepted blocks, keeps lane projections for fast
  reads, and can rebuild projections by replaying accepted blocks in sequence.

Phase 4: daemon foundation done in Go
  daemon/cmd/continuityd starts a local Unix-socket JSON-RPC server.
  daemon/internal/continuityd validates signed blocks, persists them in SQLite,
  serves health/status/blocks, accepts block.submit, and rebuilds projections.
  This is the local daemon boundary; TypeScript SDK wiring to it is Phase 5.

Phase 5: TypeScript daemon provider done
  src/daemon-provider.ts defines LocalDaemonProvider and a Unix JSON-RPC client.
  It implements the Provider backend primitives against continuityd:
  health, status, blocks, submitBlock, and projection rebuild.

Phase 6: migration foundation done
  src/migration.ts migrates existing continuity journal/canon history into
  signed task blocks through any Provider backend.
  The Postgres wrapper reads current continuity.journal_entries and canons; the
  pure migrator is tested against MemoryProvider.

Phase 7: static peer sync done
  daemon/internal/continuityd/peer.go implements peer.sync.
  The daemon pulls lane.blocks from explicit trusted unix:// or tcp:// peer
  endpoints and ingests fetched blocks through the normal signed-block
  validation path.
  src/daemon-provider.ts exposes LocalDaemonProvider.syncPeers().

Phase 8: overlay discovery done
  daemon/internal/continuityd/discovery.go discovers candidate Tailscale and
  ZeroTier peer endpoints through local CLI state, but only with explicit
  trustedNames or trustedNodeIds filters.
  daemon/cmd/continuityd supports --peer-listen for a read-only TCP peer
  listener suitable for private overlays such as Tailscale or ZeroTier.
  src/daemon-provider.ts exposes LocalDaemonProvider.discoverPeers().

Phase 9: tmux-friendly dashboard done
  src/dashboard.ts loads a provider snapshot and renders a compact terminal
  dashboard for project/task/lane state, owner, tip, checkpoint, recent blocks,
  discovered peers, and warnings.
  src/cli.ts exposes continuity dashboard as a read-only command over the local
  daemon provider. tmux can run this directly or through watch for refresh.

Phase 10: package/install/update foundation done
  src/daemon-install.ts builds or updates continuityd from packaged Go source,
  reports deterministic install paths, and can render/write a macOS launchd
  plist without loading it implicitly.
  src/cli.ts exposes continuity daemon-install with dry-run, output path, state
  path, socket/db path, launchd, launchd-label, launchd-plist, and peer-listen
  options.
  package.json exposes npm run build:daemon and npm run build:all for explicit
  daemon binary builds.

Phase 11: default-runtime lifecycle and compatibility bridge done
  src/daemon-lifecycle.ts exposes daemon status/start/stop helpers with direct
  background process support and optional launchd control.
  src/cli.ts exposes continuity daemon-status, daemon-start, daemon-stop, and
  daemon-migrate.
  src/setup.ts supports continuity setup --local --daemon, storing the selected
  daemon runtime paths in ~/.config/agent-continuity/config.json while keeping
  PostgreSQL configured for compatibility commands.
  src/signer-store.ts stores durable Ed25519 node key material for migration and
  daemon-backed CLI operations.
  Daemon path resolution falls back to /tmp/continuityd-<hash>.sock when the
  default state-dir socket would exceed Unix socket path limits.

Phase 12: polished install/uninstall product flow done
  continuity install is now the primary product installer. With no --target it
  runs local setup, installs agent integrations, builds continuityd, starts the
  daemon, reports daemon status, optionally migrates a task with --project-id
  and --task-id, and prints doctor checks.
  continuity install --target all|opencode|claude remains the integration-only
  compatibility path.
  continuity uninstall now removes product install artifacts without requiring a
  live database: it stops the daemon, removes launchd plist when configured,
  removes the daemon binary, removes integrations, removes the Docker container,
  and removes config. Data is kept by default; --delete-data is required to
  remove the Docker volume and default daemon state directory.
  Destructive daemon file removal is constrained to managed paths under the
  user's home directory; custom daemon state paths are kept.

Phase 13: daemon-backed checkpoint/resume cutover done
  continuity checkpoint --daemon writes checkpoint/canon state through the
  daemon Provider API as signed task blocks. It can infer project_id from the
  current git remote, accepts explicit --project-id outside git checkouts, and
  uses the configured daemon socket/state paths.
  continuity resume --daemon reads the lane canon projection from continuityd.
  Checkpoint payloads now carry modelId, sessionId, source, and idempotencyKey
  so repeated daemon checkpoint calls do not create duplicate semantic
  checkpoints.
  src/daemon-workflow.ts owns signer selection, idempotency lookup, bootstrap
  and claim-on-first-write, current local owner reuse, checkpoint submission,
  and daemon canon resume.
  src/project.ts owns local project_id inference from git remote.origin.url.
  OpenCode and Claude integration hints now prefer daemon checkpoint/resume and
  name the PostgreSQL path only as compatibility fallback.

Phase 14: durable peer trust and cross-machine trusted resume done
  daemon/internal/continuityd persists trusted_peers in SQLite. The address book
  stores endpoint, optional node/name/publicKey/provider metadata, enabled state,
  timestamps, and last_seen_at.
  daemon/internal/continuityd exposes peer.trustAdd, peer.trustList,
  peer.trustRemove, and peer.syncTrusted JSON-RPC methods. peer.syncTrusted uses
  only enabled trusted peers and accepts an empty address book as a no-op.
  src/daemon-provider.ts exposes trustPeer, listTrustedPeers, removeTrustedPeer,
  and syncTrustedPeers.
  src/cli.ts exposes continuity peer-add, peer-list, peer-remove, peer-sync, and
  peer-discover --add. continuity resume --daemon --sync pulls from trusted peers
  before printing the daemon canon.
  Plain checkpoint/resume without --daemon intentionally remains on the
  PostgreSQL compatibility path for now; installed agent hints use --daemon
  explicitly. The default should flip only after cross-machine trust and recovery
  have been exercised across real machines.

Phase 15: provider-agnostic signed peer onboarding done
  src/peer-onboarding.ts implements signed peer invite URLs, signed rendezvous
  presence files, mDNS/DNS-SD TXT presence, signature validation, explicit trust
  filters for bulk add, and trust-input mapping into the daemon address book.
  src/cli.ts exposes continuity peer-invite-create, peer-invite-accept,
  presence-publish, presence-discover, mdns-advertise, mdns-advertise-status,
  mdns-advertise-stop, and mdns-discover.
  presence-publish and mdns-advertise support --port so a node can bind the
  peer listener to :9987 and publish tcp://<hostname>.local:9987 without a
  fixed overlay IP.
  mdns-advertise --background writes a daemon-state PID file and can be managed
  with status/stop commands, avoiding foreground test sessions for long-running
  local discovery.
  src/sdk.ts exports the onboarding API for agent integrations.
  Provider-specific peer-discover remains available as optional
  Tailscale/ZeroTier convenience, but it is no longer the product's core peer
  onboarding model.

Hardening smoke: temporary daemon lifecycle done
  A temp continuityd process was started from dist/bin/continuityd, this task was
  migrated from PostgreSQL continuity into daemon SQLite through
  LocalDaemonProvider, and continuity dashboard rendered against the daemon.
  Smoke result: 12 journal entries migrated into 15 signed blocks.
  Bugs found and fixed: Go canonical JSON must not HTML-escape canon markdown;
  TypeScript Unix JSON-RPC client must wait for complete newline-delimited
  responses across socket chunks; daemon lifecycle must handle long Unix socket
  paths and report early process exits through stderr.
```

Current test coverage:

```text
test/block.test.ts
  signed block creation
  tamper detection
  canonical hash stability
  kind-specific payload validation

test/provider.test.ts
  bootstrap -> claim -> checkpoint
  active-owner pause
  stale parent_tip rejection
  soft-expiry takeover with lease_epoch advance

test/local-store.test.ts
  SQLite durability across reopen
  duplicate block ingest as idempotent
  projection rebuild from accepted blocks
  stale parent_tip rejection in persistent store

daemon/internal/continuityd/*_test.go
  Go SQLite store append and projection rebuild with real Ed25519 blocks
  JSON-RPC health and empty lane status over a Unix socket
  Tailscale/ZeroTier discovery parsing with explicit trust filters
  trusted peer address-book lifecycle

test/daemon-provider.test.ts
  TypeScript LocalDaemonProvider health/status over Unix JSON-RPC
  signed bootstrap block construction and block.submit transport
  trusted peer sync and address-book JSON-RPC methods

test/daemon-workflow.test.ts
  daemon checkpoint initializes lane and canon
  daemon checkpoint idempotency by task timestamp and session
  daemon checkpoint reuses the current local owner when actor-id is omitted

test/migration.test.ts
  journal entries replayed as ordered checkpoint blocks
  migrated checkpoint blocks preserve idempotency metadata
  final canon imported as canon_update
  existing target lane skipped idempotently

test/project.test.ts
  git remote URL to project_id parsing

test/peer-onboarding.test.ts
  signed peer invite creation and tamper rejection
  rendezvous publish/discover with project and trusted-node filters
  invalid signed presence warnings
  mDNS TXT signed presence round-trip
  dns-sd browse/resolve output parsing
  bulk --add trust filter guard

daemon/internal/continuityd/peer_test.go
  static Unix peer sync imports remote blocks in order
  read-only TCP peer sync imports remote blocks in order
  trusted address-book sync imports remote blocks and updates last_seen_at
  trusted sync with an empty address book is a no-op
  read-only TCP peer listener rejects mutating methods
  repeated sync is idempotent
  divergent lane blocks are reported as per-block rejections

test/daemon-provider.test.ts
  LocalDaemonProvider.syncPeers sends peer.sync over Unix JSON-RPC
  LocalDaemonProvider.syncTrustedPeers sends peer.syncTrusted over Unix JSON-RPC
  LocalDaemonProvider trustPeer/listTrustedPeers/removeTrustedPeer methods
  LocalDaemonProvider.discoverPeers sends peer.discover over Unix JSON-RPC

test/dashboard.test.ts
  provider snapshot loading
  tmux-friendly dashboard rendering with checkpoint, peers, and warnings

test/daemon-install.test.ts
  daemon-install dry-run path planning
  long default socket path fallback under Unix socket limits
  launchd plist rendering and XML escaping

test/install.test.ts
  OpenCode and Claude integration install
  legacy SessionStart hook cleanup
  OpenCode and Claude integration uninstall

test/setup.test.ts
  product uninstall removes config and integrations without database access

test/signer-store.test.ts
  durable node key creation and reuse
  node-id drift rejection for existing key files

daemon/internal/continuityd/canonical_test.go
  canonical JSON preserves HTML-sensitive canon markdown characters

CLI output checks
  continuity dashboard success, warning, and error commands inspected
  continuity daemon-install dry-run, success, and error commands inspected
  continuity daemon-start/status/migrate/stop success and warning paths inspected
  continuity daemon-migrate missing --task-id error path inspected
  continuity peer-add/list/remove/sync/discover help and smoke commands inspected
  continuity peer-invite-create/accept, presence-publish/discover, and
  mdns-advertise/discover success and error paths inspected
  continuity install --target error and install --dry-run guard inspected
  continuity uninstall without database config inspected
  continuity checkpoint --daemon and resume --daemon temp daemon smoke inspected
  continuity resume --daemon --sync two-daemon smoke inspected
  temp daemon lifecycle smoke migrated this task and rendered dashboard output
```

## 28 - Remaining Decisions

These are the decisions still worth double-clicking after the first daemon,
store, migration, static sync, and overlay discovery increments:

```text
actor identity:
  per session key vs daemon-issued actor token

project id:
  explicit configured id vs inferred repo remote

daemon default:
  plain checkpoint/resume still route to PostgreSQL compatibility; flip to
  daemon default after real cross-machine use validates trust/recovery behavior

peer challenge:
  signed node challenge before accepting remote peer identity

HTML docs:
  generated only for local review vs checked into docs

rendezvous backends:
  file directory is implemented; git bare repo, S3/R2 object store, and small
  private HTTPS rendezvous backends are still adapters to design

mDNS runtime:
  CLI DNS-SD integration is implemented; daemon-native advertisement/listening
  can be added if long-running local network discovery becomes important
```

Decisions already made and implemented:

```text
Go daemon
TypeScript SDK
JSON-RPC over Unix socket first
SQLite local store
ed25519 node keys
durable local peer trust registry before shared trust registry
static peers before overlay discovery
optional read-only TCP peer listener for overlays
resume --daemon --sync syncs trusted peers before printing canon
signed peer invites before provider-specific resolvers
signed rendezvous presence
mDNS/DNS-SD local discovery
provider-specific resolvers are optional convenience only
markdown doc in repo, generated HTML outside repo
```
