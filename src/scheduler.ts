import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  BootstrapPayload,
  ContinuitySigner,
  LaneRef,
  TaskAdjudicationPayload,
  TaskAssignmentPayload,
  TaskBlock,
  TaskBlockKind,
  TaskEvaluationPayload,
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

export type SchedulerBlockKind = "task_intent" | "worker_profile" | "task_assignment" | "task_result" | "task_evaluation" | "task_adjudication";
export type SchedulerRunner = "fake" | "command" | "tmux";
export type SchedulerIntentStatus = "pending" | "assigned" | "needs_adjudication" | "completed" | "failed" | "blocked" | "cancelled";

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
  evaluations: SchedulerEvaluation[];
  adjudications: SchedulerAdjudication[];
  latestResult?: SchedulerResult;
  latestEvaluation?: SchedulerEvaluation;
  latestAdjudication?: SchedulerAdjudication;
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

export interface SchedulerEvaluation {
  blockId: string;
  createdAt: string;
  nodeId: string;
  actorId: string;
  payload: TaskEvaluationPayload;
}

export interface SchedulerAdjudication {
  blockId: string;
  createdAt: string;
  nodeId: string;
  actorId: string;
  payload: TaskAdjudicationPayload;
}

export interface SchedulerState extends LaneRef {
  tip?: string;
  heads?: string[];
  workers: SchedulerWorker[];
  intents: SchedulerIntent[];
  assignments: SchedulerAssignment[];
  results: SchedulerResult[];
  evaluations: SchedulerEvaluation[];
  adjudications: SchedulerAdjudication[];
  counts: Record<SchedulerIntentStatus, number>;
}

export interface SchedulerSubmitInput<TPayload extends TaskBlockPayload> extends LaneRef {
  provider: ContinuityProvider;
  signer: ContinuitySigner;
  kind: SchedulerBlockKind;
  payload: TPayload;
  parentTips?: string[];
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
  worktreeRoot?: string;
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

export type SchedulerRunnerEnvironment = Record<string, string>;

export async function loadSchedulerState(provider: ContinuityProvider, ref: LaneRef): Promise<SchedulerState> {
  const [status, blocks] = await Promise.all([provider.status(ref), provider.blocks(ref)]);
  return deriveSchedulerState(ref, blocks, status.lane.tip, status.lane.heads);
}

export function deriveSchedulerState(ref: LaneRef, blocks: TaskBlock[], tip?: string, heads?: string[]): SchedulerState {
  const workerById = new Map<string, SchedulerWorker>();
  const rawIntents: SchedulerIntent[] = [];
  const assignments: SchedulerAssignment[] = [];
  const results: SchedulerResult[] = [];
  const evaluations: SchedulerEvaluation[] = [];
  const adjudications: SchedulerAdjudication[] = [];

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
        evaluations: [],
        adjudications: [],
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
    } else if (block.kind === "task_evaluation") {
      evaluations.push({
        blockId: block.blockId,
        createdAt: block.createdAt,
        nodeId: block.nodeId,
        actorId: block.actorId,
        payload: block.payload as TaskEvaluationPayload,
      });
    } else if (block.kind === "task_adjudication") {
      adjudications.push({
        blockId: block.blockId,
        createdAt: block.createdAt,
        nodeId: block.nodeId,
        actorId: block.actorId,
        payload: block.payload as TaskAdjudicationPayload,
      });
    }
  }

  const assignmentsByIntent = groupBy(assignments, (assignment) => assignment.payload.intentBlockId);
  const resultsByIntent = groupBy(results, (result) => result.payload.intentBlockId);
  const evaluationsByIntent = groupBy(evaluations, (evaluation) => evaluation.payload.intentBlockId);
  const adjudicationsByIntent = groupBy(adjudications, (adjudication) => adjudication.payload.intentBlockId);
  const intents = rawIntents.map((intent) => {
    const intentAssignments = assignmentsByIntent.get(intent.blockId) ?? [];
    const intentResults = resultsByIntent.get(intent.blockId) ?? [];
    const intentEvaluations = evaluationsByIntent.get(intent.blockId) ?? [];
    const intentAdjudications = adjudicationsByIntent.get(intent.blockId) ?? [];
    const latestResult = intentResults.at(-1);
    const latestEvaluation = intentEvaluations.at(-1);
    const latestAdjudication = intentAdjudications.at(-1);
    const winner = latestAdjudication?.payload.winnerResultBlockId
      ? intentResults.find((result) => result.blockId === latestAdjudication.payload.winnerResultBlockId)
      : undefined;
    const status = deriveIntentStatus(intent.payload, intentAssignments, intentResults, latestEvaluation, latestAdjudication, winner);
    return {
      ...intent,
      status,
      assignments: intentAssignments,
      results: intentResults,
      evaluations: intentEvaluations,
      adjudications: intentAdjudications,
      latestResult,
      latestEvaluation,
      latestAdjudication,
    };
  });
  const counts = {
    pending: 0,
    assigned: 0,
    needs_adjudication: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
  } satisfies Record<SchedulerIntentStatus, number>;
  for (const intent of intents) counts[intent.status] += 1;

  return {
    ...ref,
    tip,
    heads,
    workers: [...workerById.values()],
    intents,
    assignments,
    results,
    evaluations,
    adjudications,
    counts,
  };
}

