# Product Feature Matrix

This is the combined scope for the personal Continuity product. Coordination is
one part of this scope. It does not replace task tracking, recovery, execution,
or feature synthesis. Beads feature parity means the required user behaviors
below, not every Beads command or future upstream feature.

## Review Baseline

- Continuity: `79e6450417f81b0be870315bbf43faa2e7ad73eb`, matching GitHub main and the clean local checkout at review time.
- Beads: `a690b0a8c4d1ddc4f0bd9bf767499625dd71bc96`, inspected in the preceding source review. No Beads deployment was tested.
- Evidence paths in the matrix identify code or existing tests. They are not a claim that live acceptance passed in this review.
- `Present` means code exists. `Partial` means the required behavior has gaps. `Missing` means the required contract is not implemented. `Unverified` means this review cannot establish parity.

## Consistency Rules

- **Local atomic:** related writes succeed or fail together in one local authority.
- **Eventual:** nodes can accept independent evidence offline and exchange it later. Conflicts remain visible.
- **Ordered:** one configured authority, or a quorum protocol, orders decisions for a task. A node without access cannot make a new authoritative decision.
- **Version-bound:** evidence and decisions reference the model version and code revision they assessed. A change can invalidate earlier approval.

User-approved behavior: strict exclusive work requires ordered authorization;
speculative work may run on disconnected nodes and reconcile later. Authority
versus quorum, failover, and storage engine selection remain design choices.

An exclusive grant alone cannot stop an old process or undo external effects.
Consumers must reject stale ownership tokens (fencing). Where a tool cannot do
that, use one controlled execution path and do not transfer ownership until the
old execution is confirmed stopped. Record the limit explicitly. Exactly-once
external effects additionally require idempotency or transactional support.

## Shared Task And Memory Features

| ID | Required behavior | Continuity baseline and evidence | Beads comparison | Required consistency | Build or reuse option |
|---|---|---|---|---|---|
| F01 | Projects, tasks, children, stable item IDs | Partial: project/task/lane refs in `src/block.ts`; no general child-task graph | Issues and hierarchy documented [B1] | Local atomic; eventual exchange | Candidate for Beads reuse; preserve project identity |
| F02 | Dependencies and ready-work queries | Partial: scheduler selects runnable intents; no general issue dependency model in `src/scheduler.ts` | Dependency graph and `bd ready` [B1] | Eventual discovery; recheck at ordered execution grant | Candidate for Beads reuse |
| F03 | Follow-ups, risks, issues, and verification survive summaries | Missing: `inventoryMarkdown` in `src/block.ts` | Separate issues can represent work; semantic coverage not established | Local atomic lifecycle; eventual evidence; version-bound closure | Reuse issue records if suitable; add coverage rules |
| F04 | Claim, release, recover abandoned work | Partial: lane ownership exists; `signerForStatus` can reuse another local actor ID | Transactional claim and conflict checks [B2] | Local atomic; ordered for strict exclusive work | Compare claim APIs; fix local identity regardless of backend |
| F05 | Refuse closure with open required work | Missing structured closure gate | Checked close checks open children and live direct blockers; force can bypass policy [B3] | Ordered and version-bound | Candidate for reuse; constrain bypass and verification policy |
| F06 | Inspect history, reasons, and supersession | Partial: signed blocks and reconcile payloads in `src/block.ts`; semantic item lineage missing | Audit trail and graph relations documented [B1] | Eventual immutable evidence; explicit corrections | Keep ledger or map to versioned records; select one authority |
| F07 | Agent command discovery and integration | Present: `src/agent-contract.ts`, `src/install.ts`; natural use needs live acceptance | `bd prime`, setup, JSON output [B1] | Local version compatibility | Compare adapter reuse; retain all three target agents |
| F08 | Persistent project knowledge and context | Partial: canon, session envelopes, run events; known E-CANON-001 losses | Persistent memory commands documented [B1] | Eventual; distinguish preferences from task truth | Reuse only with explicit authority boundaries |
| F09 | Search and inspect scoped work | Partial: lane inventory/dashboard; general issue search parity unverified | Issue inspection and ready queries [B1] | Eventual reads expose scope and freshness | Evaluate Beads query coverage |

