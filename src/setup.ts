import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import pg from "pg";
import { Absurd } from "absurd-sdk";
import { configPath, databaseUrlFor, loadConfig, localDockerConfig, readStoredConfig, writeStoredConfig } from "./config.js";
import { dockerAvailable, dumpPostgres, ensureDockerContainer, ensureDockerVolume, removeDockerContainer, removeDockerVolume, startDockerContainer, stopDockerContainer } from "./docker.js";
import { daemonConfigFromInstallResult, defaultDaemonRuntimeConfig, installDaemonRuntime } from "./daemon-install.js";
import { daemonStatus, startDaemon, stopDaemon } from "./daemon-lifecycle.js";
import { LocalDaemonProvider } from "./daemon-provider.js";
import { installAgentContinuity, uninstallAgentContinuity } from "./install.js";
import { migratePostgresTaskToProvider, type TaskHistoryMigrationResult } from "./migration.js";
import { ensureContinuitySchema } from "./schema.js";
import { loadOrCreateNodeSigner } from "./signer-store.js";
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
  daemon?: boolean;
  daemonLaunchd?: boolean;
  daemonPeerListen?: string;
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

export interface ProductInstallOptions extends SetupOptions {
  startDaemon?: boolean;
  projectId?: string;
  taskId?: string;
  laneId?: string;
  actorId?: string;
  nodeId?: string;
  keyFile?: string;
  timeoutMs?: number;
}

export interface ProductInstallResult extends SetupResult {
  doctor: DoctorResult;
  migration?: TaskHistoryMigrationResult & { keyPath: string; keyCreated: boolean };
}

export interface ProductUninstallOptions {
  deleteData?: boolean;
  keepIntegrations?: boolean;
  keepDaemonBinary?: boolean;
  timeoutMs?: number;
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
    await initializeDatabase(storedConfig.databaseUrl, storedConfig.queueName);
    actions.push({ name: "postgres", status: "ok", detail: databaseDetail(storedConfig.databaseUrl) });
    actions.push({ name: "absurd-schema", status: "ok" });
    actions.push({ name: "continuity-schema", status: "ok" });
    await installIntegrations(options, actions);
    await installDaemonForSetup(options, storedConfig, actions);
    const configChanged = JSON.stringify(existing) !== JSON.stringify(storedConfig);
    const writtenConfigPath = configChanged ? await writeStoredConfig(storedConfig, options.home) : configPath(options.home);
    actions.unshift({ name: "config", status: configChanged ? "updated" : "skipped", detail: writtenConfigPath });
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
    daemon: existing?.daemon,
  };

  if (!(await dockerAvailable())) throw new Error("docker is not available or the Docker daemon is not running");

  actions.push({ name: "docker-volume", status: await ensureDockerVolume(runtime.volumeName), detail: runtime.volumeName });
  actions.push({ name: "docker-container", status: await ensureDockerContainer(runtime), detail: runtime.containerName });
  await waitForPostgres(storedConfig.databaseUrl);
  actions.push({ name: "postgres", status: "ok", detail: `${runtime.host}:${runtime.port}/${runtime.database}` });

  await initializeDatabase(storedConfig.databaseUrl, queueName);
  actions.push({ name: "absurd-schema", status: "ok" });
  actions.push({ name: "continuity-schema", status: "ok" });

  await installIntegrations(options, actions);
  await installDaemonForSetup(options, storedConfig, actions);

  const configChanged = JSON.stringify(existing ?? null) !== JSON.stringify(storedConfig);
  const writtenConfigPath = configChanged ? await writeStoredConfig(storedConfig, options.home) : configPath(options.home);
  actions.unshift({ name: "config", status: configChanged ? (existing ? "updated" : "created") : "skipped", detail: writtenConfigPath });

  return { configPath: writtenConfigPath, databaseUrl: storedConfig.databaseUrl, actions };
}

