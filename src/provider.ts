import type {
  ActorRef,
  BootstrapPayload,
  CanonUpdatePayload,
  CheckpointPayload,
  ClaimLanePayload,
  ContinuitySigner,
  HandoffPayload,
  HeartbeatPayload,
  InventoryUpdatePayload,
  LaneRef,
  ReconcilePayload,
  ReleasePayload,
  TaskBlock,
  TaskBlockPayload,
  TaskBlockKind,
} from "./block.js";
import { createSignedTaskBlock, isSameLane } from "./block.js";
import { applyBlockToProjection, emptyLaneProjection, laneActionForActor, validateBlockTransition, type LaneProjection, type TransitionAction } from "./contract.js";

export interface ProviderHealth {
  ok: boolean;
  provider: string;
  version: 1;
}

export interface LaneStatusInput extends LaneRef {
  actor?: ActorRef;
  now?: string;
}

export interface LaneStatus {
  lane: LaneProjection;
  action: TransitionAction;
  reason?: string;
}

export interface ProviderSubmitResult {
  accepted: boolean;
  action: TransitionAction;
  lane: LaneProjection;
  block?: TaskBlock;
  rejection?: {
    code: string;
    message: string;
  };
}

export interface ProviderBlockInput<TPayload extends TaskBlockPayload = TaskBlockPayload> extends LaneRef {
  signer: ContinuitySigner;
  kind: TaskBlockKind;
  payload: TPayload;
  leaseEpoch?: number;
  expectedTip?: string;
  createdAt?: string;
}

export interface BootstrapLaneInput extends LaneRef {
  signer: ContinuitySigner;
  payload: BootstrapPayload;
  createdAt?: string;
}

export interface ClaimLaneInput extends LaneRef {
  signer: ContinuitySigner;
  reason?: string;
  leaseUntil?: string;
  expectedTip?: string;
  createdAt?: string;
  now?: string;
}

export interface HeartbeatInput extends LaneRef {
  signer: ContinuitySigner;
  leaseUntil: string;
  expectedTip?: string;
  createdAt?: string;
}

export interface CheckpointLaneInput extends LaneRef {
  signer: ContinuitySigner;
  payload: CheckpointPayload;
  expectedTip?: string;
  createdAt?: string;
}

export interface CanonUpdateInput extends LaneRef {
  signer: ContinuitySigner;
  payload: CanonUpdatePayload;
  expectedTip?: string;
  createdAt?: string;
}

export interface InventoryUpdateInput extends LaneRef {
  signer: ContinuitySigner;
  payload: InventoryUpdatePayload;
  expectedTip?: string;
  createdAt?: string;
}

export interface HandoffInput extends LaneRef {
  signer: ContinuitySigner;
  payload: HandoffPayload;
  expectedTip?: string;
  createdAt?: string;
}

export interface ReleaseLaneInput extends LaneRef {
  signer: ContinuitySigner;
  payload?: ReleasePayload;
  expectedTip?: string;
  createdAt?: string;
}

export interface ReconcileInput extends LaneRef {
  signer: ContinuitySigner;
  payload: ReconcilePayload;
  expectedTip?: string;
  createdAt?: string;
}

export interface ContinuityProvider {
  health(): Promise<ProviderHealth>;
  status(input: LaneStatusInput): Promise<LaneStatus>;
  blocks(ref: LaneRef): Promise<TaskBlock[]>;
  submitBlock(block: TaskBlock, options?: { now?: string }): Promise<ProviderSubmitResult>;
  bootstrap(input: BootstrapLaneInput): Promise<ProviderSubmitResult>;
  claimLane(input: ClaimLaneInput): Promise<ProviderSubmitResult>;
  heartbeat(input: HeartbeatInput): Promise<ProviderSubmitResult>;
  checkpoint(input: CheckpointLaneInput): Promise<ProviderSubmitResult>;
  updateCanon(input: CanonUpdateInput): Promise<ProviderSubmitResult>;
  updateInventory(input: InventoryUpdateInput): Promise<ProviderSubmitResult>;
  handoff(input: HandoffInput): Promise<ProviderSubmitResult>;
  release(input: ReleaseLaneInput): Promise<ProviderSubmitResult>;
  reconcile(input: ReconcileInput): Promise<ProviderSubmitResult>;
}

