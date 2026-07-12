import { spawn } from "node:child_process";
import type { ActorRef, ContinuitySigner, HandoffPayload, LaneRef, ReleasePayload } from "./block.js";
import type { PeerSyncResult } from "./daemon-provider.js";
import { readDaemonCanon, runDaemonCheckpoint, type DaemonCheckpointInput, type DaemonCheckpointResult } from "./daemon-workflow.js";
import type { ContinuityProvider, LaneStatus, ProviderSubmitResult } from "./provider.js";

const DEFAULT_AGENT_RUN_OUTPUT_LIMIT = 8_000;

export interface AgentOrientInput extends LaneRef {
  provider: ContinuityProvider;
  actor?: ActorRef;
  now?: string;
  syncBeforeOrient?: () => Promise<PeerSyncResult>;
}

export interface AgentOrientResult extends LaneRef {
  lane: LaneStatus["lane"];
  action: LaneStatus["action"];
  reason?: string;
  canonMarkdown: string | null;
  sync?: PeerSyncResult;
  prompt: string;
}

export interface AgentClaimInput extends LaneRef {
  provider: ContinuityProvider;
  signer: ContinuitySigner;
  now?: string;
  createdAt?: string;
  leaseUntil?: string;
  reason?: string;
  bootstrapSummary?: string;
}

export interface AgentClaimResult extends LaneRef {
  action: LaneStatus["action"];
  lane: LaneStatus["lane"];
  bootstrap?: ProviderSubmitResult;
  claim?: ProviderSubmitResult;
  alreadyOwner: boolean;
}

export interface AgentHandoffInput extends AgentClaimInput {
  targetNodeId?: string;
  targetActorId?: string;
  releaseReason?: string;
}

export interface AgentHandoffResult extends LaneRef {
  lane: LaneStatus["lane"];
  block?: ProviderSubmitResult["block"];
  mode: "handoff" | "release";
  action: ProviderSubmitResult["action"];
  accepted: boolean;
  rejection?: ProviderSubmitResult["rejection"];
}

export interface AgentRunInput extends LaneRef {
  provider: ContinuityProvider;
  signer: ContinuitySigner;
  command: string;
  allowedCommands?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: string;
  createdAt?: string;
  leaseUntil?: string;
  claimReason?: string;
  bootstrapSummary?: string;
  timeoutMs?: number;
  outputLimit?: number;
  syncBeforeOrient?: () => Promise<PeerSyncResult>;
  checkpoint?: Partial<Omit<DaemonCheckpointInput, keyof LaneRef | "provider" | "progress" | "status">> & {
    enabled?: boolean;
    successStatus?: DaemonCheckpointInput["status"];
    failureStatus?: DaemonCheckpointInput["status"];
    next?: string;
  };
}

export interface AgentRunResult extends LaneRef {
  orient: AgentOrientResult;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  checkpoint?: DaemonCheckpointResult;
}

export async function orientAgent(input: AgentOrientInput): Promise<AgentOrientResult> {
  const sync = input.syncBeforeOrient ? await input.syncBeforeOrient() : undefined;
  const status = await input.provider.status({
    projectId: input.projectId,
    taskId: input.taskId,
    laneId: input.laneId,
    actor: input.actor,
    now: input.now,
  });
  const canon = await readDaemonCanon(input);
  const result = {
    projectId: input.projectId,
    taskId: input.taskId,
    laneId: input.laneId,
    lane: status.lane,
    action: status.action,
    reason: status.reason,
    canonMarkdown: canon.canonMarkdown,
    sync,
  } satisfies Omit<AgentOrientResult, "prompt">;
  return { ...result, prompt: renderAgentOrientation(result) };
}

export function renderAgentOrientation(input: Omit<AgentOrientResult, "prompt">): string {
  const owner = input.lane.owner ? `${input.lane.owner.nodeId}/${input.lane.owner.actorId}` : "<none>";
  const sync = input.sync ? `sync inserted=${input.sync.insertedBlocks} rejected=${input.sync.rejectedBlocks}` : "sync skipped";
  const canon = input.canonMarkdown?.trim()
    ? input.canonMarkdown.trim()
    : "# Canon\n\nNo daemon canon exists yet for this lane.";
  return `<continuity-orient>
project: ${input.projectId}
task: ${input.taskId}
lane: ${input.laneId}
action: ${input.action}
reason: ${input.reason ?? "<none>"}
owner: ${owner}
tip: ${input.lane.tip ?? "<empty>"}
heads: ${(input.lane.heads ?? []).join(",") || "<none>"}
session: ${input.lane.sessionEnvelope ? `${input.lane.sessionEnvelope.sessionId} cwd=${input.lane.sessionEnvelope.cwd}` : "<none>"}
recoveryCommand: ${input.lane.sessionEnvelope?.recoveryCommand ?? "<none>"}
runEvents: ${renderRunEvents(input.lane.runEvents)}
${sync}

${canon}
</continuity-orient>`;
}

