import type { ActorRef, CanonUpdatePayload, CheckpointPayload, HandoffPayload, InventoryUpdatePayload, LaneRef, LaneSnapshotPayload, ReconcilePayload, TaskBlock } from "./block.js";
import { isSameLane, validateTaskBlock } from "./block.js";

export interface LaneOwner extends ActorRef {
  leaseEpoch: number;
  leaseUntil?: string;
}

export interface LaneProjection extends LaneRef {
  tip?: string;
  heads?: string[];
  leaseEpoch: number;
  owner?: LaneOwner;
  canonMarkdown?: string;
  inventoryMarkdown?: string;
  checkpoint?: {
    status: string;
    progress: string;
    files?: string;
    blocking?: string;
    next?: string;
  };
  updatedAt?: string;
}

export type TransitionRejectionCode =
  | "duplicate_tip"
  | "invalid_block"
  | "lane_exists"
  | "lane_missing"
  | "not_lane_owner"
  | "owner_active"
  | "stale_lease_epoch"
  | "stale_parent_tip"
  | "unknown_parent_tip";

export type TransitionAction = "continue" | "pause" | "reconcile";

export type TransitionValidationResult =
  | { ok: true; action: "continue" }
  | {
      ok: false;
      action: TransitionAction;
      code: TransitionRejectionCode;
      message: string;
    };

export interface TransitionContext {
  current?: LaneProjection;
  hasBlock(blockId: string): boolean;
  now?: string;
  leaseGraceMs?: number;
}

const DEFAULT_LEASE_GRACE_MS = 30_000;

export function emptyLaneProjection(ref: LaneRef): LaneProjection {
  return { ...ref, leaseEpoch: 0 };
}

export function validateBlockTransition(block: TaskBlock, context: TransitionContext): TransitionValidationResult {
  const shape = validateTaskBlock(block);
  if (!shape.ok) {
    return reject("reconcile", "invalid_block", shape.issues.map((entry) => `${entry.code}: ${entry.message}`).join("; "));
  }

  const current = context.current;
  if (current && !isSameLane(block, current)) {
    return reject("reconcile", "invalid_block", "block lane does not match transition context");
  }
  if (block.kind !== "lane_snapshot" && block.parentTips.some((tip) => !context.hasBlock(tip))) {
    return reject("reconcile", "unknown_parent_tip", "block references a parent tip that is not known locally");
  }

  switch (block.kind) {
    case "bootstrap":
      return validateBootstrap(block, current);
    case "claim_lane":
      return validateClaim(block, current, context);
    case "heartbeat":
      return validateOwnedTipBlock(block, current, "heartbeat");
    case "checkpoint":
    case "canon_update":
      return validateOwnedTipBlock(block, current, block.kind);
    case "inventory_update":
      return validateTipExtendingBlock(block, current, "inventory_update");
    case "handoff":
      return validateOwnedTipBlock(block, current, "handoff");
    case "release":
      return validateOwnedTipBlock(block, current, "release");
    case "pause":
      return validateTipExtendingBlock(block, current, "pause");
    case "reconcile":
      return validateReconcile(block, current, context);
    case "lane_snapshot":
      return validateLaneSnapshot(block, current);
    case "task_intent":
    case "worker_profile":
    case "task_assignment":
    case "task_result":
    case "task_adjudication":
      return validateSchedulerBlock(block, current, block.kind);
  }
}