export abstract class BaseContinuityProvider implements ContinuityProvider {
  abstract health(): Promise<ProviderHealth>;
  abstract status(input: LaneStatusInput): Promise<LaneStatus>;
  abstract blocks(ref: LaneRef): Promise<TaskBlock[]>;
  abstract submitBlock(block: TaskBlock, options?: { now?: string }): Promise<ProviderSubmitResult>;

  async bootstrap(input: BootstrapLaneInput): Promise<ProviderSubmitResult> {
    return this.buildAndSubmit({
      ...input,
      kind: "bootstrap",
      payload: input.payload,
      leaseEpoch: 0,
    });
  }

  async claimLane(input: ClaimLaneInput): Promise<ProviderSubmitResult> {
    const { lane } = await this.status(input);
    if (lane.owner?.nodeId === input.signer.nodeId && lane.owner.actorId === input.signer.actorId) {
      return {
        accepted: false,
        action: "continue",
        lane,
        rejection: {
          code: "already_owner",
          message: "lane is already owned by this actor",
        },
      };
    }

    return this.buildAndSubmit(
      {
        ...input,
        kind: "claim_lane",
        leaseEpoch: lane.leaseEpoch + 1,
        payload: {
          reason: input.reason,
          leaseUntil: input.leaseUntil,
        } satisfies ClaimLanePayload,
      },
      { now: input.now },
    );
  }

  async heartbeat(input: HeartbeatInput): Promise<ProviderSubmitResult> {
    const { lane } = await this.status(input);
    return this.buildAndSubmit({
      ...input,
      kind: "heartbeat",
      leaseEpoch: lane.leaseEpoch,
      payload: {
        leaseUntil: input.leaseUntil,
      } satisfies HeartbeatPayload,
    });
  }

  async checkpoint(input: CheckpointLaneInput): Promise<ProviderSubmitResult> {
    const { lane } = await this.status(input);
    return this.buildAndSubmit({
      ...input,
      kind: "checkpoint",
      leaseEpoch: lane.leaseEpoch,
      payload: input.payload,
    });
  }

  async updateCanon(input: CanonUpdateInput): Promise<ProviderSubmitResult> {
    const { lane } = await this.status(input);
    return this.buildAndSubmit({
      ...input,
      kind: "canon_update",
      leaseEpoch: lane.leaseEpoch,
      payload: input.payload,
    });
  }

  async updateInventory(input: InventoryUpdateInput): Promise<ProviderSubmitResult> {
    const { lane } = await this.status(input);
    return this.buildAndSubmit({
      ...input,
      kind: "inventory_update",
      leaseEpoch: lane.leaseEpoch,
      payload: input.payload,
    });
  }

  async handoff(input: HandoffInput): Promise<ProviderSubmitResult> {
    const { lane } = await this.status(input);
    return this.buildAndSubmit({
      ...input,
      kind: "handoff",
      leaseEpoch: lane.leaseEpoch,
      payload: input.payload,
    });
  }

  async release(input: ReleaseLaneInput): Promise<ProviderSubmitResult> {
    const { lane } = await this.status(input);
    return this.buildAndSubmit({
      ...input,
      kind: "release",
      leaseEpoch: lane.leaseEpoch,
      payload: input.payload ?? {},
    });
  }

  async reconcile(input: ReconcileInput): Promise<ProviderSubmitResult> {
    const { lane } = await this.status(input);
    return this.buildAndSubmit({
      ...input,
      kind: "reconcile",
      leaseEpoch: lane.leaseEpoch,
      payload: input.payload,
    });
  }