function renderRunEvents(events: AgentOrientResult["lane"]["runEvents"]): string {
  if (!events?.length) return "<none>";
  return events
    .slice(-5)
    .map((event) => `${event.severity}/${event.category}: ${event.summary}`)
    .join(" | ");
}

export async function claimAgentLane(input: AgentClaimInput): Promise<AgentClaimResult> {
  let status = await input.provider.status({ ...laneRef(input), actor: input.signer, now: input.now });
  if (status.action === "pause") {
    return { ...laneRef(input), action: status.action, lane: status.lane, alreadyOwner: false };
  }

  let bootstrap: ProviderSubmitResult | undefined;
  if (!status.lane.tip) {
    bootstrap = await input.provider.bootstrap({
      ...laneRef(input),
      signer: input.signer,
      createdAt: input.createdAt,
      payload: {
        summary: input.bootstrapSummary ?? `Initialized ${input.taskId} for agent harness.`,
      },
    });
    if (!bootstrap.accepted) {
      return { ...laneRef(input), action: bootstrap.action, lane: bootstrap.lane, bootstrap, alreadyOwner: false };
    }
    status = { lane: bootstrap.lane, action: bootstrap.action };
  }

  if (status.lane.owner?.nodeId === input.signer.nodeId && status.lane.owner.actorId === input.signer.actorId) {
    return { ...laneRef(input), action: "continue", lane: status.lane, bootstrap, alreadyOwner: true };
  }

  const claim = await input.provider.claimLane({
    ...laneRef(input),
    signer: input.signer,
    expectedTip: status.lane.tip,
    createdAt: input.createdAt,
    now: input.now,
    leaseUntil: input.leaseUntil,
    reason: input.reason ?? "agent harness claim",
  });
  return { ...laneRef(input), action: claim.action, lane: claim.lane, bootstrap, claim, alreadyOwner: false };
}

export async function handoffAgentLane(input: AgentHandoffInput): Promise<AgentHandoffResult> {
  const claimed = await claimAgentLane(input);
  if (claimed.action !== "continue" || !laneOwnedBy(claimed.lane, input.signer)) {
    return { ...laneRef(input), lane: claimed.lane, mode: input.targetActorId ? "handoff" : "release", action: claimed.action, accepted: false };
  }
  const payload = input.targetActorId
    ? ({
        targetNodeId: input.targetNodeId,
        targetActorId: input.targetActorId,
        leaseUntil: input.leaseUntil,
      } satisfies HandoffPayload)
    : ({
        reason: input.releaseReason ?? "agent harness release",
      } satisfies ReleasePayload);
  const result = input.targetActorId
    ? await input.provider.handoff({
        ...laneRef(input),
        signer: input.signer,
        expectedTip: claimed.lane.tip,
        createdAt: input.createdAt,
        payload: payload as HandoffPayload,
      })
    : await input.provider.release({
        ...laneRef(input),
        signer: input.signer,
        expectedTip: claimed.lane.tip,
        createdAt: input.createdAt,
        payload: payload as ReleasePayload,
      });
  return {
    ...laneRef(input),
    lane: result.lane,
    block: result.block,
    mode: input.targetActorId ? "handoff" : "release",
    action: result.action,
    accepted: result.accepted,
    rejection: result.rejection,
  };
}

