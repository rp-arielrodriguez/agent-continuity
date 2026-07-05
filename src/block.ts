import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import type { CheckpointStatus } from "./types.js";

export const TASK_BLOCK_VERSION = 1;
export const SIGNATURE_SCHEME = "ed25519";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type TaskBlockKind =
  | "bootstrap"
  | "claim_lane"
  | "heartbeat"
  | "checkpoint"
  | "canon_update"
  | "inventory_update"
  | "handoff"
  | "release"
  | "pause"
  | "reconcile"
  | "task_intent"
  | "worker_profile"
  | "task_assignment"
  | "task_result";

const TASK_BLOCK_KINDS = new Set<string>([
  "bootstrap",
  "claim_lane",
  "heartbeat",
  "checkpoint",
  "canon_update",
  "inventory_update",
  "handoff",
  "release",
  "pause",
  "reconcile",
  "task_intent",
  "worker_profile",
  "task_assignment",
  "task_result",
]);

const CHECKPOINT_STATUSES = new Set<string>(["pending", "in_progress", "blocked", "completed", "cancelled"]);
const TASK_POLICIES = new Set<string>(["exclusive", "speculative"]);
const TASK_ASSIGNMENT_MODES = new Set<string>(["manual", "automatic"]);
const TASK_RESULT_STATUSES = new Set<string>(["completed", "failed", "blocked", "cancelled"]);

export interface LaneRef {
  projectId: string;
  taskId: string;
  laneId: string;
}

export interface ActorRef {
  nodeId: string;
  actorId: string;
}

export interface BlockSignature {
  scheme: typeof SIGNATURE_SCHEME;
  publicKey: string;
  value: string;
}

export interface TaskBlock<TPayload extends TaskBlockPayload = TaskBlockPayload> extends LaneRef, ActorRef {
  version: typeof TASK_BLOCK_VERSION;
  blockId: string;
  kind: TaskBlockKind;
  parentTips: string[];
  leaseEpoch: number;
  createdAt: string;
  payloadHash: string;
  payload: TPayload;
  signature: BlockSignature;
}

export type TaskBlockPayload =
  | BootstrapPayload
  | ClaimLanePayload
  | HeartbeatPayload
  | CheckpointPayload
  | CanonUpdatePayload
  | InventoryUpdatePayload
  | HandoffPayload
  | ReleasePayload
  | PausePayload
  | ReconcilePayload
  | TaskIntentPayload
  | WorkerProfilePayload
  | TaskAssignmentPayload
  | TaskResultPayload;

export interface BootstrapPayload {
  summary: string;
  canonMarkdown?: string;
  inventoryMarkdown?: string;
  importedFrom?: string;
}

export interface ClaimLanePayload {
  reason?: string;
  leaseUntil?: string;
}

export interface HeartbeatPayload {
  leaseUntil: string;
}

export interface CheckpointPayload {
  status: CheckpointStatus;
  progress: string;
  files?: string;
  blocking?: string;
  next?: string;
  canonMarkdown?: string;
  modelId?: string;
  sessionId?: string;
  source?: string;
  idempotencyKey?: string;
}

export interface CanonUpdatePayload {
  canonMarkdown: string;
  summary?: string;
}

export interface InventoryUpdatePayload {
  inventoryMarkdown: string;
  summary?: string;
}

export interface HandoffPayload {
  targetNodeId?: string;
  targetActorId: string;
  leaseUntil?: string;
}

export interface ReleasePayload {
  reason?: string;
}

export interface PausePayload {
  reason: string;
  observedTip?: string;
  observedActorId?: string;
}

export interface ReconcilePayload {
  summary: string;
  conflictingTips: string[];
  canonMarkdown?: string;
  inventoryMarkdown?: string;
}

export interface TaskIntentRequirements {
  agents?: string[];
  modelFamilies?: string[];
  models?: string[];
  tools?: string[];
}

