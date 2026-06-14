export type CheckpointStatus = "pending" | "in_progress" | "blocked" | "completed" | "cancelled";

export interface ContinuityConfig {
  databaseUrl: string;
  queueName: string;
  checkpointDir: string;
  workerTimeoutSeconds: number;
  home?: string;
  configPath?: string;
  databaseConfigured?: boolean;
  runtime?: RuntimeConfig;
}

export interface StoredConfig {
  version: 1;
  databaseUrl: string;
  queueName: string;
  checkpointDir: string;
  workerTimeoutSeconds?: number;
  runtime?: RuntimeConfig;
}

export type RuntimeConfig = DockerRuntimeConfig;

export interface DockerRuntimeConfig {
  kind: "docker";
  image: string;
  containerName: string;
  volumeName: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface CheckpointInput {
  taskId: string;
  timestamp: string;
  modelId: string;
  sessionId: string;
  status: CheckpointStatus;
  progress: string;
  files?: string;
  blocking?: string;
  next?: string;
  canonMarkdown?: string;
  checkpointDir?: string;
  source?: string;
}

export interface JournalEntry extends CheckpointInput {
  idempotencyKey: string;
  entryMarkdown: string;
}

export interface CanonRecord {
  taskId: string;
  lastReconciled: string;
  canonMarkdown: string;
  updatedAt: string;
}

export interface ReconcileResult {
  taskId: string;
  timestamp: string;
  appended: boolean;
  journalPath: string;
  canonPath: string;
}
