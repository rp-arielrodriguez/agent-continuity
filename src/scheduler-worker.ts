import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ContinuitySigner, LaneRef, WorkerProfilePayload } from "./block.js";
import type { PeerSyncResult } from "./daemon-provider.js";
import type { ContinuityProvider } from "./provider.js";
import { loadSchedulerState, runSchedulerOnce, type SchedulerRunOnceResult, type SchedulerRunner } from "./scheduler.js";

const execFile = promisify(execFileCallback);
const DEFAULT_LOOP_INTERVAL_MS = 5_000;
const DEFAULT_MAX_ERRORS = 3;

export type SchedulerWorkerLoopStopReason = "max-runs" | "idle-limit" | "duration" | "max-errors" | "aborted";

export interface SchedulerWorkerLoopEvent {
  type: "sync" | "result" | "error" | "stop";
  at: string;
  sync?: PeerSyncResult;
  result?: SchedulerRunOnceResult;
  error?: string;
  stopReason?: SchedulerWorkerLoopStopReason;
}

export interface SchedulerWorkerLoopInput extends LaneRef {
  provider: ContinuityProvider;
  signer: ContinuitySigner;
  worker: WorkerProfilePayload;
  runner?: SchedulerRunner;
  command?: string;
  tmuxSession?: string;
  keepTmuxSession?: boolean;
  runnerTimeoutMs?: number;
  leaseMs?: number;
  allowedProjectIds?: string[];
  allowedCommands?: string[];
  maxRunnerTimeoutMs?: number;
  worktreeRoot?: string;
  intervalMs?: number;
  maxRuns?: number;
  idleLimit?: number;
  durationMs?: number;
  maxErrors?: number;
  syncBeforeRun?: () => Promise<PeerSyncResult>;
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  onEvent?: (event: SchedulerWorkerLoopEvent) => void | Promise<void>;
}

export interface SchedulerWorkerLoopSummary extends LaneRef {
  workerId: string;
  startedAt: string;
  stoppedAt: string;
  stopReason: SchedulerWorkerLoopStopReason;
  iterations: number;
  runs: number;
  idle: number;
  completed: number;
  failed: number;
  blocked: number;
  cancelled: number;
  errors: number;
  lastResult?: SchedulerRunOnceResult;
}

export interface TmuxSessionStatus {
  session: string;
  running: boolean;
  tail?: string;
}

export async function runSchedulerWorkerLoop(input: SchedulerWorkerLoopInput): Promise<SchedulerWorkerLoopSummary> {
  const now = input.now ?? (() => new Date().toISOString());
  const sleep = input.sleep ?? sleepMs;
  const intervalMs = input.intervalMs ?? DEFAULT_LOOP_INTERVAL_MS;
  const maxErrors = input.maxErrors ?? DEFAULT_MAX_ERRORS;
  validateWorkerPolicy(input);
  const runnerTimeoutMs = effectiveRunnerTimeoutMs(input);
  const startedAt = now();
  const startedAtMs = Date.now();
  let iterations = 0;
  let runs = 0;
  let idle = 0;
  let completed = 0;
  let failed = 0;
  let blocked = 0;
  let cancelled = 0;
  let errors = 0;
  let consecutiveIdle = 0;
  let lastResult: SchedulerRunOnceResult | undefined;
  let stopReason: SchedulerWorkerLoopStopReason | undefined;

  while (!stopReason) {
    if (input.signal?.aborted) {
      stopReason = "aborted";
      break;
    }
    if (input.durationMs !== undefined && Date.now() - startedAtMs >= input.durationMs) {
      stopReason = "duration";
      break;
    }

    iterations += 1;
    try {
      if (input.syncBeforeRun) {
        const sync = await input.syncBeforeRun();
        await emit(input, { type: "sync", at: now(), sync });
      }

      const state = await loadSchedulerState(input.provider, input);
      const result = state.intents.length === 0
        ? idleResult(input)
        : await runSchedulerOnce({
        projectId: input.projectId,
        taskId: input.taskId,
        laneId: input.laneId,
        provider: input.provider,
        signer: input.signer,
        worker: input.worker,
        runner: input.runner,
        command: input.command,
        tmuxSession: input.tmuxSession,
        keepTmuxSession: input.keepTmuxSession,
        runnerTimeoutMs,
        leaseMs: input.leaseMs,
        worktreeRoot: input.worktreeRoot,
      });

      lastResult = result;
      await emit(input, { type: "result", at: now(), result });

      if (result.status === "idle") {
        idle += 1;
        consecutiveIdle += 1;
      } else {
        runs += 1;
        consecutiveIdle = 0;
        if (result.status === "completed") completed += 1;
        else if (result.status === "failed") failed += 1;
        else if (result.status === "blocked") blocked += 1;
        else if (result.status === "cancelled") cancelled += 1;
      }

      if (input.maxRuns !== undefined && runs >= input.maxRuns) stopReason = "max-runs";
      if (!stopReason && input.idleLimit !== undefined && consecutiveIdle >= input.idleLimit) stopReason = "idle-limit";
    } catch (error) {
      errors += 1;
      consecutiveIdle = 0;
      await emit(input, { type: "error", at: now(), error: error instanceof Error ? error.message : String(error) });
      if (errors >= maxErrors) stopReason = "max-errors";
    }

    if (!stopReason && intervalMs > 0) await sleep(intervalMs);
  }

  const summary = {
    projectId: input.projectId,
    taskId: input.taskId,
    laneId: input.laneId,
    workerId: input.worker.workerId,
    startedAt,
    stoppedAt: now(),
    stopReason,
    iterations,
    runs,
    idle,
    completed,
    failed,
    blocked,
    cancelled,
    errors,
    lastResult,
  } satisfies SchedulerWorkerLoopSummary;
  await emit(input, { type: "stop", at: summary.stoppedAt, stopReason });
  return summary;
}