export function applyBlockToProjection(current: LaneProjection | undefined, block: TaskBlock): LaneProjection {
  const next: LaneProjection = {
    ...(current ?? emptyLaneProjection(block)),
    tip: block.blockId,
    heads: nextHeads(current, block),
    leaseEpoch: Math.max(current?.leaseEpoch ?? 0, block.leaseEpoch),
    updatedAt: block.createdAt,
  };

  switch (block.kind) {
    case "bootstrap":
      next.canonMarkdown = stringPayload(block.payload, "canonMarkdown") ?? next.canonMarkdown;
      next.inventoryMarkdown = stringPayload(block.payload, "inventoryMarkdown") ?? next.inventoryMarkdown;
      break;
    case "claim_lane":
      next.owner = {
        nodeId: block.nodeId,
        actorId: block.actorId,
        leaseEpoch: block.leaseEpoch,
        leaseUntil: stringPayload(block.payload, "leaseUntil"),
      };
      break;
    case "heartbeat":
      next.owner = {
        nodeId: block.nodeId,
        actorId: block.actorId,
        leaseEpoch: block.leaseEpoch,
        leaseUntil: stringPayload(block.payload, "leaseUntil"),
      };
      break;
    case "checkpoint": {
      const payload = block.payload as CheckpointPayload;
      next.checkpoint = {
        status: payload.status,
        progress: payload.progress,
        files: payload.files,
        blocking: payload.blocking,
        next: payload.next,
      };
      if (payload.canonMarkdown) next.canonMarkdown = payload.canonMarkdown;
      break;
    }
    case "canon_update":
      next.canonMarkdown = (block.payload as CanonUpdatePayload).canonMarkdown;
      break;
    case "inventory_update":
      next.inventoryMarkdown = (block.payload as InventoryUpdatePayload).inventoryMarkdown;
      break;
    case "handoff": {
      const payload = block.payload as HandoffPayload;
      next.owner = {
        nodeId: payload.targetNodeId ?? block.nodeId,
        actorId: payload.targetActorId,
        leaseEpoch: block.leaseEpoch,
        leaseUntil: payload.leaseUntil,
      };
      break;
    }
    case "release":
      delete next.owner;
      break;
    case "pause":
      break;
    case "reconcile": {
      const payload = block.payload as ReconcilePayload;
      if (payload.canonMarkdown) next.canonMarkdown = payload.canonMarkdown;
      if (payload.inventoryMarkdown) next.inventoryMarkdown = payload.inventoryMarkdown;
      break;
    }
    case "lane_snapshot": {
      const payload = block.payload as LaneSnapshotPayload;
      if (payload.canonMarkdown) next.canonMarkdown = payload.canonMarkdown;
      if (payload.inventoryMarkdown) next.inventoryMarkdown = payload.inventoryMarkdown;
      if (payload.checkpoint) {
        next.checkpoint = {
          status: payload.checkpoint.status,
          progress: payload.checkpoint.progress,
          files: payload.checkpoint.files,
          blocking: payload.checkpoint.blocking,
          next: payload.checkpoint.next,
        };
      }
      if (payload.owner) next.owner = { ...payload.owner };
      next.heads = [block.blockId];
      break;
    }
    case "task_intent":
    case "worker_profile":
    case "task_assignment":
    case "task_result":
    case "task_adjudication":
      break;
  }

  return next;
}

export function laneActionForActor(lane: LaneProjection, actor: ActorRef, now = new Date().toISOString(), leaseGraceMs = DEFAULT_LEASE_GRACE_MS): TransitionAction {
  if (!lane.owner) return "continue";
  if (isSameActor(lane.owner, actor)) return "continue";
  return ownerLeaseExpired(lane.owner, now, leaseGraceMs) ? "continue" : "pause";
}

export function isSameActor(left: ActorRef, right: ActorRef): boolean {
  return left.nodeId === right.nodeId && left.actorId === right.actorId;
}

function validateBootstrap(block: TaskBlock, current: LaneProjection | undefined): TransitionValidationResult {
  if (current?.tip) return reject("reconcile", "lane_exists", "bootstrap is only valid for an empty lane");
  if (block.leaseEpoch !== 0) return reject("reconcile", "stale_lease_epoch", "bootstrap leaseEpoch must be 0");
  return validateParentTips(block, undefined);
}

function validateClaim(block: TaskBlock, current: LaneProjection | undefined, context: TransitionContext): TransitionValidationResult {
  const parent = validateParentTips(block, current);
  if (!parent.ok) return parent;

  if (!current?.tip || !current.owner) {
    const expectedEpoch = (current?.leaseEpoch ?? 0) + 1;
    return block.leaseEpoch === expectedEpoch
      ? accept()
      : reject("reconcile", "stale_lease_epoch", `claim_lane leaseEpoch must be ${expectedEpoch}`);
  }

  if (isSameActor(current.owner, block)) {
    return block.leaseEpoch === current.leaseEpoch
      ? accept()
      : reject("reconcile", "stale_lease_epoch", `current owner must keep leaseEpoch ${current.leaseEpoch}`);
  }

  if (!ownerLeaseExpired(current.owner, context.now ?? new Date().toISOString(), context.leaseGraceMs ?? DEFAULT_LEASE_GRACE_MS)) {
    return reject("pause", "owner_active", `lane is owned by ${current.owner.nodeId}/${current.owner.actorId}`);
  }

  const expectedEpoch = current.leaseEpoch + 1;
  return block.leaseEpoch === expectedEpoch
    ? accept()
    : reject("reconcile", "stale_lease_epoch", `takeover claim leaseEpoch must be ${expectedEpoch}`);
}

function validateOwnedTipBlock(block: TaskBlock, current: LaneProjection | undefined, kind: string): TransitionValidationResult {
  const parent = validateTipExtendingBlock(block, current, kind);
  if (!parent.ok) return parent;
  if (!current?.owner) return reject("pause", "lane_missing", `${kind} requires an active lane owner`);
  if (!isSameActor(current.owner, block)) return reject("pause", "not_lane_owner", `${kind} signer is not the current lane owner`);
  if (block.leaseEpoch !== current.leaseEpoch) {
    return reject("reconcile", "stale_lease_epoch", `${kind} leaseEpoch ${block.leaseEpoch} does not match current epoch ${current.leaseEpoch}`);
  }
  return accept();
}