export async function registerWorkerProfile(input: Omit<SchedulerSubmitInput<WorkerProfilePayload>, "kind">): Promise<TaskBlock<WorkerProfilePayload>> {
  return appendSchedulerBlock({ ...input, kind: "worker_profile" });
}

function deriveIntentStatus(
  intent: TaskIntentPayload,
  assignments: SchedulerAssignment[],
  results: SchedulerResult[],
  latestEvaluation: SchedulerEvaluation | undefined,
  latestAdjudication: SchedulerAdjudication | undefined,
  winner: SchedulerResult | undefined,
): SchedulerIntentStatus {
  if (winner) return winner.payload.status;
  if (latestAdjudication) return latestAdjudication.payload.winnerResultBlockId ? "completed" : "needs_adjudication";
  if (latestEvaluation) return "needs_adjudication";
  if ((intent.policy ?? "exclusive") === "speculative" && results.length > 1) return "needs_adjudication";
  const latestResult = results.at(-1);
  return latestResult?.payload.status ?? (assignments.length > 0 ? "assigned" : "pending");
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

export async function submitTaskEvaluation(input: Omit<SchedulerSubmitInput<TaskEvaluationPayload>, "kind">): Promise<TaskBlock<TaskEvaluationPayload>> {
  return appendSchedulerBlock({ ...input, kind: "task_evaluation" });
}

export async function submitTaskAdjudication(input: Omit<SchedulerSubmitInput<TaskAdjudicationPayload>, "kind">): Promise<TaskBlock<TaskAdjudicationPayload>> {
  return appendSchedulerBlock({ ...input, kind: "task_adjudication" });
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
  const worktreeDir = input.worktreeRoot ? await prepareTaskWorktree(input.worktreeRoot, ref, selected, input.worker.workerId, assignmentBlock.blockId) : undefined;

  const startedAt = new Date().toISOString();
  const outcome = await runWorker(input.runner ?? "fake", {
    command: input.command,
    tmuxSession: input.tmuxSession ?? input.worker.tmuxSession,
    keepTmuxSession: input.keepTmuxSession,
    timeoutMs: input.runnerTimeoutMs ?? DEFAULT_RUNNER_TIMEOUT_MS,
    intent: selected,
    ref,
    worker: input.worker,
    workDir: worktreeDir,
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
    const policy = intent.payload.policy ?? "exclusive";
    if (policy !== "speculative" && intent.latestResult?.payload.status === "completed") continue;
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
  if (state.heads && state.heads.length > 1) lines.push(`heads: ${state.heads.join(",")}`);
  lines.push(
    `tasks: ${state.intents.length} (pending ${state.counts.pending}, assigned ${state.counts.assigned}, needs_adjudication ${state.counts.needs_adjudication}, completed ${state.counts.completed}, failed ${state.counts.failed}, blocked ${state.counts.blocked}, cancelled ${state.counts.cancelled})`,
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
    const evaluation = intent.latestEvaluation
      ? ` evaluation=${intent.latestEvaluation.actorId}${intent.latestEvaluation.payload.confidence ? `/${intent.latestEvaluation.payload.confidence}` : ""}${intent.latestEvaluation.payload.recommendedWinnerResultBlockId ? ` recommended=${intent.latestEvaluation.payload.recommendedWinnerResultBlockId}` : ""}`
      : "";
    const winner = intent.latestAdjudication?.payload.winnerResultBlockId ? ` winner=${intent.latestAdjudication.payload.winnerResultBlockId}` : "";
    const assignment = intent.assignments.at(-1);
    const assigned = assignment ? ` assigned=${assignment.payload.workerId}` : "";
    lines.push(`  - ${intent.status} ${intent.blockId} ${intent.payload.title}${assigned}${latest}${evaluation}${winner}`);
  }
  return `${lines.join("\n")}\n`;
}

export function schedulerRunnerEnvironment(ref: LaneRef, intent: SchedulerIntent, worker: WorkerProfilePayload, worktreeDir?: string): SchedulerRunnerEnvironment {
  return {
    CONTINUITY_PROJECT_ID: ref.projectId,
    CONTINUITY_TASK_ID: ref.taskId,
    CONTINUITY_LANE_ID: ref.laneId,
    CONTINUITY_INTENT_BLOCK_ID: intent.blockId,
    CONTINUITY_TASK_TITLE: intent.payload.title,
    CONTINUITY_TASK_INSTRUCTIONS: intent.payload.instructions,
    CONTINUITY_TARGET_LANE_ID: intent.payload.targetLaneId ?? "",
    CONTINUITY_TASK_POLICY: intent.payload.policy ?? "exclusive",
    CONTINUITY_WORKER_ID: worker.workerId,
    CONTINUITY_AGENT: worker.agent,
    CONTINUITY_MODEL_FAMILIES: worker.modelFamilies?.join(",") ?? "",
    CONTINUITY_MODELS: worker.models?.join(",") ?? "",
    CONTINUITY_TOOLS: worker.tools?.join(",") ?? "",
    CONTINUITY_WORKTREE_DIR: worktreeDir ?? "",
  };
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
      parentTips: input.parentTips ?? (status.lane.tip ? [status.lane.tip] : []),
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
    ref: LaneRef;
    worker: WorkerProfilePayload;
    workDir?: string;
  },
): Promise<RunnerOutcome> {
  if (runner === "fake") {
    return {
      status: "completed",
      summary: `fake runner ${input.worker.workerId} completed ${input.intent.payload.title}`,
    };
  }
  if (!input.command) throw new Error(`--command is required for ${runner} runner`);
  const env = schedulerRunnerEnvironment(input.ref, input.intent, input.worker, input.workDir);
  if (runner === "command") return runShellCommand(input.command, input.timeoutMs, env, input.workDir);
  return runTmuxCommand(input.command, input.tmuxSession ?? defaultTmuxRunnerSession(input.worker.workerId, input.intent.blockId), input.keepTmuxSession ?? true, input.timeoutMs, env, input.workDir);
}

function runShellCommand(command: string, timeoutMs: number, env: SchedulerRunnerEnvironment, cwd?: string): Promise<RunnerOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, env: { ...process.env, ...env }, shell: true, stdio: ["ignore", "pipe", "pipe"] });
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