export interface TaskIntentPayload {
  title: string;
  instructions: string;
  targetLaneId?: string;
  policy?: "exclusive" | "speculative";
  priority?: number;
  requirements?: TaskIntentRequirements;
  idempotencyKey?: string;
}

export interface WorkerProfilePayload {
  workerId: string;
  agent: string;
  modelFamilies?: string[];
  models?: string[];
  tools?: string[];
  maxConcurrent?: number;
  tmuxSession?: string;
  endpoint?: string;
  enabled?: boolean;
}

export interface TaskAssignmentPayload {
  intentBlockId: string;
  workerId: string;
  assignedLaneId: string;
  mode?: "manual" | "automatic";
  leaseUntil?: string;
}

export interface TaskResultPayload {
  intentBlockId: string;
  assignmentBlockId?: string;
  workerId: string;
  status: "completed" | "failed" | "blocked" | "cancelled";
  summary: string;
  artifacts?: string[];
  exitCode?: number;
  startedAt?: string;
  completedAt?: string;
  tmuxSession?: string;
}

export interface ContinuitySigner extends ActorRef {
  publicKey: string;
  sign(bytes: Uint8Array): Promise<string>;
}

export interface Ed25519KeyPairDer {
  privateKeyDer: string;
  publicKeyDer: string;
}

export interface CreateTaskBlockInput<TPayload extends TaskBlockPayload = TaskBlockPayload> extends LaneRef {
  kind: TaskBlockKind;
  parentTips?: string[];
  leaseEpoch: number;
  createdAt?: string;
  payload: TPayload;
}

export type BlockValidationCode =
  | "invalid_block_id"
  | "invalid_created_at"
  | "invalid_identifier"
  | "invalid_kind_payload"
  | "invalid_lease_epoch"
  | "invalid_parent_tips"
  | "invalid_payload_hash"
  | "invalid_signature"
  | "invalid_version";

export interface BlockValidationIssue {
  code: BlockValidationCode;
  message: string;
}

export interface BlockValidationResult {
  ok: boolean;
  issues: BlockValidationIssue[];
}

type UnsignedTaskBlock<TPayload extends TaskBlockPayload = TaskBlockPayload> = Omit<TaskBlock<TPayload>, "blockId" | "signature"> & {
  signerPublicKey: string;
};

export function generateEd25519KeyPairDer(): Ed25519KeyPairDer {
  const keyPair = generateKeyPairSync("ed25519");
  return {
    privateKeyDer: keyPair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    publicKeyDer: keyPair.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
  };
}

export function createEd25519Signer(input: ActorRef & { privateKeyDer?: string; publicKeyDer?: string }): ContinuitySigner {
  const keyPair = input.privateKeyDer
    ? {
        privateKey: createPrivateKey({ key: Buffer.from(input.privateKeyDer, "base64url"), format: "der", type: "pkcs8" }),
        publicKey: createPublicKey({ key: Buffer.from(requiredPublicKey(input), "base64url"), format: "der", type: "spki" }),
      }
    : generateKeyPairSync("ed25519");

  const publicKey = keyPair.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  return {
    nodeId: input.nodeId,
    actorId: input.actorId,
    publicKey,
    async sign(bytes: Uint8Array): Promise<string> {
      return sign(null, Buffer.from(bytes), keyPair.privateKey).toString("base64url");
    },
  };
}