export async function installProduct(options: ProductInstallOptions = {}): Promise<ProductInstallResult> {
  const wantsDaemon = options.daemon ?? true;
  if ((options.projectId && !options.taskId) || (!options.projectId && options.taskId)) {
    throw new Error("--project-id and --task-id must be provided together");
  }
  if (!wantsDaemon && (options.projectId || options.taskId)) {
    throw new Error("--project-id/--task-id migration requires daemon installation");
  }

  const setup = await setupLocal({
    ...options,
    daemon: wantsDaemon,
    install: options.install ?? true,
    daemonLaunchd: options.daemonLaunchd,
    daemonPeerListen: options.daemonPeerListen,
  });
  const config = reloadConfig(options.home);
  const actions = [...setup.actions];

  let migration: ProductInstallResult["migration"];
  if (wantsDaemon) {
    const daemon = config.daemon ?? defaultDaemonRuntimeConfig(config.home);

    if (options.startDaemon ?? true) {
      actions.push(...(await startDaemon({ daemon, launchd: options.daemonLaunchd, peerListen: options.daemonPeerListen, timeoutMs: options.timeoutMs })));
    } else {
      actions.push({ name: "daemon-start", status: "skipped", detail: "--no-start" });
    }

    actions.push(...(await daemonStatus({ daemon, timeoutMs: options.timeoutMs })));

    if (options.projectId && options.taskId) {
      const signerState = await loadOrCreateNodeSigner({
        keyPath: options.keyFile,
        stateDir: daemon.stateDir,
        nodeId: options.nodeId,
        actorId: options.actorId ?? "install-cli",
      });
      const migrated = await migratePostgresTaskToProvider({
        projectId: options.projectId,
        taskId: options.taskId,
        laneId: options.laneId ?? "main",
        provider: new LocalDaemonProvider({ socketPath: daemon.socketPath, timeoutMs: options.timeoutMs }),
        signer: signerState.signer,
        config,
      });
      migration = { ...migrated, keyPath: signerState.keyPath, keyCreated: signerState.created };
      actions.push({
        name: "daemon-migrate",
        status: migration.migrated ? "updated" : "skipped",
        detail: migration.migrated ? `${migration.acceptedBlocks} blocks, tip ${migration.finalTip}` : migration.reason,
      });
    } else {
      actions.push({ name: "daemon-migrate", status: "skipped", detail: "pass --project-id and --task-id to migrate a task" });
    }
  } else {
    actions.push({ name: "daemon-start", status: "skipped", detail: "--no-daemon" });
    actions.push({ name: "daemon-status", status: "skipped", detail: "--no-daemon" });
    actions.push({ name: "daemon-migrate", status: "skipped", detail: "--no-daemon" });
  }

  const doctorResult = await doctor(config);
  return { ...setup, actions, doctor: doctorResult, migration };
}

async function installIntegrations(options: SetupOptions, actions: ActionReport[]): Promise<void> {
  if (options.install ?? true) {
    const install = await installAgentContinuity({ home: options.home, target: "all" });
    actions.push({ name: "integrations", status: install.wrote.length > 0 || install.removed.length > 0 ? "updated" : "skipped", detail: `${install.wrote.length} wrote, ${install.removed.length} removed, ${install.skipped.length} skipped` });
  } else {
    actions.push({ name: "integrations", status: "skipped", detail: "--no-install" });
  }
}

