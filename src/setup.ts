import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import pg from "pg";
import { Absurd } from "absurd-sdk";
import { configPath, databaseUrlFor, localDockerConfig, readStoredConfig, writeStoredConfig } from "./config.js";
import { dockerAvailable, dumpPostgres, ensureDockerContainer, ensureDockerVolume, removeDockerContainer, removeDockerVolume, startDockerContainer, stopDockerContainer } from "./docker.js";
import { installAgentContinuity } from "./install.js";
import { ensureContinuitySchema } from "./schema.js";
import type { ContinuityConfig, DockerRuntimeConfig, StoredConfig } from "./types.js";

const ABSURD_SQL_URL = "https://raw.githubusercontent.com/earendil-works/absurd/a347eb5353e9a3e2ef2e2f6ed2efd02cfd134b78/sql/absurd.sql";

export interface SetupOptions {
  home?: string;
  runtime?: "docker";
  install?: boolean;
  image?: string;
  containerName?: string;
  volumeName?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  queueName?: string;
  checkpointDir?: string;
}

export interface ActionReport {
  name: string;
  status: "created" | "exists" | "started" | "running" | "updated" | "skipped" | "ok" | "failed" | "stopped" | "not-running" | "removed" | "missing";
  detail?: string;
}

export interface SetupResult {
  configPath: string;
  databaseUrl: string;
  actions: ActionReport[];
}

export interface DoctorResult {
  ok: boolean;
  checks: ActionReport[];
}

export async function setupLocal(options: SetupOptions = {}): Promise<SetupResult> {
  const actions: ActionReport[] = [];
  const existing = await readStoredConfig(options.home);
  if (existing?.databaseUrl && !existing.runtime && !hasDockerOptions(options)) {
    const storedConfig: StoredConfig = {
      ...existing,
      queueName: options.queueName ?? existing.queueName ?? "default",
      checkpointDir: options.checkpointDir ?? existing.checkpointDir ?? "~/.config/opencode/checkpoints",
      workerTimeoutSeconds: existing.workerTimeoutSeconds ?? 30,
    };
    const configChanged = JSON.stringify(existing) !== JSON.stringify(storedConfig);
    const writtenConfigPath = configChanged ? await writeStoredConfig(storedConfig, options.home) : configPath(options.home);
    actions.push({ name: "config", status: configChanged ? "updated" : "skipped", detail: writtenConfigPath });
    await initializeDatabase(storedConfig.databaseUrl, storedConfig.queueName);
    actions.push({ name: "postgres", status: "ok", detail: databaseDetail(storedConfig.databaseUrl) });
    actions.push({ name: "absurd-schema", status: "ok" });
    actions.push({ name: "continuity-schema", status: "ok" });
    await installIntegrations(options, actions);
    return { configPath: writtenConfigPath, databaseUrl: storedConfig.databaseUrl, actions };
  }

  const runtimeKind = options.runtime ?? "docker";
  if (runtimeKind !== "docker") throw new Error(`unsupported setup runtime: ${runtimeKind}`);

  const runtime = mergeRuntime(existing?.runtime?.kind === "docker" ? existing.runtime : undefined, options);
  const queueName = options.queueName ?? existing?.queueName ?? "default";
  const checkpointDir = options.checkpointDir ?? existing?.checkpointDir ?? "~/.config/opencode/checkpoints";
  const storedConfig: StoredConfig = {
    version: 1,
    databaseUrl: databaseUrlFor(runtime),
    queueName,
    checkpointDir,
    workerTimeoutSeconds: existing?.workerTimeoutSeconds ?? 30,
    runtime,
  };

  if (!(await dockerAvailable())) throw new Error("docker is not available or the Docker daemon is not running");

  const configChanged = JSON.stringify(existing ?? null) !== JSON.stringify(storedConfig);
  const writtenConfigPath = configChanged ? await writeStoredConfig(storedConfig, options.home) : configPath(options.home);
  actions.push({ name: "config", status: configChanged ? (existing ? "updated" : "created") : "skipped", detail: writtenConfigPath });

  actions.push({ name: "docker-volume", status: await ensureDockerVolume(runtime.volumeName), detail: runtime.volumeName });
  actions.push({ name: "docker-container", status: await ensureDockerContainer(runtime), detail: runtime.containerName });
  await waitForPostgres(storedConfig.databaseUrl);
  actions.push({ name: "postgres", status: "ok", detail: `${runtime.host}:${runtime.port}/${runtime.database}` });

  await initializeDatabase(storedConfig.databaseUrl, queueName);
  actions.push({ name: "absurd-schema", status: "ok" });
  actions.push({ name: "continuity-schema", status: "ok" });

  await installIntegrations(options, actions);

  return { configPath: writtenConfigPath, databaseUrl: storedConfig.databaseUrl, actions };
}

async function installIntegrations(options: SetupOptions, actions: ActionReport[]): Promise<void> {
  if (options.install ?? true) {
    const install = await installAgentContinuity({ home: options.home, target: "all" });
    actions.push({ name: "integrations", status: install.wrote.length > 0 || install.removed.length > 0 ? "updated" : "skipped", detail: `${install.wrote.length} wrote, ${install.removed.length} removed, ${install.skipped.length} skipped` });
  } else {
    actions.push({ name: "integrations", status: "skipped", detail: "--no-install" });
  }
}