## Distributed Storage And Operations

| ID | Required behavior | Continuity baseline and evidence | Beads comparison | Required consistency | Build or reuse option |
|---|---|---|---|---|---|
| F10 | Sync between independently configured machines | Present custom peer sync; `test/e2e/multi-daemon.test.ts` | Dolt push/pull and federation [B4, B5] | Eventual; no global exclusivity implied | Retain custom transport or assess Dolt; neither selected |
| F11 | Discover and trust peers without fixed IPs or root commands | Present mDNS/rendezvous paths; `docs/acceptance-matrix.md` | Configured federation peers [B5]; equivalent discovery unverified | Eventual discovery; explicit trust | Likely retain Continuity discovery adapter |
| F12 | Preserve conflicting offline work | Partial: scheduler result forks supported; general task-edit conflicts need policy | Dolt versioning; task conflict semantics need live tests [B4, B5] | Eventual evidence; ordered final selection | Compare conflict preservation and resolution |
| F13 | Delta sync, blobs, snapshots, retention, restore | Present mechanisms; `AC-SYNC-*`, `AC-STORAGE-*`; complete recovery evidence pending | Storage/versioning exists; parity with these policies unverified | Eventual content; validate references and retained evidence | Benchmark both; preserve audit and restore requirements |
| F14 | Install, update, uninstall, schema compatibility | Present installer code/tests; clean cluster acceptance pending | Install/setup and schema guard documented [B1] | Local atomic or recoverable migration | Assess packaging cost, including Dolt dependencies |
| F15 | Migrate existing tasks and preserve recovery | Partial: compatibility migration in `src/migration.ts`; alternative backend migration missing | Import/export is not identical to durable sync [B4] | Verified source snapshot; deterministic ID mapping | Required for any backend change; no automatic dual writes |

## Continuity Execution And Product Requirements

| ID | Required behavior | Continuity baseline and evidence | Beads comparison | Required consistency | Build or reuse option |
|---|---|---|---|---|---|
| F16 | Resume exact project/task/lane/cwd after restart | Partial: session envelopes exist; ambiguous latest-session selection requires evaluation | Equivalent envelope not established | Local session identity; eventual referenced state | Retain/adapt Continuity recovery |
| F17 | Versioned feature model with complete active scope | Missing; `docs/design-evidence.md` | Semantic guarantee not established | Version-bound; ordered accepted model; offline proposals allowed | Continuity domain logic over selected task store |
| F18 | Impact matrix before implementation | Missing; architecture only | Not established | Version-bound to feature model and proposed change | Continuity domain logic |
| F19 | Merge/completion checks after reviews and merges | Missing semantic delivery gate | Structural issue closure is useful but insufficient [B3] | Ordered decision; version-bound verification | Compose structural closure with evidence checks |
| F20 | Interactive and scheduled agents share state tools | Partial: CLI/harness/worker loops exist; complete natural-language scenarios unverified | Agent task interface overlaps [B1] | Local sessions; eventual evidence; ordered writes where required | Shared interface over selected authority |
| F21 | Route explicit work to capable agents/models/tools | Present matching/presets in `src/scheduler.ts`; complete workflow partial | Equivalent execution routing not established | Eventual capability discovery; validate at dispatch | Retain Continuity runner and routing code where correct |
| F22 | Strict exclusive execution across machines | Missing partition-safe authorization; current post-sync avoidance is weaker | Database claim alone does not prove cross-replica exclusivity [B2, B5] | Ordered grant, fencing, safe transfer; wait during partition | Build coordination using proven authority/consensus components |
| F23 | Offline speculative candidates with isolated work | Partial: forks/worktrees/results exist; full live matrix pending | Equivalent result competition not established | Eventual candidate evidence; no shared irreversible effects | Retain and validate Continuity execution policy |
| F24 | Evaluate quality/UX evidence and select a result | Partial: rubric/evaluation/adjudication blocks exist | Equivalent evaluator contract not established | Eventual evaluations; ordered, version-bound adjudication | Retain domain contract; enforce decision authority |
| F25 | Observe, attach, stop, and recover workers with tmux | Present lifecycle code/tests; full operator workflow partial | Equivalent worker frontend not established | Local process state; publish status with freshness | Retain tmux frontend and runner adapters |
| F26 | Multi-agent planning, delegation, and result collection | Partial: submit/worker/result primitives; full orchestrator use cases unverified | Dependency graph can support planning [B1]; orchestration parity unverified | Eventual planning evidence; ordered dispatch when exclusive | Compose graph with Continuity orchestration |