export async function createSignedTaskBlock<TPayload extends TaskBlockPayload>(
  input: CreateTaskBlockInput<TPayload>,
  signer: ContinuitySigner,
): Promise<TaskBlock<TPayload>> {
  const payload = normalizePayload(input.kind, input.payload) as TPayload;
  const unsigned: UnsignedTaskBlock<TPayload> = {
    version: TASK_BLOCK_VERSION,
    projectId: input.projectId,
    taskId: input.taskId,
    laneId: input.laneId,
    kind: input.kind,
    parentTips: input.parentTips ?? [],
    nodeId: signer.nodeId,
    actorId: signer.actorId,
    leaseEpoch: input.leaseEpoch,
    createdAt: input.createdAt ?? new Date().toISOString(),
    payloadHash: hashJson(payload),
    payload,
    signerPublicKey: signer.publicKey,
  };
  const signatureValue = await signer.sign(bytesForSigning(unsigned));
  const blockWithoutId: Omit<TaskBlock<TPayload>, "blockId"> = {
    ...omitSignerPublicKey(unsigned),
    signature: {
      scheme: SIGNATURE_SCHEME,
      publicKey: signer.publicKey,
      value: signatureValue,
    },
  };
  return {
    blockId: blockIdFor(blockWithoutId),
    ...blockWithoutId,
  };
}

export function validateTaskBlock(block: TaskBlock): BlockValidationResult {
  const issues: BlockValidationIssue[] = [];
  if (block.version !== TASK_BLOCK_VERSION) issues.push(issue("invalid_version", `unsupported task block version ${String(block.version)}`));
  if (!TASK_BLOCK_KINDS.has(block.kind)) issues.push(issue("invalid_kind_payload", `unsupported task block kind ${String(block.kind)}`));
  for (const [field, value] of [
    ["blockId", block.blockId],
    ["projectId", block.projectId],
    ["taskId", block.taskId],
    ["laneId", block.laneId],
    ["nodeId", block.nodeId],
    ["actorId", block.actorId],
  ] as const) {
    if (!isIdentifier(value)) issues.push(issue("invalid_identifier", `${field} must be a non-empty continuity identifier`));
  }
  if (!Number.isSafeInteger(block.leaseEpoch) || block.leaseEpoch < 0) {
    issues.push(issue("invalid_lease_epoch", "leaseEpoch must be a non-negative safe integer"));
  }
  if (!isIsoDate(block.createdAt)) issues.push(issue("invalid_created_at", "createdAt must be an ISO timestamp"));
  if (!Array.isArray(block.parentTips) || block.parentTips.some((tip) => !isBlockId(tip))) {
    issues.push(issue("invalid_parent_tips", "parentTips must contain valid block ids"));
  }

  const payloadResult = validatePayload(block.kind, block.payload);
  issues.push(...payloadResult.issues);

  try {
    if (block.payloadHash !== hashJson(block.payload)) {
      issues.push(issue("invalid_payload_hash", "payloadHash does not match canonical payload"));
    }
  } catch {
    issues.push(issue("invalid_payload_hash", "payloadHash cannot be computed from payload"));
  }
  try {
    if (block.blockId !== blockIdFor(block)) {
      issues.push(issue("invalid_block_id", "blockId does not match canonical signed block"));
    }
  } catch {
    issues.push(issue("invalid_block_id", "blockId cannot be computed from block content"));
  }
  if (!verifyBlockSignature(block)) {
    issues.push(issue("invalid_signature", "signature does not verify canonical unsigned block content"));
  }

  return { ok: issues.length === 0, issues };
}

export function verifyBlockSignature(block: TaskBlock): boolean {
  if (block.signature?.scheme !== SIGNATURE_SCHEME || !block.signature.publicKey || !block.signature.value) return false;
  try {
    const key = publicKeyFromBase64Url(block.signature.publicKey);
    return verify(null, bytesForSigning(toUnsigned(block)), key, Buffer.from(block.signature.value, "base64url"));
  } catch {
    return false;
  }
}

export function hashJson(value: unknown): string {
  return `sha256:${sha256(canonicalJson(value))}`;
}