function idleResult(input: SchedulerWorkerLoopInput): SchedulerRunOnceResult {
  return {
    projectId: input.projectId,
    taskId: input.taskId,
    laneId: input.laneId,
    status: "idle",
    workerId: input.worker.workerId,
    summary: `no scheduler task intents for worker ${input.worker.workerId}`,
  };
}

export function defaultSchedulerWorkerTmuxSession(workerId: string): string {
  return `continuity-worker-${workerId.replaceAll(/[^A-Za-z0-9_.-]/g, "-")}`;
}

export function validateWorkerPolicy(input: Pick<SchedulerWorkerLoopInput, "projectId" | "command" | "runnerTimeoutMs" | "allowedProjectIds" | "allowedCommands" | "maxRunnerTimeoutMs">): void {
  if (input.allowedProjectIds?.length && !input.allowedProjectIds.includes(input.projectId)) {
    throw new Error(`project ${input.projectId} is not allowed for this worker`);
  }
  if (input.command && input.allowedCommands?.length && !input.allowedCommands.some((allowed) => commandMatchesAllowedPrefix(input.command!, allowed))) {
    throw new Error(`worker command is not in --allowed-commands`);
  }
  if (input.runnerTimeoutMs !== undefined && input.maxRunnerTimeoutMs !== undefined && input.runnerTimeoutMs > input.maxRunnerTimeoutMs) {
    throw new Error(`--runner-timeout-ms ${input.runnerTimeoutMs} exceeds --max-runner-timeout-ms ${input.maxRunnerTimeoutMs}`);
  }
}

function effectiveRunnerTimeoutMs(input: Pick<SchedulerWorkerLoopInput, "runnerTimeoutMs" | "maxRunnerTimeoutMs">): number | undefined {
  if (input.runnerTimeoutMs !== undefined) return input.runnerTimeoutMs;
  return input.maxRunnerTimeoutMs;
}

function commandMatchesAllowedPrefix(command: string, allowedPrefix: string): boolean {
  const normalizedCommand = command.trim();
  const normalizedAllowed = allowedPrefix.trim();
  return normalizedCommand === normalizedAllowed || normalizedCommand.startsWith(`${normalizedAllowed} `);
}

export async function startTmuxSession(input: { session: string; command: string; cwd?: string }): Promise<TmuxSessionStatus> {
  const existing = await tmuxSessionStatus({ session: input.session });
  if (existing.running) throw new Error(`tmux session already exists: ${input.session}`);
  const args = ["new-session", "-d", "-s", input.session];
  if (input.cwd) args.push("-c", input.cwd);
  args.push(input.command);
  await execFile("tmux", args);
  return tmuxSessionStatus({ session: input.session });
}

export async function tmuxSessionStatus(input: { session: string; tailLines?: number }): Promise<TmuxSessionStatus> {
  const running = await tmuxHasSession(input.session);
  if (!running) return { session: input.session, running: false };
  const tail = await captureTmuxTail(input.session, input.tailLines ?? 40);
  return { session: input.session, running: true, tail };
}

export async function stopTmuxSession(input: { session: string }): Promise<TmuxSessionStatus> {
  const running = await tmuxHasSession(input.session);
  if (running) await execFile("tmux", ["kill-session", "-t", input.session]);
  return { session: input.session, running: false };
}

export function attachTmuxSession(input: { session: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("tmux", ["attach-session", "-t", input.session], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 0));
  });
}

async function emit(input: SchedulerWorkerLoopInput, event: SchedulerWorkerLoopEvent): Promise<void> {
  await input.onEvent?.(event);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tmuxHasSession(session: string): Promise<boolean> {
  try {
    await execFile("tmux", ["has-session", "-t", session]);
    return true;
  } catch {
    return false;
  }
}

async function captureTmuxTail(session: string, tailLines: number): Promise<string> {
  try {
    const result = await execFile("tmux", ["capture-pane", "-pt", session, "-S", `-${tailLines}`], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    return result.stdout.trimEnd();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
