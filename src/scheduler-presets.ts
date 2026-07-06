import type { WorkerProfilePayload } from "./block.js";
import type { SchedulerRunner } from "./scheduler.js";

export type SchedulerWorkerPresetName = "codex" | "claude" | "opencode";

export interface SchedulerWorkerPreset {
  name: SchedulerWorkerPresetName;
  worker: Pick<WorkerProfilePayload, "agent"> & Partial<WorkerProfilePayload>;
  runner: SchedulerRunner;
  command: string;
}

export interface ResolveSchedulerWorkerInput {
  preset?: SchedulerWorkerPresetName;
  nodeId?: string;
  workerId?: string;
  agent?: string;
  modelFamilies?: string[];
  models?: string[];
  tools?: string[];
  maxConcurrent?: number;
  tmuxSession?: string;
  endpoint?: string;
  enabled?: boolean;
}

const PRESETS: Record<SchedulerWorkerPresetName, SchedulerWorkerPreset> = {
  codex: {
    name: "codex",
    worker: {
      agent: "codex",
      modelFamilies: ["gpt"],
      tools: ["shell", "git"],
    },
    runner: "tmux",
    command: 'codex exec "$CONTINUITY_TASK_INSTRUCTIONS"',
  },
  claude: {
    name: "claude",
    worker: {
      agent: "claude",
      modelFamilies: ["anthropic"],
      tools: ["shell", "git"],
    },
    runner: "tmux",
    command: 'claude -p "$CONTINUITY_TASK_INSTRUCTIONS"',
  },
  opencode: {
    name: "opencode",
    worker: {
      agent: "opencode",
      modelFamilies: ["gpt", "anthropic", "local"],
      tools: ["shell", "git", "browser"],
    },
    runner: "tmux",
    command: 'opencode run "$CONTINUITY_TASK_INSTRUCTIONS"',
  },
};

export function schedulerWorkerPreset(name: SchedulerWorkerPresetName): SchedulerWorkerPreset {
  return PRESETS[name];
}

export function schedulerWorkerPresetNames(): SchedulerWorkerPresetName[] {
  return Object.keys(PRESETS) as SchedulerWorkerPresetName[];
}

export function parseSchedulerWorkerPreset(value: string | undefined): SchedulerWorkerPresetName | undefined {
  if (value === undefined) return undefined;
  if (value === "codex" || value === "claude" || value === "opencode") return value;
  throw new Error(`unsupported --preset ${value}; expected ${schedulerWorkerPresetNames().join(", ")}`);
}

export function resolveSchedulerWorkerProfile(input: ResolveSchedulerWorkerInput): WorkerProfilePayload {
  const preset = input.preset ? schedulerWorkerPreset(input.preset) : undefined;
  const agent = input.agent ?? preset?.worker.agent;
  if (!agent) throw new Error("missing required option --agent or --preset");

  const workerId = input.workerId ?? (input.preset && input.nodeId ? `${input.nodeId}-${input.preset}` : undefined);
  if (!workerId) throw new Error("missing required option --worker-id; with --preset it can be inferred from --node-id");

  return {
    workerId,
    agent,
    modelFamilies: input.modelFamilies ?? preset?.worker.modelFamilies,
    models: input.models ?? preset?.worker.models,
    tools: input.tools ?? preset?.worker.tools,
    maxConcurrent: input.maxConcurrent ?? preset?.worker.maxConcurrent,
    tmuxSession: input.tmuxSession ?? preset?.worker.tmuxSession,
    endpoint: input.endpoint ?? preset?.worker.endpoint,
    enabled: input.enabled ?? preset?.worker.enabled ?? true,
  };
}