export async function runAgentCommand(input: AgentRunInput): Promise<AgentRunResult> {
  validateAgentCommandPolicy(input.command, input.allowedCommands);
  const sync = input.syncBeforeOrient ? await input.syncBeforeOrient() : undefined;
  const claim = await claimAgentLane({
    ...laneRef(input),
    provider: input.provider,
    signer: input.signer,
    now: input.now,
    createdAt: input.createdAt ?? input.now,
    leaseUntil: input.leaseUntil,
    reason: input.claimReason ?? "agent-run",
    bootstrapSummary: input.bootstrapSummary,
  });
  if (claim.action !== "continue" || !laneOwnedBy(claim.lane, input.signer)) {
    const reason = claim.claim?.rejection?.message ?? claim.bootstrap?.rejection?.message ?? `lane is owned by another actor`;
    throw new Error(`agent-run could not claim lane before executing command: ${reason}`);
  }
  const oriented = await orientAgent({
    ...laneRef(input),
    provider: input.provider,
    actor: input.signer,
    now: input.now,
  });
  const orient = sync ? agentOrientWithSync(oriented, sync) : oriented;
  const command = await runShellCommand(input.command, {
    cwd: input.cwd,
    env: {
      ...process.env,
      ...input.env,
      CONTINUITY_PROJECT_ID: input.projectId,
      CONTINUITY_TASK_ID: input.taskId,
      CONTINUITY_LANE_ID: input.laneId,
      CONTINUITY_ACTOR_ID: input.signer.actorId,
      CONTINUITY_NODE_ID: input.signer.nodeId,
      CONTINUITY_ORIENTATION: orient.prompt,
      CONTINUITY_CANON: orient.canonMarkdown ?? "",
    },
    timeoutMs: input.timeoutMs,
    outputLimit: input.outputLimit,
  });
  const checkpointEnabled = input.checkpoint?.enabled ?? true;
  const checkpoint = checkpointEnabled
    ? await runDaemonCheckpoint({
        ...laneRef(input),
        provider: input.provider,
        stateDir: input.checkpoint?.stateDir,
        keyFile: input.checkpoint?.keyFile,
        nodeId: input.signer.nodeId,
        actorId: input.signer.actorId,
        timestamp: input.checkpoint?.timestamp ?? new Date().toISOString(),
        modelId: input.checkpoint?.modelId ?? process.env.CONTINUITY_MODEL_ID ?? "agent-run",
        sessionId: input.checkpoint?.sessionId ?? process.env.CONTINUITY_SESSION_ID ?? `agent-run-${process.pid}`,
        source: input.checkpoint?.source ?? "agent-run",
        status: command.exitCode === 0 ? (input.checkpoint?.successStatus ?? "completed") : (input.checkpoint?.failureStatus ?? "blocked"),
        progress: `agent-run command exited with ${command.exitCode}`,
        files: command.stdout.trim() || command.stderr.trim() ? commandArtifacts(command.stdout, command.stderr).join("\n") : undefined,
        blocking: command.exitCode === 0 ? undefined : command.stderr.trim() || `exit code ${command.exitCode}`,
        next: input.checkpoint?.next ?? (command.exitCode === 0 ? "Continue with next queued task." : "Inspect failed agent-run output."),
      })
    : undefined;
  return { ...laneRef(input), orient, command: input.command, exitCode: command.exitCode, stdout: command.stdout, stderr: command.stderr, checkpoint };
}

function agentOrientWithSync(orient: AgentOrientResult, sync: PeerSyncResult): AgentOrientResult {
  const { prompt: _prompt, ...rest } = orient;
  const next = { ...rest, sync };
  return { ...next, prompt: renderAgentOrientation(next) };
}

export function validateAgentCommandPolicy(command: string, allowedCommands: string[] | undefined): void {
  if (!command.trim()) throw new Error("--command is required");
  if (allowedCommands?.length && !allowedCommands.some((allowed) => commandMatchesAllowedPrefix(command, allowed))) {
    throw new Error(`agent command is not in --allowed-commands`);
  }
}

function runShellCommand(
  command: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; outputLimit?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd: options.cwd, env: options.env, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    const outputLimit = options.outputLimit ?? DEFAULT_AGENT_RUN_OUTPUT_LIMIT;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, options.timeoutMs)
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
      stdout = appendLimited(stdout, chunk, outputLimit);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk, outputLimit);
    });
    child.once("error", (error) => settle(() => reject(error)));
    child.once("exit", (code, signal) => {
      settle(() => resolve({
        exitCode: timedOut ? 124 : code ?? (signal ? 128 : 1),
        stdout,
        stderr: timedOut ? appendLimited(stderr, `\ncommand timed out after ${options.timeoutMs}ms`, outputLimit) : stderr,
      }));
    });
  });
}

function appendLimited(current: string, chunk: string | Buffer, limit: number): string {
  const next = current + chunk.toString();
  if (next.length <= limit) return next;
  return next.slice(next.length - limit);
}

function commandArtifacts(stdout: string, stderr: string): string[] {
  const artifacts: string[] = [];
  if (stdout.trim()) artifacts.push(`stdout:\n${stdout.trim()}`);
  if (stderr.trim()) artifacts.push(`stderr:\n${stderr.trim()}`);
  return artifacts;
}

function commandMatchesAllowedPrefix(command: string, allowedPrefix: string): boolean {
  const normalizedCommand = command.trim();
  const normalizedAllowed = allowedPrefix.trim();
  return normalizedCommand === normalizedAllowed || normalizedCommand.startsWith(`${normalizedAllowed} `);
}

function laneOwnedBy(lane: LaneStatus["lane"], actor: ActorRef): boolean {
  return lane.owner?.nodeId === actor.nodeId && lane.owner.actorId === actor.actorId;
}

function laneRef(input: LaneRef): LaneRef {
  return { projectId: input.projectId, taskId: input.taskId, laneId: input.laneId };
}
