import type { CheckpointPayload, ContinuitySigner, LaneRef, TaskBlock } from "./block.js";
import { assertCanonTaskId, idempotencyKeyFor, renderDefaultCanon, withLastReconciled } from "./markdown.js";
import type { ContinuityProvider, LaneStatus, ProviderSubmitResult } from "./provider.js";
import { loadOrCreateNodeSigner } from "./signer-store.js";
import type { CheckpointInput } from "./types.js";

const DEFAULT_ACTOR_ID = "agent-cli";
const DEFAULT_LEASE_MS = 10 * 60 * 1000;

export interface DaemonWorkflowIdentity {
  stateDir?: string;
  keyFile?: string;
  nodeId?: string;
  actorId?: string;
}

export interface DaemonCheckpointInput extends CheckpointInput, LaneRef, DaemonWorkflowIdentity {
  provider: ContinuityProvider;
  leaseUntil?: string;
}

export interface DaemonCheckpointResult extends LaneRef {
  appended: boolean;
  blockId?: string;
  finalTip?: string;
  keyPath: string;
  keyCreated: boolean;
  actor: {
    nodeId: string;
    actorId: string;
  };
}

export interface DaemonResumeInput extends LaneRef {
  provider: ContinuityProvider;
}

export interface DaemonResumeResult extends LaneRef {
  canonMarkdown: string | null;
  tip?: string;
}

export async function runDaemonCheckpoint(input: DaemonCheckpointInput): Promise<DaemonCheckpointResult> {
  const lane = laneRef(input);
  const initialSigner = await loadOrCreateNodeSigner({
    keyPath: input.keyFile,
    stateDir: input.stateDir,
    nodeId: input.nodeId,
    actorId: input.actorId ?? process.env.CONTINUITY_ACTOR_ID ?? DEFAULT_ACTOR_ID,
  });
  const status = await input.provider.status({ ...lane, actor: initialSigner.signer });
  const signerState = await signerForStatus(input, initialSigner, status);

  const idempotencyKey = idempotencyKeyFor(input);
  const existing = await findCheckpointByIdempotencyKey(input.provider, lane, idempotencyKey);
  if (existing) {
    const current = await input.provider.status({ ...lane, actor: signerState.signer });
    return {
      ...lane,
      appended: false,
      blockId: existing.blockId,
      finalTip: current.lane.tip,
      keyPath: signerState.keyPath,
      keyCreated: signerState.created,
      actor: { nodeId: signerState.signer.nodeId, actorId: signerState.signer.actorId },
    };
  }

  const ready = await ensureWritableLane(input.provider, lane, signerState.signer, input);
  const canonMarkdown = normalizedCanon(input);
  const checkpoint = await submitRequired(
    await input.provider.checkpoint({
      ...lane,
      signer: signerState.signer,
      expectedTip: ready.lane.tip,
      createdAt: input.timestamp,
      payload: {
        status: input.status,
        progress: input.progress,
        files: input.files,
        blocking: input.blocking,
        next: input.next,
        canonMarkdown,
        modelId: input.modelId,
        sessionId: input.sessionId,
        source: input.source ?? "daemon-cli",
        idempotencyKey,
      } satisfies CheckpointPayload,
    }),
    "checkpoint",
  );

  return {
    ...lane,
    appended: true,
    blockId: checkpoint.block?.blockId,
    finalTip: checkpoint.lane.tip,
    keyPath: signerState.keyPath,
    keyCreated: signerState.created,
    actor: { nodeId: signerState.signer.nodeId, actorId: signerState.signer.actorId },
  };
}

export async function readDaemonCanon(input: DaemonResumeInput): Promise<DaemonResumeResult> {
  const lane = laneRef(input);
  const status = await input.provider.status(lane);
  return {
    ...lane,
    canonMarkdown: status.lane.canonMarkdown ?? null,
    tip: status.lane.tip,
  };
}

async function signerForStatus(
  input: DaemonWorkflowIdentity,
  initial: Awaited<ReturnType<typeof loadOrCreateNodeSigner>>,
  status: LaneStatus,
): Promise<Awaited<ReturnType<typeof loadOrCreateNodeSigner>>> {
  if (input.actorId) return initial;
  const owner = status.lane.owner;
  if (!owner || owner.nodeId !== initial.signer.nodeId || owner.actorId === initial.signer.actorId) return initial;
  return loadOrCreateNodeSigner({
    keyPath: input.keyFile,
    stateDir: input.stateDir,
    nodeId: initial.signer.nodeId,
    actorId: owner.actorId,
  });
}

async function ensureWritableLane(
  provider: ContinuityProvider,
  lane: LaneRef,
  signer: ContinuitySigner,
  input: DaemonCheckpointInput,
): Promise<LaneStatus> {
  let status = await provider.status({ ...lane, actor: signer, now: input.timestamp });
  if (status.action === "pause") throw new Error(status.reason ?? `lane is owned by another actor`);

  if (!status.lane.tip) {
    const bootstrap = await submitRequired(
      await provider.bootstrap({
        ...lane,
        signer,
        createdAt: input.timestamp,
        payload: {
          summary: `Initialized ${input.taskId} from daemon checkpoint.`,
          canonMarkdown: normalizedCanon(input),
        },
      }),
      "bootstrap",
    );
    status = { lane: bootstrap.lane, action: "continue" };
  }

  const owner = status.lane.owner;
  if (!owner || owner.nodeId !== signer.nodeId || owner.actorId !== signer.actorId) {
    const claim = await submitRequired(
      await provider.claimLane({
        ...lane,
        signer,
        expectedTip: status.lane.tip,
        createdAt: input.timestamp,
        now: input.timestamp,
        leaseUntil: input.leaseUntil ?? defaultLeaseUntil(input.timestamp),
        reason: "daemon checkpoint",
      }),
      "claim_lane",
    );
    status = { lane: claim.lane, action: "continue" };
  }

  return status;
}

function normalizedCanon(input: CheckpointInput): string {
  const canonMarkdown = input.canonMarkdown ?? renderDefaultCanon({ ...input, source: input.source ?? "daemon-cli" });
  assertCanonTaskId(canonMarkdown, input.taskId);
  return withLastReconciled(canonMarkdown, input.timestamp);
}

async function findCheckpointByIdempotencyKey(provider: ContinuityProvider, lane: LaneRef, idempotencyKey: string): Promise<TaskBlock | null> {
  const blocks = await provider.blocks(lane);
  return blocks.find((block) => block.kind === "checkpoint" && (block.payload as CheckpointPayload).idempotencyKey === idempotencyKey) ?? null;
}

function defaultLeaseUntil(timestamp: string): string {
  const base = Date.parse(timestamp);
  return new Date((Number.isFinite(base) ? base : Date.now()) + DEFAULT_LEASE_MS).toISOString();
}

async function submitRequired(result: ProviderSubmitResult, label: string): Promise<ProviderSubmitResult> {
  if (!result.accepted || !result.block) {
    const reason = result.rejection ? `${result.rejection.code}: ${result.rejection.message}` : "missing accepted block";
    throw new Error(`daemon ${label} was rejected: ${reason}`);
  }
  return result;
}

function laneRef(input: LaneRef): LaneRef {
  return {
    projectId: input.projectId,
    taskId: input.taskId,
    laneId: input.laneId,
  };
}