Local/open-source inference remains future scope. The model must allow it, but
the personal release does not require a new local inference harness.

## Implementation Choices Still Open

| Option | Benefit | Cost and decision test |
|---|---|---|
| Keep ledger and build structured task model | Keeps existing signed-event and peer contracts | Own dependency, lifecycle, conflict, migration, and closure logic; must pass all failure replays |
| Use Beads for task state with Continuity execution/feature logic | Reuses issue graph, lifecycle operations, and agent interface | Prove API fit, offline conflict behavior, evidence retention, migration, and coordination integration |
| Use Dolt directly under Continuity | Reuses database versioning and merge machinery | Still build task semantics; prove operational cost and signed-evidence requirements |

No option is selected. Do not maintain two independent authorities for task
status or ownership. If Beads owns tasks, Continuity projections reference Beads
identities and versions. Execution ownership still needs one authoritative grant
protocol. If the ledger owns tasks, any Beads view must be explicitly derived.

## Acceptance Before Selection

1. Replay all E-CANON-001 incidents: omitted scope, false completion, lost post-merge follow-ups, and incomplete Repo #22652 verification. Missing requirements must remain visible or block publication.
2. Race two local actors. Neither may silently adopt the other's identity. Race two replicas while disconnected: strict work must wait without authority; speculative work must retain both results.
3. Crash an owner and attempt takeover. Prove stale tokens cannot write accepted results or protected external effects. State tool-specific limits.
4. Resume on a clean second machine through discovery. Verify exact project scope, evidence references, unresolved items, and recovery command.
5. Run real Codex, Claude, and OpenCode work through interactive and scheduled paths, including delegation, evaluation, tmux attach, cancellation, and result collection.
6. Compare representative small/large datasets for install cost, disk, memory, sync volume, conflict recovery, and backup restoration. No performance winner is assumed.

These are required experiments, not completed tests. Existing test references
remain in [the acceptance matrix](acceptance-matrix.md). The first evaluation
should compare the task-state options against the same fixtures before a storage
or migration commitment.

## Sources

- B1: [Beads README](https://github.com/gastownhall/beads/blob/a690b0a8c4d1ddc4f0bd9bf767499625dd71bc96/README.md).
- B2: [Beads claim implementation](https://github.com/gastownhall/beads/blob/a690b0a8c4d1ddc4f0bd9bf767499625dd71bc96/internal/storage/issueops/claim.go).
- B3: [Beads checked close implementation](https://github.com/gastownhall/beads/blob/a690b0a8c4d1ddc4f0bd9bf767499625dd71bc96/internal/storage/issueops/close.go).
- B4: [Beads sync concepts](https://github.com/gastownhall/beads/blob/a690b0a8c4d1ddc4f0bd9bf767499625dd71bc96/docs/core-concepts/sync-concepts.md).
- B5: [Beads federation](https://github.com/gastownhall/beads/blob/a690b0a8c4d1ddc4f0bd9bf767499625dd71bc96/docs/multi-agent/federation.md).

Open questions: task-state backend; authority versus quorum; safe authority
failover; external-tool fencing limits. These choices do not remove any feature
from this matrix.
