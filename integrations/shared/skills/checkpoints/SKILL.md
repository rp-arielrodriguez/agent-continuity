---
name: checkpoints
description: Use Agent Continuity for durable orientation, resume, checkpoint, handoff, recovery, delegation, evaluation, and adjudication across agents and machines.
---

# Agent Continuity

Continuity is the durable task authority for long-running agent work. Accepted
`continuityd` blocks and their daemon projections own current task state.
Markdown checkpoint files and vendor memories are context aids, not authority.

## Start With The Executable Contract

Do not infer CLI syntax from memory or search the source tree. Ask the installed
CLI for the current typed contract:

```bash
continuity agent-contract
continuity agent-contract --intent <INTENT>
continuity agent-contract --intent <INTENT> --json
```

`continuity <command> --help` is also safe and must return help without executing
the command.

## Natural Intent Mapping

| User intent | Contract |
|---|---|
| Understand current work or state | `orient` |
| Continue a known task | `resume` |
| Claim available work | `claim` |
| Sync trusted peers | `sync` |
| Save meaningful progress or context | `checkpoint` |
| Preserve exact recovery context | `session` |
| Record an operational blocker | `run-event` |
| Transfer or release work | `handoff` |
| Send explicit work to workers | `delegate` |
| Run competing candidates | `speculate` |
| Publish worker output | `result` |
| Score candidate evidence | `evaluate` |
| Select a winner | `adjudicate` |
| Recover after compaction/restart | `recover` |

The LLM interprets natural language and selects the intent. Continuity validates
identity, ownership, persistence, sync, and scheduler state.

## Project Identity

- Prefer an explicit `--project-id` and `--task-id`.
- Inside a git checkout, project id may be inferred from `remote.origin.url`.
- Outside a checkout, recover exact context with `continuity session-resume --last`
  or ask for the project id.
- Never silently fall back to a task with the same id in another project.

## Recovery And Canon

- Run the `recover` or `resume` contract before relying on markdown or chat.
- The canon is current truth, not a transcript. Keep it short and point to
  versioned repository docs for stable architecture.
- Record operational blockers with `run-event-add`; do not bury auth, disk,
  network, daemon, git, or tool failures only in chat.
- Preserve a session envelope before compaction, handoff, or significant
  autonomous work.

## Checkpoint Semantics

The agent owns the semantic content: current truth, decisions, rejected paths,
and next action. Continuity owns signed persistence and projections.

When current truth changes, checkpoint through the daemon and reconcile the
canon in the same operation. Never edit exported markdown as authority.

If the daemon is unavailable, report that explicitly. Use PostgreSQL/Absurd
compatibility state only as an announced fallback, never silently.

## Agent Coordination

- Orient and inspect ownership before mutating a shared lane.
- Use separate lanes/worktrees for speculative candidates.
- A parent may ask a read-only subagent for findings and a canon delta.
- A delegated worker with its own lane may checkpoint its own durable result.
- Evaluation records evidence; adjudication records the winner.