function validateTipExtendingBlock(block: TaskBlock, current: LaneProjection | undefined, kind: string): TransitionValidationResult {
  if (!current?.tip) return reject("reconcile", "lane_missing", `${kind} requires an existing lane tip`);
  if (currentHeads(current).includes(block.blockId)) return reject("continue", "duplicate_tip", `${kind} block is already a current head`);
  return validateCurrentHeadParentTips(block, current);
}

function validateLaneSnapshot(block: TaskBlock, current: LaneProjection | undefined): TransitionValidationResult {
  if (!current?.tip) return accept();
  const parent = validateCurrentHeadParentTips(block, current);
  if (!parent.ok) return parent;
  if (current.owner && !isSameActor(current.owner, block)) {
    return reject("pause", "not_lane_owner", "lane_snapshot signer is not the current lane owner");
  }
  if (block.leaseEpoch !== current.leaseEpoch) {
    return reject("reconcile", "stale_lease_epoch", `lane_snapshot leaseEpoch ${block.leaseEpoch} does not match current epoch ${current.leaseEpoch}`);
  }
  return accept();
}

function validateReconcile(block: TaskBlock, current: LaneProjection | undefined, context: TransitionContext): TransitionValidationResult {
  const parent = validateTipExtendingBlock(block, current, "reconcile");
  if (!parent.ok) return parent;
  const payload = block.payload as ReconcilePayload;
  const unknown = payload.conflictingTips.filter((tip) => !context.hasBlock(tip));
  if (unknown.length > 0) return reject("reconcile", "unknown_parent_tip", `reconcile references unknown tips: ${unknown.join(", ")}`);
  return accept();
}

function validateParentTips(block: TaskBlock, current: LaneProjection | undefined): TransitionValidationResult {
  const expected = current?.tip ? [current.tip] : [];
  if (block.parentTips.length !== expected.length || block.parentTips.some((tip, index) => tip !== expected[index])) {
    return reject("reconcile", "stale_parent_tip", `parentTips must equal current tip ${expected[0] ?? "<empty>"}`);
  }
  return accept();
}

function validateCurrentHeadParentTips(block: TaskBlock, current: LaneProjection | undefined): TransitionValidationResult {
  const heads = currentHeads(current);
  if (heads.length === 0) {
    return block.parentTips.length === 0
      ? accept()
      : reject("reconcile", "stale_parent_tip", "parentTips must equal current heads <empty>");
  }
  if (block.parentTips.length === 0) {
    return reject("reconcile", "stale_parent_tip", `parentTips must include a current head: ${heads.join(", ")}`);
  }
  const unknownHeads = block.parentTips.filter((tip) => !heads.includes(tip));
  if (unknownHeads.length > 0) {
    return reject("reconcile", "stale_parent_tip", `parentTips must reference current heads: ${heads.join(", ")}`);
  }
  return accept();
}

function validateSchedulerBlock(block: TaskBlock, current: LaneProjection | undefined, kind: string): TransitionValidationResult {
  if (!current?.tip) return reject("reconcile", "lane_missing", `${kind} requires an existing lane tip`);
  if (currentHeads(current).includes(block.blockId)) return reject("continue", "duplicate_tip", `${kind} block is already a current head`);
  if (block.parentTips.length === 0) return reject("reconcile", "stale_parent_tip", `${kind} requires at least one known parent tip`);
  return accept();
}

function currentHeads(current: LaneProjection | undefined): string[] {
  if (!current) return [];
  if (current.heads?.length) return [...current.heads];
  return current.tip ? [current.tip] : [];
}

function nextHeads(current: LaneProjection | undefined, block: TaskBlock): string[] {
  const parentTips = new Set(block.parentTips);
  const next = currentHeads(current).filter((tip) => !parentTips.has(tip));
  next.push(block.blockId);
  return [...new Set(next)];
}

function ownerLeaseExpired(owner: LaneOwner, now: string, leaseGraceMs: number): boolean {
  if (!owner.leaseUntil) return false;
  return Date.parse(owner.leaseUntil) + leaseGraceMs < Date.parse(now);
}

function stringPayload(payload: TaskBlock["payload"], field: string): string | undefined {
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function accept(): TransitionValidationResult {
  return { ok: true, action: "continue" };
}

function reject(action: TransitionAction, code: TransitionRejectionCode, message: string): TransitionValidationResult & { ok: false } {
  return { ok: false, action, code, message };
}
