import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type {
  BootstrapPayload,
  ContinuitySigner,
  LaneRef,
  TaskAssignmentPayload,
  TaskBlock,
  TaskBlockKind,
  TaskBlockPayload,
  TaskIntentPayload,
  TaskResultPayload,
  WorkerProfilePayload,
} from "./block.js";
import { createSignedTaskBlock } from "./block.js";
import type { ContinuityProvider, ProviderSubmitResult } from "./provider.js";

const DEFAULT_ASSIGNMENT_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_RUNNER_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_LIMIT = 8_000;

export type SchedulerBlockKind = "task_intent" | "worker_profile" | "task_assignment" | "task_result";
export type SchedulerRunner = "fake" | "command" | "tmux";
export type SchedulerIntentStatus = "pending" | "assigned" | "completed" | "failed" | "blocked" | "cancelled";

export interface SchedulerWorker {
  blockId: string;
  createdAt: string;
  nodeId: string;
  actorId: string;
  payload: WorkerProfilePayload;
}

export interface SchedulerIntent {
  blockId: string;
  createdAt: string;
  nodeId: string;
  actorId: string;
  payload: TaskIntentPayload;
  status: SchedulerIntentStatus;
  assignments: SchedulerAssignment[];
  results: SchedulerResult[];
  latestResult?: SchedulerResult;
}

export interface SchedulerAssignment {
  blockId: string;
  createdAt: string;
  nodeId: string;
  actorId: string;
  payload: TaskAssignmentPayload;
}

export interface SchedulerResult {
  blockId: string;
  createdAt: string;
  nodeId: string;
  actorId: string;
  payload: TaskResultPayload;
}

export interface SchedulerState extends LaneRef {
  tip?: string;
  workers: SchedulerWorker[];
  intents: SchedulerIntent[];
  assignments: SchedulerAssignment[];
  results: SchedulerResult[];
  counts: Record<SchedulerIntentStatus, number>;
}

export interface SchedulerSubmitInput<TPayload extends TaskBlockPayload> extends LaneRef {
  provider: ContinuityProvider;
  signer: ContinuitySigner;
  kind: SchedulerBlockKind;
  payload: TPayload;
  createdAt?: string;
}

export interface SchedulerRunOnceInput extends LaneRef {
  provider: ContinuityProvider;
  signer: ContinuitySigner;
  worker: WorkerProfilePayload;
  runner?: SchedulerRunner;
  command?: string;
  tmuxSession?: string;
  keepTmuxSession?: boolean;
  runnerTimeoutMs?: number;
  now?: string;
  leaseMs?: number;
}

export interface SchedulerRunOnceResult extends LaneRef {
  status: "idle" | "completed" | "failed" | "blocked" | "cancelled";
  workerId: string;
  intent?: SchedulerIntent;
  workerBlock?: TaskBlock<WorkerProfilePayload>;
  assignmentBlock?: TaskBlock<TaskAssignmentPayload>;
  resultBlock?: TaskBlock<TaskResultPayload>;
  summary: string;
}

interface RunnerOutcome {
  status: TaskResultPayload["status"];
  summary: string;
  artifacts?: string[];
  exitCode?: number;
  tmuxSession?: string;
}

export async function loadSchedulerState(provider: ContinuityProvider, ref: LaneRef): Promise<SchedulerState> {
  const [status, blocks] = await Promise.all([provider.status(ref), provider.blocks(ref)]);
  return deriveSchedulerState(ref, blocks, status.lane.tip);
}