export function blockIdFor(block: Omit<TaskBlock, "blockId"> | TaskBlock): string {
  const { blockId: _blockId, ...content } = block as TaskBlock;
  return `blk_${sha256(canonicalJson(content))}`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function isBlockId(value: string): boolean {
  return /^blk_[a-f0-9]{64}$/.test(value);
}

export function isSameLane(left: LaneRef, right: LaneRef): boolean {
  return left.projectId === right.projectId && left.taskId === right.taskId && left.laneId === right.laneId;
}

function toUnsigned<TPayload extends TaskBlockPayload>(block: TaskBlock<TPayload>): UnsignedTaskBlock<TPayload> {
  return {
    version: block.version,
    projectId: block.projectId,
    taskId: block.taskId,
    laneId: block.laneId,
    kind: block.kind,
    parentTips: block.parentTips,
    nodeId: block.nodeId,
    actorId: block.actorId,
    leaseEpoch: block.leaseEpoch,
    createdAt: block.createdAt,
    payloadHash: block.payloadHash,
    payload: block.payload,
    signerPublicKey: block.signature.publicKey,
  };
}

function omitSignerPublicKey<TPayload extends TaskBlockPayload>(block: UnsignedTaskBlock<TPayload>): Omit<TaskBlock<TPayload>, "blockId" | "signature"> {
  const { signerPublicKey: _signerPublicKey, ...rest } = block;
  return rest;
}

function bytesForSigning(block: UnsignedTaskBlock): Uint8Array {
  return Buffer.from(canonicalJson(block), "utf8");
}

function normalizePayload(kind: TaskBlockKind, payload: TaskBlockPayload): JsonValue {
  const copy = compactObject(payload as Record<string, unknown>);
  const result = validatePayload(kind, copy as TaskBlockPayload);
  if (!result.ok) throw new Error(`invalid ${kind} payload: ${result.issues.map((entry) => entry.message).join("; ")}`);
  return copy;
}

function validatePayload(kind: TaskBlockKind, payload: TaskBlockPayload): BlockValidationResult {
  const issues: BlockValidationIssue[] = [];
  if (!isJsonValue(payload as JsonValue)) {
    return { ok: false, issues: [issue("invalid_kind_payload", `${kind} payload must be JSON-serializable without undefined values`)] };
  }
  switch (kind) {
    case "bootstrap":
      requireString(payload, "summary", issues);
      optionalString(payload, "canonMarkdown", issues);
      optionalString(payload, "inventoryMarkdown", issues);
      optionalString(payload, "importedFrom", issues);
      break;
    case "claim_lane":
      optionalString(payload, "reason", issues);
      optionalTimestamp(payload, "leaseUntil", issues);
      break;
    case "heartbeat":
      requireTimestamp(payload, "leaseUntil", issues);
      break;
    case "checkpoint":
      requireString(payload, "status", issues);
      if (typeof (payload as CheckpointPayload).status === "string" && !CHECKPOINT_STATUSES.has((payload as CheckpointPayload).status)) {
        issues.push(issue("invalid_kind_payload", "status must be a known checkpoint status"));
      }
      requireString(payload, "progress", issues);
      optionalString(payload, "files", issues);
      optionalString(payload, "blocking", issues);
      optionalString(payload, "next", issues);
      optionalString(payload, "canonMarkdown", issues);
      optionalString(payload, "modelId", issues);
      optionalString(payload, "sessionId", issues);
      optionalString(payload, "source", issues);
      optionalString(payload, "idempotencyKey", issues);
      break;
    case "canon_update":
      requireString(payload, "canonMarkdown", issues);
      optionalString(payload, "summary", issues);
      break;
    case "inventory_update":
      requireString(payload, "inventoryMarkdown", issues);
      optionalString(payload, "summary", issues);
      break;
    case "handoff":
      optionalString(payload, "targetNodeId", issues);
      requireString(payload, "targetActorId", issues);
      optionalTimestamp(payload, "leaseUntil", issues);
      break;
    case "release":
      optionalString(payload, "reason", issues);
      break;
    case "pause":
      requireString(payload, "reason", issues);
      optionalString(payload, "observedTip", issues);
      optionalString(payload, "observedActorId", issues);
      break;
    case "reconcile":
      requireString(payload, "summary", issues);
      if (!Array.isArray((payload as ReconcilePayload).conflictingTips) || (payload as ReconcilePayload).conflictingTips.some((tip) => !isBlockId(tip))) {
        issues.push(issue("invalid_kind_payload", "reconcile conflictingTips must contain valid block ids"));
      }
      optionalString(payload, "canonMarkdown", issues);
      optionalString(payload, "inventoryMarkdown", issues);
      break;
    case "task_intent":
      requireString(payload, "title", issues);
      requireString(payload, "instructions", issues);
      optionalString(payload, "targetLaneId", issues);
      optionalEnum(payload, "policy", TASK_POLICIES, issues);
      optionalInteger(payload, "priority", issues);
      optionalRequirements(payload, issues);
      optionalString(payload, "idempotencyKey", issues);
      break;
    case "worker_profile":
      requireString(payload, "workerId", issues);
      requireString(payload, "agent", issues);
      optionalStringArray(payload, "modelFamilies", issues);
      optionalStringArray(payload, "models", issues);
      optionalStringArray(payload, "tools", issues);
      optionalInteger(payload, "maxConcurrent", issues);
      optionalString(payload, "tmuxSession", issues);
      optionalString(payload, "endpoint", issues);
      optionalBoolean(payload, "enabled", issues);
      break;
    case "task_assignment":
      requireBlockId(payload, "intentBlockId", issues);
      requireString(payload, "workerId", issues);
      requireString(payload, "assignedLaneId", issues);
      optionalEnum(payload, "mode", TASK_ASSIGNMENT_MODES, issues);
      optionalTimestamp(payload, "leaseUntil", issues);
      break;
    case "task_result":
      requireBlockId(payload, "intentBlockId", issues);
      optionalBlockId(payload, "assignmentBlockId", issues);
      requireString(payload, "workerId", issues);
      requireString(payload, "status", issues);
      if (typeof (payload as TaskResultPayload).status === "string" && !TASK_RESULT_STATUSES.has((payload as TaskResultPayload).status)) {
        issues.push(issue("invalid_kind_payload", "status must be a known task result status"));
      }
      requireString(payload, "summary", issues);
      optionalStringArray(payload, "artifacts", issues);
      optionalInteger(payload, "exitCode", issues);
      optionalTimestamp(payload, "startedAt", issues);
      optionalTimestamp(payload, "completedAt", issues);
      optionalString(payload, "tmuxSession", issues);
      break;
  }
  return { ok: issues.length === 0, issues };
}

function compactObject(input: Record<string, unknown>): JsonValue {
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) output[key] = value.map((entry) => compactJsonValue(entry));
    else if (value !== null && typeof value === "object") output[key] = compactObject(value as Record<string, unknown>);
    else output[key] = compactJsonValue(value);
  }
  return output;
}

function compactJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => compactJsonValue(entry));
  if (value && typeof value === "object") return compactObject(value as Record<string, unknown>);
  throw new Error("payload contains a value that cannot be represented as JSON");
}

function canonicalize(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  throw new Error("value contains data that cannot be represented as canonical JSON");
}

function isJsonValue(value: JsonValue): boolean {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") return Object.values(value).every((entry) => entry !== undefined && isJsonValue(entry));
  return false;
}

function requireString(payload: TaskBlockPayload, field: string, issues: BlockValidationIssue[]): void {
  const value = (payload as Record<string, unknown>)[field];
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(issue("invalid_kind_payload", `${field} must be a non-empty string`));
  }
}

function optionalString(payload: TaskBlockPayload, field: string, issues: BlockValidationIssue[]): void {
  const value = (payload as Record<string, unknown>)[field];
  if (value !== undefined && typeof value !== "string") {
    issues.push(issue("invalid_kind_payload", `${field} must be a string when provided`));
  }
}

function requireBlockId(payload: TaskBlockPayload, field: string, issues: BlockValidationIssue[]): void {
  const value = (payload as Record<string, unknown>)[field];
  if (typeof value !== "string" || !isBlockId(value)) {
    issues.push(issue("invalid_kind_payload", `${field} must be a valid block id`));
  }
}

