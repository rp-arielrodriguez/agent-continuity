# Personal Product Architecture

This document is the source of truth for the personal-use product slice. It
freezes the current architecture decisions so future agents do not expand scope
or re-litigate the product boundary from chat history.

## Product Stop Line

Continuity is finished for personal use when this loop is reliable:

```text
explicit user or agent intent
  -> Continuity resolves project/task/lane/context
  -> scheduler selects capable local or trusted-peer workers
  -> workers run as Codex, Claude, OpenCode, or a future local harness
  -> tmux is the primary operator UI
  -> agents orient, claim, work, checkpoint, hand off, and record run events
  -> results, evaluations, and adjudications are durable signed blocks
  -> another trusted machine can sync and resume without chat memory
```

This is a private local-first product, not a public decentralized network.

## Decisions

- Work enters the scheduler only through explicit user or agent-submitted
  intents. No automatic backlog mining for now.
- tmux is the primary UI for personal use. A web UI is not required for the
  current finish line.
- Speculative competition is opt-in. The default policy is exclusive execution.
- Continuity blocks and daemon projections are task authority.
- Codex/Claude/OpenCode memories are context hints and preference stores, not
  distributed task authority.
- MCP is optional future ergonomics. CLI plus hooks/skills remain the correctness
  path because every coding agent can execute shell commands.

## Layer Model

```text
User language
  -> agent semantic interpretation
    -> IntentPacket / SessionEnvelope / RunEvent
      -> continuity CLI / SDK Provider API
        -> local continuityd
          -> signed task blocks
            -> projections: canon, owner, queue, results, run events
              -> tmux dashboard / agent orient / peer sync
```

The LLM layer interprets natural language. Continuity owns durable coordination.
The scheduler is one consumer of Continuity intents, not a replacement for the
agent-native state substrate.

## Authority Matrix

| Information | Authority | Reason |
|---|---|---|
| Product architecture and product boundary | Repo docs under `docs/` | Versioned, reviewable, shared by all agents |
| Long-running task truth | Daemon accepted blocks and canon projection | Syncable and replayable across machines |
| Current recovery envelope | `session_envelope` block | Exact project/task/lane/cwd/recovery command |
| Operational blockers | `run_event` blocks | Durable across compaction and handoff |
| Personal preferences and stable heuristics | Tool memory files/databases | Useful hints, not task state |
| Agent prompt reminders | Hooks, skills, `AGENTS.md` | Runtime guidance only |
| Markdown checkpoints | Exported projections | Compatibility output, not authority |
| Chat transcript | Non-authoritative | Useful for immediate interaction only |

## Memory Policy

Codex has the `memories` feature enabled locally and stores data under
`~/.codex/memories_1.sqlite`. Claude has project memory files under
`~/.claude/projects/.../memory`. These are useful, but they are not the shared
coordination layer.

Use vendor memories for:

- Ariel's durable preferences.
- Agent behavior feedback.
- Cross-task heuristics.
- Stable personal/project facts that are not task execution state.

Do not use vendor memories for:

- Current task status.
- Ownership or lease state.
- Scheduler queue state.
- Peer sync state.
- Result/evaluation/adjudication state.
- Recovery commands.
- Any fact another machine must replay to continue safely.

If a memory contradicts Continuity, Continuity wins for task state. If a repo doc
contradicts a memory about product architecture, the repo doc wins.

## Context Discipline

Every long-running session should create or refresh a `SessionEnvelope` before
compaction, handoff, or significant autonomous work:

```bash
continuity session-start \
  --project-id rp-arielrodriguez/agent-continuity \
  --task-id agent-continuity-decentralized-runtime \
  --lane-id main \
  --session-id <session-id> \
  --cwd "$PWD" \
  --summary "<current work>"
```

Every meaningful state change should be checkpointed through the daemon:

```bash
continuity checkpoint \
  --daemon \
  --project-id rp-arielrodriguez/agent-continuity \
  --task-id agent-continuity-decentralized-runtime \
  --lane-id main \
  --status in_progress \
  --progress "<what changed>" \
  --next "<one next action>"
```

Operational failures should become run events:

```bash
continuity run-event-add \
  --project-id rp-arielrodriguez/agent-continuity \
  --task-id agent-continuity-decentralized-runtime \
  --lane-id main \
  --severity blocked \
  --category auth \
  --summary "1Password signing unavailable" \
  --needs-verification
```

## Canon Discipline

The canon should stay short and current. It should not become an architecture
book. The canon should point to this document for stable product architecture
and keep only the current truth:

- current completed slice
- current product decisions
- current next action
- rejected paths that a future agent may accidentally re-derive

Architecture details belong in repo docs. Task execution truth belongs in
Continuity blocks and projections.

## Primary Use Cases

### Interactive Continuity

```text
human opens an agent
  -> agent runs orient/resume
  -> agent claims or observes the lane
  -> agent works
  -> agent checkpoints or hands off
```

### Explicit Scheduled Work

```text
human submits intent
  -> scheduler records task_intent
  -> capable worker is selected
  -> worker starts in tmux
  -> result block is written
```

### Opt-In Speculative Competition

```text
human submits speculative intent
  -> multiple compatible workers run in isolated worktrees
  -> each writes a result
  -> evaluator writes task_evaluation
  -> adjudicator writes task_adjudication
```

### Cross-Machine Resume

```text
node A writes blocks
  -> node B discovers/trusts/syncs peer
  -> node B resumes with explicit project id or session envelope
  -> node B continues from daemon truth
```

## Component Boundary

```text
continuityd
  signed block validation, projection derivation, leases, peer sync, durable store

TypeScript SDK / CLI
  provider contract, command UX, agent-facing stable API

scheduler
  task intents, worker matching, assignment, budgets, result/evaluation/adjudication

runner adapters
  Codex, Claude, OpenCode, future local harness

tmux frontend
  worker lifecycle, attach, tail, local operator dashboard

agent integrations
  hooks/skills/reminders that make the CLI protocol natural

memories
  optional personal hints and cross-task preferences
```

Lower layers must not depend on higher-level workflow concerns. `continuityd`
does not know how to prompt Codex or Claude. Runner adapters do not own task
truth. tmux does not own distributed state.

## Personal Product Finish Checklist

- Fresh install works on a clean machine.
- Update and uninstall are idempotent.
- Daemon starts, restarts, and reports useful doctor output.
- Codex, Claude, and OpenCode integrations all orient through Continuity.
- `session_envelope` and `run_event` recovery are visible in orient/resume.
- tmux worker start/status/attach/stop is the primary UI.
- Explicit intent submission launches capable workers.
- Exclusive tasks run once.
- Speculative tasks run only when requested and produce adjudicable results.
- Two trusted physical machines can discover, sync, hand off, and resume.
- Container cluster tests cover install, discovery, sync, workers, and scheduler.
- Real-agent tests exercise Codex, Claude, OpenCode, and competition.
- The canon points at this architecture doc instead of embedding architecture
  detail.

Anything outside this checklist is roadmap, not required for the personal-use
finish line.
