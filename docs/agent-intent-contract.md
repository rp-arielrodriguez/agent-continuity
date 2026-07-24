# Agent Intent Contract

Continuity is an agent-native intent/state substrate. LLMs interpret natural
language, but Continuity owns durable state, recovery, ownership, sync, and
execution contracts.

For the personal-use product boundary, authority hierarchy, and memory policy,
see [`personal-product-architecture.md`](personal-product-architecture.md).

## Layer Contract

```text
natural-language user intent
  -> agent semantic interpretation
  -> typed IntentPacket / SessionEnvelope / RunEvent
  -> Continuity daemon validation and signed blocks
  -> scheduler, tmux, peers, and future agents consume the same state
```

Agents should use Continuity as the default safe place for stateful work:

- orient before acting
- sync before trusting local truth
- claim before mutating owned lanes
- checkpoint when current truth changes
- record operational blockers as run events
- preserve a session envelope before compaction, handoff, or long-running work

The executable form of this document is versioned with the installed CLI:

```bash
continuity agent-contract
continuity agent-contract --intent checkpoint
continuity agent-contract --intent checkpoint --json
continuity checkpoint --help
```

Hooks and skills select an intent and query this contract. They must not carry an
independent copy of storage authority or detailed command syntax.

## IntentPacket

An `IntentPacket` is the typed action an agent chooses after interpreting natural
language. It is not the prompt itself.

```json
{
  "kind": "resume",
  "projectId": "rp-arielrodriguez/agent-continuity",
  "taskId": "agent-continuity-decentralized-runtime",
  "laneId": "main",
  "cwd": "/Users/ariel.rodriguez/recarga/repos/agent-continuity",
  "syncMode": "trusted-peers",
  "onAmbiguity": "fail"
}
```

Supported v1 intent kinds:

| Kind | Meaning | Required Continuity behavior |
|---|---|---|
| `orient` | Understand current truth | Resolve project/task/lane, sync when requested, return canon, heads, owner, envelope, and run events |
| `resume` | Continue known work | Require explicit/inferable project id or a valid session envelope |
| `claim` | Take available interactive work | Respect fresh ownership and lease state before mutation |
| `sync` | Refresh trusted distributed state | Fetch and validate only missing blocks from trusted peers |
| `checkpoint` | Persist useful progress | Append checkpoint and reconcile canon when current truth changes |
| `session` | Preserve exact recovery context | Persist project/task/lane/cwd and an executable recovery command |
| `run-event` | Persist an operational event | Keep blockers and verification needs out of ephemeral chat-only state |
| `handoff` | Transfer or release work | Validate ownership and write a durable handoff/release block |
| `delegate` | Route work elsewhere | Use scheduler capabilities and trusted peers |
| `speculate` | Run competing candidates | Keep forked results until evaluation/adjudication |
| `result` | Publish worker output | Reference the originating intent/assignment and durable artifacts |
| `evaluate` | Score outputs | Record rubric/use-case evidence before winner selection |
| `adjudicate` | Select winner | Record decision and collapse scheduler heads |
| `recover` | Rebuild lost context | Load session envelope, canon, journal heads, and run events |

## SessionEnvelope

A `SessionEnvelope` is the durable recovery envelope that survives context
compaction, tool restarts, and cross-agent handoff.

```json
{
  "sessionId": "codex-20260712-001",
  "cwd": "/Users/ariel.rodriguez/recarga/repos/agent-continuity",
  "recoveryCommand": "continuity resume --daemon --project-id rp-arielrodriguez/agent-continuity --task-id agent-continuity-decentralized-runtime --lane-id main",
  "relatedProjectIds": ["recarga/devex"],
  "summary": "Working on strict recovery/intent contracts."
}
```

The lane reference on the signed block supplies the primary `projectId`,
`taskId`, and `laneId`. The payload repeats only process/session context.

Rules:

- recovery commands must be exact, not inferred prose
- if `projectId` cannot be inferred, `resume` must fail loudly or use a valid
  session envelope
- compaction hooks should load or print the latest envelope instead of relying on
  chat memory

## RunEvent

A `RunEvent` captures operational state that affects recovery but should not be
buried in chat history.

```json
{
  "severity": "blocked",
  "category": "auth",
  "summary": "1Password signing unavailable",
  "detail": "git commit could not sign through the configured SSH agent",
  "affects": ["git commit", "git push"],
  "needsVerification": true,
  "next": "Retry after 1Password is unlocked."
}
```

Run events are projected onto `orient`/`resume` state so a future agent can see
auth, disk, network, daemon, git, and tool failures without reconstructing the
session transcript.

## Strict Recovery Invariants

- No meaningful work may remain only in chat memory.
- No daemon-backed orientation may silently fall back to stale compatibility
  state.
- If current truth changes, the checkpoint contract must require canon
  reconciliation.
- Reconciliation must not silently remove an unresolved workstream or a
  previously accepted decision. Omission is not resolution.
- `completed` must be validated against the known workstream inventory or an
  explicit scoped-completion policy.
- If compaction happens, the next agent must recover project id, task id, lane,
  cwd, blockers, and exact recovery command from Continuity.