function optionalBlockId(payload: TaskBlockPayload, field: string, issues: BlockValidationIssue[]): void {
  const value = (payload as Record<string, unknown>)[field];
  if (value !== undefined && (typeof value !== "string" || !isBlockId(value))) {
    issues.push(issue("invalid_kind_payload", `${field} must be a valid block id when provided`));
  }
}

function optionalStringArray(payload: TaskBlockPayload | Record<string, unknown>, field: string, issues: BlockValidationIssue[]): void {
  const value = (payload as Record<string, unknown>)[field];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    issues.push(issue("invalid_kind_payload", `${field} must contain non-empty strings when provided`));
  }
}

function optionalBoolean(payload: TaskBlockPayload, field: string, issues: BlockValidationIssue[]): void {
  const value = (payload as Record<string, unknown>)[field];
  if (value !== undefined && typeof value !== "boolean") {
    issues.push(issue("invalid_kind_payload", `${field} must be a boolean when provided`));
  }
}

function optionalInteger(payload: TaskBlockPayload, field: string, issues: BlockValidationIssue[]): void {
  const value = (payload as Record<string, unknown>)[field];
  if (value !== undefined && (!Number.isSafeInteger(value) || typeof value !== "number")) {
    issues.push(issue("invalid_kind_payload", `${field} must be a safe integer when provided`));
  }
}

function optionalEnum(payload: TaskBlockPayload, field: string, allowed: Set<string>, issues: BlockValidationIssue[]): void {
  const value = (payload as Record<string, unknown>)[field];
  if (value !== undefined && (typeof value !== "string" || !allowed.has(value))) {
    issues.push(issue("invalid_kind_payload", `${field} must be one of ${[...allowed].join(", ")}`));
  }
}

function optionalRequirements(payload: TaskBlockPayload, issues: BlockValidationIssue[]): void {
  const value = (payload as Record<string, unknown>).requirements;
  if (value === undefined) return;
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    issues.push(issue("invalid_kind_payload", "requirements must be an object when provided"));
    return;
  }
  const requirements = value as Record<string, unknown>;
  optionalStringArray(requirements, "agents", issues);
  optionalStringArray(requirements, "modelFamilies", issues);
  optionalStringArray(requirements, "models", issues);
  optionalStringArray(requirements, "tools", issues);
}

function requireTimestamp(payload: TaskBlockPayload, field: string, issues: BlockValidationIssue[]): void {
  const value = (payload as Record<string, unknown>)[field];
  if (typeof value !== "string" || !isIsoDate(value)) {
    issues.push(issue("invalid_kind_payload", `${field} must be an ISO timestamp`));
  }
}

function optionalTimestamp(payload: TaskBlockPayload, field: string, issues: BlockValidationIssue[]): void {
  const value = (payload as Record<string, unknown>)[field];
  if (value !== undefined && (typeof value !== "string" || !isIsoDate(value))) {
    issues.push(issue("invalid_kind_payload", `${field} must be an ISO timestamp when provided`));
  }
}

function issue(code: BlockValidationCode, message: string): BlockValidationIssue {
  return { code, message };
}

function isIdentifier(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/.test(value);
}

function isIsoDate(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function publicKeyFromBase64Url(value: string): KeyObject {
  return createPublicKey({ key: Buffer.from(value, "base64url"), format: "der", type: "spki" });
}

function requiredPublicKey(input: { publicKeyDer?: string }): string {
  if (!input.publicKeyDer) throw new Error("publicKeyDer is required when privateKeyDer is provided");
  return input.publicKeyDer;
}