async function installDaemonForSetup(options: SetupOptions, storedConfig: StoredConfig, actions: ActionReport[]): Promise<void> {
  if (!options.daemon) {
    actions.push({ name: "daemon", status: "skipped", detail: "pass --daemon to provision continuityd" });
    return;
  }
  const launchdLabel = "com.agent-continuity.continuityd";
  const result = await installDaemonRuntime({
    home: options.home,
    launchd: options.daemonLaunchd,
    launchdLabel,
    peerListen: options.daemonPeerListen,
  });
  storedConfig.daemon = daemonConfigFromInstallResult(result, launchdLabel);
  for (const action of result.actions) {
    actions.push({ ...action, name: `daemon-${action.name}` });
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

export async function uninstallProduct(config: ContinuityConfig, options: ProductUninstallOptions = {}): Promise<ActionReport[]> {
  const actions: ActionReport[] = [];
  const home = config.home ?? os.homedir();

  if (config.daemon) {
    actions.push(...(await stopDaemon({ daemon: config.daemon, launchd: Boolean(config.daemon.launchdPlistPath), timeoutMs: options.timeoutMs })));
    if (config.daemon.launchdPlistPath) {
      actions.push(await removeSafeFile("launchd-plist", config.daemon.launchdPlistPath, safeUnder(home, "Library", "LaunchAgents")));
    }
    if (options.keepDaemonBinary) {
      actions.push({ name: "daemon-binary", status: "skipped", detail: config.daemon.binaryPath });
    } else {
      actions.push(await removeSafeFile("daemon-binary", config.daemon.binaryPath, safeUnder(home, ".local", "bin")));
    }
    if (options.deleteData) {
      actions.push(await removeSafeDir("daemon-state", config.daemon.stateDir, defaultDaemonRuntimeConfig(home).stateDir));
    } else {
      actions.push({ name: "daemon-state", status: "skipped", detail: `${config.daemon.stateDir} kept` });
    }
  } else {
    actions.push({ name: "daemon", status: "skipped", detail: "no daemon configured" });
  }

  if (options.keepIntegrations) {
    actions.push({ name: "integrations", status: "skipped", detail: "--keep-integrations" });
  } else {
    const integration = await uninstallAgentContinuity({ home, target: "all" });
    actions.push({
      name: "integrations",
      status: integration.wrote.length > 0 || integration.removed.length > 0 ? "updated" : "skipped",
      detail: `${integration.wrote.length} wrote, ${integration.removed.length} removed, ${integration.skipped.length} skipped`,
    });
  }

  if (config.runtime?.kind === "docker") {
    actions.push({ name: "docker-container", status: await removeDockerContainer(config.runtime.containerName), detail: config.runtime.containerName });
    if (options.deleteData) {
      actions.push({ name: "docker-volume", status: await removeDockerVolume(config.runtime.volumeName), detail: config.runtime.volumeName });
    } else {
      actions.push({ name: "docker-volume", status: "skipped", detail: `${config.runtime.volumeName} kept` });
    }
  } else {
    actions.push({ name: "docker-runtime", status: "skipped", detail: "no docker runtime configured" });
  }

  if (config.configPath) {
    actions.push(await removeSafeFile("config", config.configPath, safeUnder(home, ".config", "agent-continuity")));
  } else {
    actions.push({ name: "config", status: "skipped", detail: "no config path" });
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

function reloadConfig(home?: string): ContinuityConfig {
  return loadConfig(home ? { ...process.env, CONTINUITY_HOME: home } : process.env);
}

function safeUnder(home: string, ...parts: string[]): string {
  return resolve(home, ...parts);
}

async function removeSafeFile(name: string, file: string, safeParent: string): Promise<ActionReport> {
  const resolved = resolve(file);
  if (!isWithin(resolved, safeParent)) {
    return { name, status: "skipped", detail: `outside managed path: ${file}` };
  }
  if (!(await fileExists(resolved))) return { name, status: "missing", detail: file };
  await rm(resolved, { force: true });
  return { name, status: "removed", detail: file };
}

async function removeSafeDir(name: string, dir: string, expectedDir: string): Promise<ActionReport> {
  const resolved = resolve(dir);
  if (resolved !== resolve(expectedDir)) {
    return { name, status: "skipped", detail: `custom path kept: ${dir}` };
  }
  if (!(await pathExists(resolved))) return { name, status: "missing", detail: dir };
  await rm(resolved, { recursive: true, force: true });
  return { name, status: "removed", detail: dir };
}

function isWithin(candidate: string, parent: string): boolean {
  const resolvedParent = resolve(parent);
  return candidate === resolvedParent || candidate.startsWith(`${resolvedParent}/`);
}

async function fileExists(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    return info.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