  private async buildAndSubmit<TPayload extends TaskBlockPayload>(
    input: ProviderBlockInput<TPayload>,
    options: { now?: string } = {},
  ): Promise<ProviderSubmitResult> {
    const { lane } = await this.status(input);
    if (input.expectedTip !== undefined && input.expectedTip !== lane.tip) {
      return {
        accepted: false,
        action: "reconcile",
        lane,
        rejection: {
          code: "stale_parent_tip",
          message: `expected tip ${input.expectedTip}, current tip is ${lane.tip ?? "<empty>"}`,
        },
      };
    }

    const block = await createSignedTaskBlock(
      {
        projectId: input.projectId,
        taskId: input.taskId,
        laneId: input.laneId,
        kind: input.kind,
        parentTips: lane.tip ? [lane.tip] : [],
        leaseEpoch: input.leaseEpoch ?? lane.leaseEpoch,
        createdAt: input.createdAt,
        payload: input.payload,
      },
      input.signer,
    );
    return this.submitBlock(block, options);
  }
}

export class MemoryProvider extends BaseContinuityProvider {
  private readonly blockById = new Map<string, TaskBlock>();
  private readonly laneBlockIds = new Map<string, string[]>();
  private readonly laneByKey = new Map<string, LaneProjection>();

  async health(): Promise<ProviderHealth> {
    return { ok: true, provider: "memory", version: 1 };
  }

  async status(input: LaneStatusInput): Promise<LaneStatus> {
    const lane = this.currentLane(input);
    const action = input.actor ? laneActionForActor(lane, input.actor, input.now) : "continue";
    const reason = action === "pause" && lane.owner ? `lane is owned by ${lane.owner.nodeId}/${lane.owner.actorId}` : undefined;
    return { lane, action, reason };
  }

  async blocks(ref: LaneRef): Promise<TaskBlock[]> {
    return (this.laneBlockIds.get(laneKey(ref)) ?? [])
      .map((blockId) => this.blockById.get(blockId))
      .filter((block): block is TaskBlock => Boolean(block))
      .map(cloneBlock);
  }

  async submitBlock(block: TaskBlock, options: { now?: string } = {}): Promise<ProviderSubmitResult> {
    if (this.blockById.has(block.blockId)) {
      return {
        accepted: true,
        action: "continue",
        lane: this.currentLane(block),
        block: cloneBlock(block),
      };
    }

    const current = this.currentLane(block);
    const result = validateBlockTransition(block, {
      current: current.tip ? current : undefined,
      hasBlock: (blockId) => this.blockById.has(blockId),
      now: options.now,
    });
    if (!result.ok) {
      return {
        accepted: false,
        action: result.action,
        lane: current,
        rejection: {
          code: result.code,
          message: result.message,
        },
      };
    }

    const lane = applyBlockToProjection(current.tip ? current : undefined, block);
    this.blockById.set(block.blockId, block);
    this.laneByKey.set(laneKey(block), lane);
    this.laneBlockIds.set(laneKey(block), [...(this.laneBlockIds.get(laneKey(block)) ?? []), block.blockId]);
    return {
      accepted: true,
      action: "continue",
      lane,
      block: cloneBlock(block),
    };
  }

  private currentLane(ref: LaneRef): LaneProjection {
    const current = this.laneByKey.get(laneKey(ref));
    if (current) return cloneLane(current);
    return emptyLaneProjection(ref);
  }
}

export function laneKey(ref: LaneRef): string {
  return `${ref.projectId}\0${ref.taskId}\0${ref.laneId}`;
}

export function assertLaneRef(ref: LaneRef, other: LaneRef): void {
  if (!isSameLane(ref, other)) {
    throw new Error(`lane mismatch: expected ${ref.projectId}/${ref.taskId}/${ref.laneId}, got ${other.projectId}/${other.taskId}/${other.laneId}`);
  }
}

function cloneLane(lane: LaneProjection): LaneProjection {
  return structuredClone(lane);
}

function cloneBlock(block: TaskBlock): TaskBlock {
  return structuredClone(block);
}
