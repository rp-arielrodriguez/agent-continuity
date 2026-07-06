# Scheduler Product Model

Continuity should support both interactive agent continuity and automatic
scheduling. The same signed task history must serve both modes.

## Two Usage Modes

```text
interactive mode
  human starts Codex, Claude, or OpenCode
  agent uses continuity resume/checkpoint/sync
  human decides who works on what

scheduled mode
  scheduler receives task intents
  scheduler claims tasks, launches workers, and monitors checkpoints
  human can observe or attach to sessions
```

The scheduler is a layer above `continuityd`. `continuityd` owns signed blocks,
peer sync, trust, leases, and projections. The scheduler owns task assignment and
local runner supervision.

Current implementation:

- `continuity scheduler-task-submit` writes signed task intents.
- `continuity scheduler-worker-loop` continuously syncs, matches, assigns, runs,
  and publishes results for one worker profile.
- `continuity scheduler-worker-start/status/attach/stop` run that loop in tmux
  as a local operator frontend.
- `--preset codex|claude|opencode` provides agent/model/tool/command defaults
  while allowing explicit overrides.
- `--allowed-project-ids`, `--allowed-commands`, `--max-runner-timeout-ms`, and
  `--worktree-root` provide local safety boundaries for scheduled execution.
- `continuity scheduler-adjudicate` records result selection and collapses
  forked scheduler heads after speculative competition.

## Agent, Model, And Tool Capabilities

Do not model an agent as if it were a model. Agents are harnesses. Models are
provider-backed or local inference capabilities. Tools are interfaces exposed by
the harness.

```yaml
workers:
  - id: codex-main
    agent: codex
    modelFamilies: [openai]
    models: [gpt-5]
    tools: [shell, git]
    maxConcurrent: 2

  - id: claude-deep
    agent: claude
    modelFamilies: [anthropic]
    models: [sonnet, opus]
    tools: [shell, git]
    maxConcurrent: 1

  - id: opencode-router
    agent: opencode
    modelFamilies: [openai, anthropic, local]
    tools: [shell, git, browser]
    maxConcurrent: 3

  - id: local-qwen
    agent: local-harness
    modelFamilies: [local]
    models: [qwen-coder]
    tools: [shell, git]
    enabled: false
```

`tools: [shell, git, browser]` means the task requires those harness
capabilities. It does not mean the model is trained to use those tools, and it
does not imply a provider. A browser-capable OpenCode worker may be eligible for
a task that a shell-only Codex runner should not receive.

## Task Intent

```yaml
taskIntent:
  project: rp-arielrodriguez/agent-continuity
  task: agent-continuity-decentralized-runtime
  policy: exclusive
  requires:
    modelFamilies: [openai]
    tools: [shell, git]
    autonomy: high
  limits:
    maxRuntime: 2h
    maxCostUsd: 20
  isolation:
    worktree: required
    secrets: project-default
```

The scheduler should only launch a worker when the worker satisfies the task
requirements and the local node is allowed to execute that project.

## Execution Policies

```text
exclusive
  one fresh claim wins
  other nodes observe and do not start local work
  stale claims can be reclaimed through lease rules

speculative
  multiple workers may run in isolated lanes and assignment-specific worktrees
  each result is a candidate
  an evaluator or human chooses the winner
```

The default should be `exclusive`. Speculative execution is useful, but it must
be explicit because coding tasks have side effects.

Speculative execution uses fork-aware scheduler heads. If two workers sync the
same task intent and then run offline, each worker can publish a result branch
from the same parent. Peer sync accepts both branches as current heads instead
of rejecting the second result as stale. A later `task_adjudication` block records
the candidate result ids, the optional winning result id, and the selection
summary. When adjudication is written with all current heads as parents, the
lane collapses back to one head while preserving every candidate result block.

Owned checkpoint/canon lanes remain stricter: they still extend current heads and
use leases to avoid accidental parallel writes. Forking is intentional scheduler
behavior, not a blanket rule for all continuity state.

## tmux Role

tmux is a local operator frontend, not distributed state.

```text
scheduler
  starts Codex/Claude/OpenCode in tmux sessions

continuity dashboard
  lists workers, tasks, claims, checkpoints, and sessions

continuity scheduler-worker-attach <worker-or-task>
  attaches to the underlying tmux session
```

Continuity blocks remain the distributed source of truth. tmux is how a human
sees or intervenes in a local runner.

Worker loops expose task context to runner commands through environment
variables rather than command-string interpolation:

```text
CONTINUITY_PROJECT_ID
CONTINUITY_TASK_ID
CONTINUITY_LANE_ID
CONTINUITY_INTENT_BLOCK_ID
CONTINUITY_TASK_TITLE
CONTINUITY_TASK_INSTRUCTIONS
CONTINUITY_WORKER_ID
CONTINUITY_AGENT
CONTINUITY_MODEL_FAMILIES
CONTINUITY_MODELS
CONTINUITY_TOOLS
```

That allows stable runner commands such as:

```bash
codex exec "$CONTINUITY_TASK_INSTRUCTIONS"
claude -p "$CONTINUITY_TASK_INSTRUCTIONS"
opencode run "$CONTINUITY_TASK_INSTRUCTIONS"
```

Preset commands use that convention by default:

```text
codex    -> codex exec "$CONTINUITY_TASK_INSTRUCTIONS"
claude   -> claude -p "$CONTINUITY_TASK_INSTRUCTIONS"
opencode -> opencode run "$CONTINUITY_TASK_INSTRUCTIONS"
```

Workers should normally be started with explicit local constraints:

```bash
continuity scheduler-worker-start \
  --project-id rp-arielrodriguez/agent-continuity \
  --task-id agent-continuity-decentralized-runtime \
  --preset codex \
  --sync \
  --allowed-project-ids rp-arielrodriguez/agent-continuity \
  --allowed-commands codex \
  --max-runner-timeout-ms 3600000 \
  --worktree-root ~/.local/state/agent-continuity/worktrees
```

## Native-Feeling Agent Interface

Models will not be trained on this local harness by default. The product should
make Continuity feel native through a small repeated protocol:

```text
session starts
  continuity resume --daemon --sync --project-id ... --task-id ...

meaningful progress
  continuity checkpoint --daemon --task-id ... --status in_progress ...

blocked or complete
  continuity checkpoint --daemon --task-id ... --status blocked|completed ...
```

CLI is the universal substrate because every coding agent can execute shell
commands. Skills and hooks make that CLI protocol natural for each agent.
MCP can be added later only where it provides a better client experience; it
should not be required for core correctness.

## Safety Rules

- Accept task intents only from trusted issuers.
- Route only approved projects on each node.
- Never execute arbitrary shell payloads from peers by default.
- Prefer isolated assignment-specific worktrees for scheduled tasks.
- Keep secrets scoped by project and worker.
- Enforce runtime and cost budgets before launching workers.
- Checkpoint scheduler decisions as signed events.

## Product Boundary

```text
continuityd
  signed blocks, projections, peer sync, trust, leases

scheduler
  task intents, claims, worker selection, budgets

runner adapters
  Codex, Claude, OpenCode, local harness

tmux frontend
  observe, attach, intervene
```

The scheduler should be built on top of Continuity, not mixed into every agent
adapter.