export function deriveSchedulerState(ref: LaneRef, blocks: TaskBlock[], tip?: string): SchedulerState {
  const workerById = new Map<string, SchedulerWorker>();
  const rawIntents: SchedulerIntent[] = [];
  const assignments: SchedulerAssignment[] = [];
  const results: SchedulerResult[] = [];

  for (const block of blocks) {
    if (block.kind === "worker_profile") {
      const worker: SchedulerWorker = {
        blockId: block.blockId,
        createdAt: block.createdAt,
        nodeId: block.nodeId,
        actorId: block.actorId,
        payload: block.payload as WorkerProfilePayload,
      };
      workerById.set(worker.payload.workerId, worker);
    } else if (block.kind === "task_intent") {
      rawIntents.push({
        blockId: block.blockId,
        createdAt: block.createdAt,
        nodeId: block.nodeId,
        actorId: block.actorId,
        payload: block.payload as TaskIntentPayload,
        status: "pending",
        assignments: [],
        results: [],
      });
    } else if (block.kind === "task_assignment") {
      assignments.push({
        blockId: block.blockId,
        createdAt: block.createdAt,
        nodeId: block.nodeId,
        actorId: block.actorId,
        payload: block.payload as TaskAssignmentPayload,
      });
    } else if (block.kind === "task_result") {
      results.push({
        blockId: block.blockId,
        createdAt: block.createdAt,
        nodeId: block.nodeId,
        actorId: block.actorId,
        payload: block.payload as TaskResultPayload,
      });
    }
  }

  const assignmentsByIntent = groupBy(assignments, (assignment) => assignment.payload.intentBlockId);
  const resultsByIntent = groupBy(results, (result) => result.payload.intentBlockId);
  const intents = rawIntents.map((intent) => {
    const intentAssignments = assignmentsByIntent.get(intent.blockId) ?? [];
    const intentResults = resultsByIntent.get(intent.blockId) ?? [];
    const latestResult = intentResults.at(-1);
    const status: SchedulerIntentStatus = latestResult?.payload.status ?? (intentAssignments.length > 0 ? "assigned" : "pending");
    return {
      ...intent,
      status,
      assignments: intentAssignments,
      results: intentResults,
      latestResult,
    };
  });
  const counts = {
    pending: 0,
    assigned: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
  } satisfies Record<SchedulerIntentStatus, number>;
  for (const intent of intents) counts[intent.status] += 1;

  return {
    ...ref,
    tip,
    workers: [...workerById.values()],
    intents,
    assignments,
    results,
    counts,
  };
}

export async function registerWorkerProfile(input: Omit<SchedulerSubmitInput<WorkerProfilePayload>, "kind">): Promise<TaskBlock<WorkerProfilePayload>> {
  return appendSchedulerBlock({ ...input, kind: "worker_profile" });
}

export async function submitTaskIntent(input: Omit<SchedulerSubmitInput<TaskIntentPayload>, "kind">): Promise<TaskBlock<TaskIntentPayload>> {
  return appendSchedulerBlock({ ...input, kind: "task_intent" });
}

export async function submitTaskAssignment(input: Omit<SchedulerSubmitInput<TaskAssignmentPayload>, "kind">): Promise<TaskBlock<TaskAssignmentPayload>> {
  return appendSchedulerBlock({ ...input, kind: "task_assignment" });
}

export async function submitTaskResult(input: Omit<SchedulerSubmitInput<TaskResultPayload>, "kind">): Promise<TaskBlock<TaskResultPayload>> {
  return appendSchedulerBlock({ ...input, kind: "task_result" });
}

