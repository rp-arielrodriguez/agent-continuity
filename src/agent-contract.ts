export const AGENT_CONTRACT_VERSION = "1.0.0";

export type AgentIntentKind =
  | "orient"
  | "resume"
  | "checkpoint"
  | "claim"
  | "sync"
  | "session"
  | "run-event"
  | "handoff"
  | "delegate"
  | "speculate"
  | "result"
  | "evaluate"
  | "adjudicate"
  | "recover";

export interface AgentIntentContract {
  version: string;
  intent: AgentIntentKind;
  purpose: string;
  preferredCommand: string;
  requiredContext: string[];
  optionalContext: string[];
  invariants: string[];
  fallback: string;
}

const AUTHORITY_INVARIANT = "Accepted continuityd blocks and daemon projections are task authority.";
const PROJECT_INVARIANT = "Use an explicit project id or infer it from the active git checkout; never silently select another project's task.";
const DAEMON_FALLBACK = "If continuityd is unavailable, report that explicitly before using PostgreSQL/Absurd compatibility state.";

const CONTRACTS: Record<AgentIntentKind, AgentIntentContract> = {
  orient: contract({
    intent: "orient",
    purpose: "Load current task truth, ownership, heads, recovery state, and operational events before acting.",
    preferredCommand: "continuity orient --project-id <PROJECT-ID> --task-id <TASK-ID> --lane-id <LANE-ID> --sync",
    requiredContext: ["projectId", "taskId"],
    optionalContext: ["laneId (default: main)", "actorId", "nodeId"],
    invariants: [AUTHORITY_INVARIANT, PROJECT_INVARIANT, "Orient before mutating a long-running task."],
  }),
  resume: contract({
    intent: "resume",
    purpose: "Continue a known task from its current daemon canon.",
    preferredCommand: "continuity resume --daemon --sync --project-id <PROJECT-ID> --task-id <TASK-ID> --lane-id <LANE-ID>",
    requiredContext: ["projectId", "taskId"],
    optionalContext: ["laneId (default: main)", "sync"],
    invariants: [AUTHORITY_INVARIANT, PROJECT_INVARIANT, "If project context is missing, recover it with `continuity session-resume --last` or ask for it."],
  }),
  checkpoint: contract({
    intent: "checkpoint",
    purpose: "Persist useful progress and reconcile current task truth through the daemon.",
    preferredCommand: "continuity checkpoint --daemon --project-id <PROJECT-ID> --task-id <TASK-ID> --lane-id <LANE-ID> --status <STATUS> --progress <SUMMARY> --next <NEXT> [--canon-file <FILE>]",
    requiredContext: ["projectId", "taskId", "status", "progress", "next"],
    optionalContext: ["laneId (default: main)", "canon-file", "blocking", "files", "sessionId"],
    invariants: [
      AUTHORITY_INVARIANT,
      PROJECT_INVARIANT,
      "The agent owns the semantic summary and reconciled canon; Continuity owns validation, persistence, and projection.",
      "Do not edit markdown checkpoint projections as authority.",
    ],
  }),
  claim: contract({
    intent: "claim",
    purpose: "Claim or initialize an interactive lane after checking current ownership and lease state.",
    preferredCommand: "continuity claim --project-id <PROJECT-ID> --task-id <TASK-ID> --lane-id <LANE-ID> --reason <REASON> [--sync]",
    requiredContext: ["projectId", "taskId", "reason"],
    optionalContext: ["laneId (default: main)", "leaseUntil", "actorId", "nodeId", "sync"],
    invariants: [AUTHORITY_INVARIANT, PROJECT_INVARIANT, "Do not mutate a lane while another actor has a fresh lease."],
  }),
  sync: contract({
    intent: "sync",
    purpose: "Fetch missing blocks for a project/task/lane from enabled trusted peers.",
    preferredCommand: "continuity peer-sync --project-id <PROJECT-ID> --task-id <TASK-ID> --lane-id <LANE-ID>",
    requiredContext: ["projectId", "taskId"],
    optionalContext: ["laneId (default: main)", "trusted peer filters"],
    invariants: [AUTHORITY_INVARIANT, PROJECT_INVARIANT, "Sync accepts only validated blocks from explicitly trusted peers."],
  }),
  session: contract({
    intent: "session",
    purpose: "Persist exact recovery context before compaction, handoff, restart, or significant autonomous work.",
    preferredCommand: "continuity session-start --project-id <PROJECT-ID> --task-id <TASK-ID> --lane-id <LANE-ID> [--session-id <SESSION-ID>] [--cwd <CWD>] [--summary <SUMMARY>]",
    requiredContext: ["projectId", "taskId"],
    optionalContext: ["laneId (default: main)", "sessionId", "cwd", "summary", "relatedProjectIds", "recoveryCommand"],
    invariants: [AUTHORITY_INVARIANT, PROJECT_INVARIANT, "The envelope must contain an exact executable recovery command."],
  }),
  "run-event": contract({
    intent: "run-event",
    purpose: "Persist an operational event that changes how future agents should recover or proceed.",
    preferredCommand: "continuity run-event-add --project-id <PROJECT-ID> --task-id <TASK-ID> --lane-id <LANE-ID> --severity <SEVERITY> --category <CATEGORY> --summary <SUMMARY> [--next <NEXT>] [--needs-verification]",
    requiredContext: ["projectId", "taskId", "summary"],
    optionalContext: ["laneId (default: main)", "severity", "category", "detail", "affects", "next", "needsVerification"],
    invariants: [AUTHORITY_INVARIANT, PROJECT_INVARIANT, "Do not leave auth, disk, network, daemon, git, or tool blockers only in chat."],
  }),
  handoff: contract({
    intent: "handoff",
    purpose: "Release an owned lane or transfer it to another actor without losing durable state.",
    preferredCommand: "continuity handoff --project-id <PROJECT-ID> --task-id <TASK-ID> --lane-id <LANE-ID> [--target-node-id <NODE>] [--target-actor-id <ACTOR>] --reason <REASON>",
    requiredContext: ["projectId", "taskId", "reason"],
    optionalContext: ["laneId (default: main)", "targetNodeId", "targetActorId"],
    invariants: [AUTHORITY_INVARIANT, PROJECT_INVARIANT, "Checkpoint changed truth before releasing ownership."],
  }),
  delegate: contract({
    intent: "delegate",
    purpose: "Submit explicit work to compatible local or trusted-peer scheduler workers.",
    preferredCommand: "continuity scheduler-task-submit --project-id <PROJECT-ID> --task-id <TASK-ID> --title <TITLE> --instructions <INSTRUCTIONS> [--requires-agents <AGENTS>] [--requires-model-families <FAMILIES>] [--requires-tools <TOOLS>]",
    requiredContext: ["projectId", "taskId", "title", "instructions"],
    optionalContext: ["required agents", "model families", "tools", "budget", "deadline", "rubric", "use cases"],
    invariants: [AUTHORITY_INVARIANT, "Work enters the scheduler only through an explicit user or agent-submitted intent.", "Exclusive execution is the default policy."],
  }),
  speculate: contract({
    intent: "speculate",
    purpose: "Run multiple isolated candidates for an explicitly competitive task.",
    preferredCommand: "continuity scheduler-task-submit --project-id <PROJECT-ID> --task-id <TASK-ID> --policy speculative --title <TITLE> --instructions <INSTRUCTIONS> --evaluation-mode agent --evaluation-rubric-json <JSON> --evaluation-use-cases-json <JSON>",
    requiredContext: ["projectId", "taskId", "title", "instructions", "rubric", "useCases"],
    optionalContext: ["required agents", "model families", "tools", "evaluator contract"],
    invariants: [AUTHORITY_INVARIANT, "Speculative competition is opt-in.", "Each candidate works in an isolated lane/worktree and publishes a durable result."],
  }),
  result: contract({
    intent: "result",
    purpose: "Publish a durable worker result for a scheduler assignment.",
    preferredCommand: "continuity scheduler-result --project-id <PROJECT-ID> --task-id <TASK-ID> --intent-block-id <INTENT> [--assignment-block-id <ASSIGNMENT>] --worker-id <WORKER> --status <STATUS> --summary <SUMMARY> [--artifacts <ARTIFACTS>]",
    requiredContext: ["projectId", "taskId", "intentBlockId", "workerId", "status", "summary"],
    optionalContext: ["assignmentBlockId", "artifacts", "exitCode", "tmuxSession"],
    invariants: [AUTHORITY_INVARIANT, "Results reference the originating intent and preserve verifiable artifacts when available."],
  }),
  evaluate: contract({
    intent: "evaluate",
    purpose: "Record rubric scores, use-case evidence, risks, and a recommendation for candidate results.",
    preferredCommand: "continuity scheduler-evaluate --project-id <PROJECT-ID> --task-id <TASK-ID> --intent-block-id <INTENT> --result-block-ids <RESULTS> --summary <SUMMARY> [--recommended-winner-result-block-id <RESULT>]",
    requiredContext: ["projectId", "taskId", "intentBlockId", "resultBlockIds", "summary"],
    optionalContext: ["rubric scores", "use-case evidence", "risks", "confidence", "recommended winner"],
    invariants: [AUTHORITY_INVARIANT, "Evaluation records evidence; it does not silently adjudicate a winner."],
  }),
  adjudicate: contract({
    intent: "adjudicate",
    purpose: "Select a winning result and durably collapse speculative scheduler heads.",
    preferredCommand: "continuity scheduler-adjudicate --project-id <PROJECT-ID> --task-id <TASK-ID> --intent-block-id <INTENT> --result-block-ids <RESULTS> --winner-result-block-id <WINNER> --summary <SUMMARY>",
    requiredContext: ["projectId", "taskId", "intentBlockId", "resultBlockIds", "winnerResultBlockId", "summary"],
    optionalContext: ["evaluationBlockIds"],
    invariants: [AUTHORITY_INVARIANT, "Adjudication must reference the competing results and preserve the decision evidence."],
  }),
  recover: contract({
    intent: "recover",
    purpose: "Recover exact project/task/lane/cwd context after compaction, restart, or handoff.",
    preferredCommand: "continuity session-resume --last",
    requiredContext: [],
    optionalContext: ["known projectId", "known taskId", "known laneId"],
    invariants: [AUTHORITY_INVARIANT, "Execute the returned recovery command exactly.", "Do not reconstruct current task scope from chat or vendor memory when a session envelope exists."],
  }),
};

