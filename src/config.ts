import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CheckpointInput, CheckpointStatus, ContinuityConfig } from "./types.js";

const DEFAULT_DATABASE_URL = "postgresql://postgres@127.0.0.1:5433/absurd_poc";

export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ContinuityConfig {
  return {
    databaseUrl: env.CONTINUITY_DATABASE_URL ?? env.ABSURD_DATABASE_URL ?? DEFAULT_DATABASE_URL,
    queueName: env.CONTINUITY_QUEUE ?? "default",
    checkpointDir: expandHome(env.CONTINUITY_CHECKPOINT_DIR ?? "~/.config/opencode/checkpoints"),
    workerTimeoutSeconds: Number(env.CONTINUITY_WORKER_TIMEOUT_SECONDS ?? "30"),
  };
}

export function defaultCheckpointInput(partial: Partial<CheckpointInput>): CheckpointInput {
  const taskId = required("task-id", partial.taskId);
  const status = (partial.status ?? "in_progress") as CheckpointStatus;
  return {
    taskId,
    timestamp: partial.timestamp ?? new Date().toISOString(),
    modelId: partial.modelId ?? process.env.CONTINUITY_MODEL_ID ?? "unknown-model",
    sessionId: partial.sessionId ?? process.env.CONTINUITY_SESSION_ID ?? randomUUID(),
    status,
    progress: required("progress", partial.progress),
    files: partial.files,
    blocking: partial.blocking,
    next: partial.next,
    canonMarkdown: partial.canonMarkdown,
    checkpointDir: partial.checkpointDir,
    source: partial.source,
  };
}

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === "") {
    throw new Error(`missing required option --${name}`);
  }
  return value;
}