export async function runSchedulerOnce(input: SchedulerRunOnceInput): Promise<SchedulerRunOnceResult> {
  const ref = laneRef(input);
  const createdAt = input.now ?? new Date().toISOString();
  const beforeRegistration = await loadSchedulerState(input.provider, ref);
  const currentWorker = beforeRegistration.workers.find((worker) => worker.payload.workerId === input.worker.workerId);
  const workerBlock = workerProfileMatches(currentWorker?.payload, input.worker)
    ? undefined
    : await registerWorkerProfile({ ...ref, provider: input.provider, signer: input.signer, createdAt, payload: input.worker });
  const state = workerBlock ? await loadSchedulerState(input.provider, ref) : beforeRegistration;
  const selected = selectRunnableIntent(state, input.worker, createdAt);
  if (!selected) {
    return {
      ...ref,
      status: "idle",
      workerId: input.worker.workerId,
      workerBlock,
      summary: `no runnable task for worker ${input.worker.workerId}`,
    };
  }

  const assignmentBlock = await submitTaskAssignment({
    ...ref,
    provider: input.provider,
    signer: input.signer,
    createdAt,
    payload: {
      intentBlockId: selected.blockId,
      workerId: input.worker.workerId,
      assignedLaneId: selected.payload.targetLaneId ?? input.worker.workerId,
      mode: "automatic",
      leaseUntil: new Date(timestampMs(createdAt) + (input.leaseMs ?? DEFAULT_ASSIGNMENT_LEASE_MS)).toISOString(),
    },
  });

  const startedAt = new Date().toISOString();
  const outcome = await runWorker(input.runner ?? "fake", {
    command: input.command,
    tmuxSession: input.tmuxSession ?? input.worker.tmuxSession,
    keepTmuxSession: input.keepTmuxSession,
    timeoutMs: input.runnerTimeoutMs ?? DEFAULT_RUNNER_TIMEOUT_MS,
    intent: selected,
    worker: input.worker,
  }).catch((error: unknown): RunnerOutcome => ({
    status: "failed",
    summary: `runner failed before producing output: ${error instanceof Error ? error.message : String(error)}`,
  }));
  const completedAt = new Date().toISOString();
  const resultBlock = await submitTaskResult({
    ...ref,
    provider: input.provider,
    signer: input.signer,
    payload: {
      intentBlockId: selected.blockId,
      assignmentBlockId: assignmentBlock.blockId,
      workerId: input.worker.workerId,
      status: outcome.status,
      summary: outcome.summary,
      artifacts: outcome.artifacts,
      exitCode: outcome.exitCode,
      startedAt,
      completedAt,
      tmuxSession: outcome.tmuxSession,
    },
  });

  return {
    ...ref,
    status: outcome.status,
    workerId: input.worker.workerId,
    intent: selected,
    workerBlock,
    assignmentBlock,
    resultBlock,
    summary: outcome.summary,
  };
}

export function selectRunnableIntent(state: SchedulerState, worker: WorkerProfilePayload, now = new Date().toISOString()): SchedulerIntent | undefined {
  if (worker.enabled === false) return undefined;
  const candidates = [...state.intents].sort((left, right) => {
    const priority = (right.payload.priority ?? 0) - (left.payload.priority ?? 0);
    if (priority !== 0) return priority;
    return left.createdAt.localeCompare(right.createdAt);
  });
  for (const intent of candidates) {
    if (!workerMatchesIntent(worker, intent.payload)) continue;
    if (intent.results.some((result) => result.payload.workerId === worker.workerId)) continue;
    if (intent.latestResult?.payload.status === "completed") continue;
    const policy = intent.payload.policy ?? "exclusive";
    const activeAssignments = intent.assignments.filter((assignment) => assignmentActive(assignment, now));
    if (policy === "exclusive" && activeAssignments.length > 0) continue;
    if (policy === "exclusive" && intent.results.length > 0) continue;
    if (policy === "speculative" && activeAssignments.some((assignment) => assignment.payload.workerId === worker.workerId)) continue;
    return intent;
  }
  return undefined;
}

export function workerMatchesIntent(worker: WorkerProfilePayload, intent: TaskIntentPayload): boolean {
  const requirements = intent.requirements;
  if (!requirements) return worker.enabled !== false;
  if (requirements.agents?.length && !requirements.agents.includes(worker.agent)) return false;
  if (requirements.modelFamilies?.length && !hasAny(worker.modelFamilies, requirements.modelFamilies)) return false;
  if (requirements.models?.length && !hasAny(worker.models, requirements.models)) return false;
  if (requirements.tools?.length && !hasAll(worker.tools, requirements.tools)) return false;
  return worker.enabled !== false;
}