const COMMAND_INTENTS: Partial<Record<string, AgentIntentKind>> = {
  orient: "orient",
  resume: "resume",
  checkpoint: "checkpoint",
  save: "checkpoint",
  claim: "claim",
  "peer-sync": "sync",
  "session-start": "session",
  "run-event-add": "run-event",
  "run-event-list": "run-event",
  handoff: "handoff",
  "scheduler-task-submit": "delegate",
  "scheduler-result": "result",
  "scheduler-evaluate": "evaluate",
  "scheduler-adjudicate": "adjudicate",
  "session-resume": "recover",
};

export function agentIntentKinds(): AgentIntentKind[] {
  return Object.keys(CONTRACTS) as AgentIntentKind[];
}

export function parseAgentIntentKind(value: string): AgentIntentKind {
  if (value in CONTRACTS) return value as AgentIntentKind;
  throw new Error(`unsupported --intent ${value}; expected ${agentIntentKinds().join(", ")}`);
}

export function agentIntentContract(intent: AgentIntentKind): AgentIntentContract {
  return CONTRACTS[intent];
}

export function allAgentIntentContracts(): AgentIntentContract[] {
  return agentIntentKinds().map(agentIntentContract);
}

export function commandIntentContract(command: string): AgentIntentContract | undefined {
  const intent = COMMAND_INTENTS[command];
  return intent ? agentIntentContract(intent) : undefined;
}

export function renderAgentIntentContract(value: AgentIntentContract): string {
  return [
    `Agent Continuity contract ${value.version}`,
    `intent: ${value.intent}`,
    `purpose: ${value.purpose}`,
    "preferred:",
    `  ${value.preferredCommand}`,
    `required-context: ${value.requiredContext.length > 0 ? value.requiredContext.join(", ") : "none"}`,
    `optional-context: ${value.optionalContext.length > 0 ? value.optionalContext.join(", ") : "none"}`,
    "invariants:",
    ...value.invariants.map((rule) => `- ${rule}`),
    `fallback: ${value.fallback}`,
  ].join("\n");
}

function contract(value: Omit<AgentIntentContract, "version" | "fallback"> & { fallback?: string }): AgentIntentContract {
  return {
    version: AGENT_CONTRACT_VERSION,
    fallback: value.fallback ?? DAEMON_FALLBACK,
    ...value,
  };
}