export async function doctor(config: ContinuityConfig): Promise<DoctorResult> {
  const checks: ActionReport[] = [];
  if (config.runtime) checks.push({ name: "config", status: "ok", detail: config.configPath });
  else if (config.databaseConfigured) checks.push({ name: "config", status: "skipped", detail: "using configured database" });
  else checks.push({ name: "config", status: "missing", detail: config.configPath });

  if (config.runtime?.kind === "docker") {
    checks.push({ name: "docker", status: (await dockerAvailable()) ? "ok" : "failed" });
  }

  if (!config.databaseConfigured) {
    checks.push({ name: "database", status: "skipped", detail: "run continuity setup --local or set CONTINUITY_DATABASE_URL" });
  } else {
    try {
      await checkDatabase(config.databaseUrl, config.queueName);
      checks.push({ name: "postgres", status: "ok" });
      checks.push({ name: "absurd-schema", status: "ok" });
      checks.push({ name: "continuity-schema", status: "ok" });
    } catch (error) {
      checks.push({ name: "database", status: "failed", detail: (error as Error).message });
    }
  }

  return { ok: checks.every((check) => check.status !== "failed" && check.status !== "missing"), checks };
}

export async function startRuntime(config: ContinuityConfig): Promise<ActionReport[]> {
  const runtime = dockerRuntime(config);
  return [{ name: "docker-container", status: await startDockerContainer(runtime.containerName), detail: runtime.containerName }];
}

export async function stopRuntime(config: ContinuityConfig): Promise<ActionReport[]> {
  const runtime = dockerRuntime(config);
  return [{ name: "docker-container", status: await stopDockerContainer(runtime.containerName), detail: runtime.containerName }];
}

export async function backupRuntime(config: ContinuityConfig, outputPath?: string): Promise<ActionReport[]> {
  const runtime = dockerRuntime(config);
  const target = outputPath ?? join(config.home ?? os.homedir(), ".local", "share", "agent-continuity", "backups", `agent-continuity-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}.sql`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, await dumpPostgres(runtime), "utf8");
  return [{ name: "backup", status: "created", detail: target }];
}

export async function uninstallRuntime(config: ContinuityConfig, options: { deleteData?: boolean } = {}): Promise<ActionReport[]> {
  const runtime = dockerRuntime(config);
  const actions: ActionReport[] = [];
  actions.push({ name: "docker-container", status: await removeDockerContainer(runtime.containerName), detail: runtime.containerName });
  if (options.deleteData) {
    actions.push({ name: "docker-volume", status: await removeDockerVolume(runtime.volumeName), detail: runtime.volumeName });
  } else {
    actions.push({ name: "docker-volume", status: "skipped", detail: `${runtime.volumeName} kept` });
  }
  if (config.configPath) {
    await rm(config.configPath, { force: true });
    actions.push({ name: "config", status: "removed", detail: config.configPath });
  }
  return actions;
}

async function initializeDatabase(databaseUrl: string, queueName: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const app = new Absurd({ db: pool, queueName });
  try {
    if (!(await absurdInstalled(pool))) {
      const response = await fetch(ABSURD_SQL_URL);
      if (!response.ok) throw new Error(`failed to fetch Absurd SQL: ${response.status} ${response.statusText}`);
      await pool.query(await response.text());
    }
    await app.createQueue(queueName);
    await ensureContinuitySchema(pool);
  } finally {
    await app.close();
  }
}

async function checkDatabase(databaseUrl: string, queueName: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    if (!(await absurdInstalled(pool))) throw new Error("Absurd schema is missing");
    const queue = await pool.query<{ exists: boolean }>(`SELECT EXISTS (SELECT 1 FROM absurd.queues WHERE queue_name = $1) AS exists`, [queueName]);
    if (!queue.rows[0]?.exists) throw new Error(`Absurd queue is missing: ${queueName}`);
    const continuity = await pool.query<{ exists: boolean }>(`SELECT to_regclass('continuity.journal_entries') IS NOT NULL AS exists`);
    if (!continuity.rows[0]?.exists) throw new Error("continuity schema is missing");
  } finally {
    await pool.end();
  }
}

async function absurdInstalled(pool: pg.Pool): Promise<boolean> {
  const result = await pool.query<{ installed: boolean }>(`SELECT to_regclass('absurd.queues') IS NOT NULL AS installed`);
  return result.rows[0]?.installed ?? false;
}

async function waitForPostgres(databaseUrl: string): Promise<void> {
  const started = Date.now();
  let lastError: Error | null = null;
  while (Date.now() - started < 30_000) {
    const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 1000, max: 1 });
    try {
      await pool.query("SELECT 1");
      await pool.end();
      return;
    } catch (error) {
      lastError = error as Error;
      await pool.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`postgres did not become ready: ${lastError?.message ?? "timeout"}`);
}

function mergeRuntime(existing: DockerRuntimeConfig | undefined, options: SetupOptions): DockerRuntimeConfig {
  return localDockerConfig({
    image: options.image ?? existing?.image,
    containerName: options.containerName ?? existing?.containerName,
    volumeName: options.volumeName ?? existing?.volumeName,
    host: options.host ?? existing?.host,
    port: options.port ?? existing?.port,
    database: options.database ?? existing?.database,
    user: options.user ?? existing?.user,
    password: options.password ?? existing?.password,
  });
}

function hasDockerOptions(options: SetupOptions): boolean {
  return Boolean(options.runtime ?? options.image ?? options.containerName ?? options.volumeName ?? options.host ?? options.port ?? options.database ?? options.user ?? options.password);
}

function databaseDetail(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
  } catch {
    return databaseUrl;
  }
}

function dockerRuntime(config: ContinuityConfig): DockerRuntimeConfig {
  if (config.runtime?.kind !== "docker") throw new Error("no docker runtime is configured; run continuity setup --local first");
  return config.runtime;
}
