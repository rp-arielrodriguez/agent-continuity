import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { CheckpointInput, CheckpointStatus, ContinuityConfig, DockerRuntimeConfig, StoredConfig } from "./types.js";

const DEFAULT_DATABASE_URL = "postgresql://postgres@127.0.0.1:5433/agent_continuity";
const CONFIG_DIR = "~/.config/agent-continuity";
const CONFIG_FILE = "config.json";

export function expandHome(value: string, home?: string): string {
  const base = home ? path.resolve(expandHome(home)) : os.homedir();
  if (value === "~") return base;
  if (value.startsWith("~/")) return path.join(base, value.slice(2));
  return value;
}

export function configDir(home?: string): string {
  return home ? path.join(expandHome(home), ".config", "agent-continuity") : expandHome(CONFIG_DIR);
}

export function configPath(home?: string): string {
  return path.join(configDir(home), CONFIG_FILE);
}

export async function readStoredConfig(home?: string): Promise<StoredConfig | null> {
  const file = configPath(home);
  try {
    return JSON.parse(await readFile(file, "utf8")) as StoredConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`failed to read ${file}: ${(error as Error).message}`);
  }
}

export async function writeStoredConfig(config: StoredConfig, home?: string): Promise<string> {
  const file = configPath(home);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return file;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ContinuityConfig {
  const home = env.CONTINUITY_HOME ? expandHome(env.CONTINUITY_HOME) : undefined;
  const file = configPath(home);
  const stored = loadStoredConfigSync(file);
  const databaseUrl = firstNonBlank(env.CONTINUITY_DATABASE_URL, env.ABSURD_DATABASE_URL, stored?.databaseUrl);
  const queueName = firstNonBlank(env.CONTINUITY_QUEUE, stored?.queueName) ?? "default";
  const checkpointDir = firstNonBlank(env.CONTINUITY_CHECKPOINT_DIR, stored?.checkpointDir) ?? "~/.config/opencode/checkpoints";
  const workerTimeoutSeconds = firstNonBlank(env.CONTINUITY_WORKER_TIMEOUT_SECONDS, String(stored?.workerTimeoutSeconds ?? "")) ?? "30";
  return {
    databaseUrl: databaseUrl ?? DEFAULT_DATABASE_URL,
    queueName,
    checkpointDir: expandHome(checkpointDir, home),
    workerTimeoutSeconds: Number(workerTimeoutSeconds),
    home,
    configPath: file,
    databaseConfigured: Boolean(databaseUrl),
    runtime: stored?.runtime,
  };
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "");
}

export function localDockerConfig(overrides: Partial<DockerRuntimeConfig> = {}): DockerRuntimeConfig {
  const password = overrides.password ?? randomUUID().replaceAll("-", "");
  return {
    kind: "docker",
    image: overrides.image ?? "postgres:16-alpine",
    containerName: overrides.containerName ?? "agent-continuity-postgres",
    volumeName: overrides.volumeName ?? "agent-continuity-postgres-data",
    host: overrides.host ?? "127.0.0.1",
    port: overrides.port ?? 5433,
    database: overrides.database ?? "agent_continuity",
    user: overrides.user ?? "continuity",
    password,
  };
}

export function databaseUrlFor(runtime: DockerRuntimeConfig): string {
  return `postgresql://${encodeURIComponent(runtime.user)}:${encodeURIComponent(runtime.password)}@${runtime.host}:${runtime.port}/${runtime.database}`;
}

export function maskDatabaseUrl(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return databaseUrl;
  }
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

function loadStoredConfigSync(file: string): StoredConfig | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as StoredConfig;
  } catch (error) {
    throw new Error(`failed to read ${file}: ${(error as Error).message}`);
  }
}