async function runTmuxCommand(command: string, session: string, keepSession: boolean, timeoutMs: number, env: SchedulerRunnerEnvironment, cwd?: string): Promise<RunnerOutcome> {
  const channel = `continuity-${randomUUID()}`;
  const exports = Object.entries(env)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("\n");
  const wrapped = `${exports}\n${command}\ncode=$?\nprintf '\\n__CONTINUITY_EXIT__:%s\\n' "$code"\ntmux wait-for -S ${shellQuote(channel)}`;
  const args = ["new-session", "-d", "-s", session];
  if (cwd) args.push("-c", cwd);
  args.push("sh", "-lc", wrapped);
  await execProgram("tmux", args);
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

async function prepareTaskWorktree(root: string, ref: LaneRef, intent: SchedulerIntent, workerId: string, assignmentBlockId: string): Promise<string> {
  const dir = path.resolve(root, safePathSegment(`${ref.projectId}-${ref.taskId}-${workerId}-${intent.blockId.slice(4, 12)}-${assignmentBlockId.slice(4, 12)}`));
  if (await pathExists(dir)) return dir;
  await mkdir(path.dirname(dir), { recursive: true });

  if (await currentDirectoryIsGitCheckout()) {
    try {
      await execProgram("git", ["worktree", "add", "--detach", dir, "HEAD"]);
      return dir;
    } catch (error) {
      if (!(await pathExists(dir))) throw error;
      return dir;
    }
  }

  await mkdir(dir, { recursive: true });
  return dir;
}

async function currentDirectoryIsGitCheckout(): Promise<boolean> {
  try {
    await execProgram("git", ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function safePathSegment(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_.-]/g, "-").replaceAll(/-+/g, "-").slice(0, 160);
}

function defaultTmuxRunnerSession(workerId: string, intentBlockId: string): string {
  return `continuity-${workerId}-${intentBlockId.slice(4, 12)}`.replaceAll(/[^A-Za-z0-9_.-]/g, "-");
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