export function renderSchedulerDashboard(state: SchedulerState): string {
  const lines: string[] = [];
  lines.push(`Scheduler: ${state.projectId}/${state.taskId}/${state.laneId}`);
  lines.push(`tip: ${state.tip ?? "<empty>"}`);
  lines.push(
    `tasks: ${state.intents.length} (pending ${state.counts.pending}, assigned ${state.counts.assigned}, completed ${state.counts.completed}, failed ${state.counts.failed}, blocked ${state.counts.blocked}, cancelled ${state.counts.cancelled})`,
  );
  lines.push(`workers: ${state.workers.length}`);
  for (const worker of state.workers) {
    const payload = worker.payload;
    const labels = [
      payload.agent,
      payload.enabled === false ? "disabled" : "enabled",
      payload.modelFamilies?.length ? `families=${payload.modelFamilies.join(",")}` : undefined,
      payload.tools?.length ? `tools=${payload.tools.join(",")}` : undefined,
      payload.tmuxSession ? `tmux=${payload.tmuxSession}` : undefined,
    ].filter(Boolean);
    lines.push(`  - ${payload.workerId}: ${labels.join(" ")}`);
  }
  lines.push("queue:");
  if (state.intents.length === 0) lines.push("  - none");
  for (const intent of state.intents) {
    const latest = intent.latestResult ? ` result=${intent.latestResult.payload.workerId}/${intent.latestResult.payload.status}` : "";
    const assignment = intent.assignments.at(-1);
    const assigned = assignment ? ` assigned=${assignment.payload.workerId}` : "";
    lines.push(`  - ${intent.status} ${intent.blockId} ${intent.payload.title}${assigned}${latest}`);
  }
  return `${lines.join("\n")}\n`;
}

async function appendSchedulerBlock<TPayload extends TaskBlockPayload>(
  input: SchedulerSubmitInput<TPayload>,
): Promise<TaskBlock<TPayload>> {
  const ref = laneRef(input);
  await ensureSchedulerLane(input.provider, ref, input.signer, input.createdAt);
  const status = await input.provider.status(ref);
  const block = await createSignedTaskBlock(
    {
      ...ref,
      kind: input.kind as TaskBlockKind,
      parentTips: status.lane.tip ? [status.lane.tip] : [],
      leaseEpoch: status.lane.leaseEpoch,
      createdAt: input.createdAt,
      payload: input.payload,
    },
    input.signer,
  );
  const result = await input.provider.submitBlock(block);
  return requireAcceptedBlock(result, input.kind) as TaskBlock<TPayload>;
}

async function ensureSchedulerLane(provider: ContinuityProvider, ref: LaneRef, signer: ContinuitySigner, createdAt?: string): Promise<void> {
  const status = await provider.status(ref);
  if (status.lane.tip) return;
  const block = await createSignedTaskBlock<BootstrapPayload>(
    {
      ...ref,
      kind: "bootstrap",
      parentTips: [],
      leaseEpoch: 0,
      createdAt,
      payload: {
        summary: `Initialized scheduler lane for ${ref.taskId}.`,
      },
    },
    signer,
  );
  requireAcceptedBlock(await provider.submitBlock(block), "bootstrap");
}

function requireAcceptedBlock(result: ProviderSubmitResult, label: string): TaskBlock {
  if (!result.accepted || !result.block) {
    const reason = result.rejection ? `${result.rejection.code}: ${result.rejection.message}` : "missing accepted block";
    throw new Error(`scheduler ${label} block was rejected: ${reason}`);
  }
  return result.block;
}

async function runWorker(
  runner: SchedulerRunner,
  input: {
    command?: string;
    tmuxSession?: string;
    keepTmuxSession?: boolean;
    timeoutMs: number;
    intent: SchedulerIntent;
    worker: WorkerProfilePayload;
  },
): Promise<RunnerOutcome> {
  if (runner === "fake") {
    return {
      status: "completed",
      summary: `fake runner ${input.worker.workerId} completed ${input.intent.payload.title}`,
    };
  }
  if (!input.command) throw new Error(`--command is required for ${runner} runner`);
  if (runner === "command") return runShellCommand(input.command, input.timeoutMs);
  return runTmuxCommand(input.command, input.tmuxSession ?? `continuity-${input.worker.workerId}`, input.keepTmuxSession ?? true, input.timeoutMs);
}

function runShellCommand(command: string, timeoutMs: number): Promise<RunnerOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    const settle = (outcome: RunnerOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      const exitCode = code ?? (signal ? 128 : 1);
      settle({
        status: exitCode === 0 && !timedOut ? "completed" : "failed",
        summary: timedOut ? `command runner timed out after ${timeoutMs}ms` : `command runner exited with ${exitCode}`,
        exitCode,
        artifacts: commandArtifacts(stdout, stderr),
      });
    });
  });
}

async function runTmuxCommand(command: string, session: string, keepSession: boolean, timeoutMs: number): Promise<RunnerOutcome> {
  const channel = `continuity-${randomUUID()}`;
  const wrapped = `${command}\ncode=$?\nprintf '\\n__CONTINUITY_EXIT__:%s\\n' "$code"\ntmux wait-for -S ${shellQuote(channel)}`;
  await execProgram("tmux", ["new-session", "-d", "-s", session, "sh", "-lc", wrapped]);
  await execProgram("tmux", ["wait-for", channel], timeoutMs);
  const captured = await execProgram("tmux", ["capture-pane", "-pt", session, "-S", "-"]);
  if (!keepSession) await execProgram("tmux", ["kill-session", "-t", session]);
  const match = captured.stdout.match(/__CONTINUITY_EXIT__:(\d+)/);
  const exitCode = match ? Number(match[1]) : 1;
  return {
    status: exitCode === 0 ? "completed" : "failed",
    summary: `tmux runner ${session} exited with ${exitCode}`,
    exitCode,
    tmuxSession: session,
    artifacts: commandArtifacts(captured.stdout, captured.stderr),
  };
}

function execProgram(file: string, args: string[], timeoutMs?: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          child.kill("SIGTERM");
          settled = true;
          reject(new Error(`${file} ${args.join(" ")} timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : undefined;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk);
    });
    child.once("error", (error) => settle(() => reject(error)));
    child.once("exit", (code) => {
      settle(() => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`${file} ${args.join(" ")} exited with ${code ?? "signal"}${stderr ? `: ${stderr.trim()}` : ""}`));
      });
    });
  });
}

function assignmentActive(assignment: SchedulerAssignment, now: string): boolean {
  const leaseUntil = assignment.payload.leaseUntil;
  if (!leaseUntil) return true;
  return Date.parse(leaseUntil) > Date.parse(now);
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function workerProfileMatches(left: WorkerProfilePayload | undefined, right: WorkerProfilePayload): boolean {
  if (!left) return false;
  return JSON.stringify(normalizeWorkerProfile(left)) === JSON.stringify(normalizeWorkerProfile(right));
}

function normalizeWorkerProfile(worker: WorkerProfilePayload): WorkerProfilePayload {
  return {
    ...worker,
    modelFamilies: worker.modelFamilies ? [...worker.modelFamilies].sort() : undefined,
    models: worker.models ? [...worker.models].sort() : undefined,
    tools: worker.tools ? [...worker.tools].sort() : undefined,
  };
}

function groupBy<TValue>(values: TValue[], key: (value: TValue) => string): Map<string, TValue[]> {
  const grouped = new Map<string, TValue[]>();
  for (const value of values) {
    const groupKey = key(value);
    grouped.set(groupKey, [...(grouped.get(groupKey) ?? []), value]);
  }
  return grouped;
}

function hasAny(actual: string[] | undefined, required: string[]): boolean {
  if (!actual?.length) return false;
  return required.some((entry) => actual.includes(entry));
}

function hasAll(actual: string[] | undefined, required: string[]): boolean {
  if (!actual?.length) return false;
  return required.every((entry) => actual.includes(entry));
}

function commandArtifacts(stdout: string, stderr: string): string[] | undefined {
  const artifacts = [];
  if (stdout.trim()) artifacts.push(`stdout:\n${stdout.trimEnd()}`);
  if (stderr.trim()) artifacts.push(`stderr:\n${stderr.trimEnd()}`);
  return artifacts.length > 0 ? artifacts : undefined;
}

function appendLimited(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= OUTPUT_LIMIT ? next : next.slice(next.length - OUTPUT_LIMIT);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function laneRef(input: LaneRef): LaneRef {
  return {
    projectId: input.projectId,
    taskId: input.taskId,
    laneId: input.laneId,
  };
}
