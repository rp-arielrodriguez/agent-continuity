import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ActionReport } from "./setup.js";
import type { DaemonRuntimeConfig } from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_LAUNCHD_LABEL = "com.agent-continuity.continuityd";
const DEFAULT_UNIX_SOCKET_PATH_LIMIT_BYTES = 100;

export interface DaemonInstallOptions {
  home?: string;
  packageRoot?: string;
  binaryPath?: string;
  stateDir?: string;
  socketPath?: string;
  dbPath?: string;
  launchd?: boolean;
  launchdLabel?: string;
  launchdPlistPath?: string;
  peerListen?: string;
  dryRun?: boolean;
}

export interface DaemonInstallResult {
  binaryPath: string;
  stateDir: string;
  socketPath: string;
  dbPath: string;
  launchdPlistPath?: string;
  actions: ActionReport[];
}

export async function installDaemonRuntime(options: DaemonInstallOptions = {}): Promise<DaemonInstallResult> {
  const resolved = resolveDaemonRuntimePaths(options);
  const packageRoot = options.packageRoot ?? defaultPackageRoot();
  const daemonDir = path.join(packageRoot, "daemon");
  const { binaryPath, stateDir, socketPath, dbPath, launchdPlistPath } = resolved;
  const actions: ActionReport[] = [];

  await assertDaemonSource(daemonDir);

  if (options.dryRun) {
    actions.push({ name: "state-dir", status: "skipped", detail: `dry run: ${stateDir}` });
    actions.push({ name: "bin-dir", status: "skipped", detail: `dry run: ${path.dirname(binaryPath)}` });
    actions.push({ name: "build-daemon", status: "skipped", detail: `dry run: go build -o ${binaryPath} ./cmd/continuityd` });
    if (launchdPlistPath) actions.push({ name: "launchd-plist", status: "skipped", detail: `dry run: ${launchdPlistPath}` });
    return { binaryPath, stateDir, socketPath, dbPath, launchdPlistPath, actions };
  }

  await mkdir(stateDir, { recursive: true });
  actions.push({ name: "state-dir", status: "ok", detail: stateDir });
  await mkdir(path.dirname(binaryPath), { recursive: true });
  actions.push({ name: "bin-dir", status: "ok", detail: path.dirname(binaryPath) });

  try {
    await execFileAsync("go", ["build", "-o", binaryPath, "./cmd/continuityd"], { cwd: daemonDir });
    actions.push({ name: "build-daemon", status: "updated", detail: binaryPath });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`build continuityd from ${daemonDir}: ${detail}`);
  }

  if (launchdPlistPath) {
    const plist = renderLaunchdPlist({
      label: options.launchdLabel ?? DEFAULT_LAUNCHD_LABEL,
      binaryPath,
      socketPath,
      dbPath,
      peerListen: options.peerListen,
      stdoutPath: path.join(stateDir, "continuityd.out.log"),
      stderrPath: path.join(stateDir, "continuityd.err.log"),
    });
    await mkdir(path.dirname(launchdPlistPath), { recursive: true });
    await writeFile(launchdPlistPath, plist, { mode: 0o644 });
    actions.push({ name: "launchd-plist", status: "updated", detail: launchdPlistPath });
  }

  return { binaryPath, stateDir, socketPath, dbPath, launchdPlistPath, actions };
}

export function resolveDaemonRuntimePaths(options: DaemonInstallOptions = {}): DaemonInstallResult {
  const home = options.home ?? os.homedir();
  const binaryPath = options.binaryPath ?? path.join(home, ".local", "bin", "continuityd");
  const stateDir = options.stateDir ?? path.join(home, ".local", "state", "agent-continuity");
  const socketPath = options.socketPath ?? defaultSocketPath(stateDir);
  const dbPath = options.dbPath ?? path.join(stateDir, "continuity.db");
  const launchdPlistPath = options.launchd
    ? options.launchdPlistPath ?? path.join(home, "Library", "LaunchAgents", `${options.launchdLabel ?? DEFAULT_LAUNCHD_LABEL}.plist`)
    : undefined;
  return { binaryPath, stateDir, socketPath, dbPath, launchdPlistPath, actions: [] };
}

export function daemonConfigFromInstallResult(result: DaemonInstallResult, launchdLabel = DEFAULT_LAUNCHD_LABEL): DaemonRuntimeConfig {
  return {
    kind: "daemon",
    binaryPath: result.binaryPath,
    stateDir: result.stateDir,
    socketPath: result.socketPath,
    dbPath: result.dbPath,
    launchdPlistPath: result.launchdPlistPath,
    launchdLabel: result.launchdPlistPath ? launchdLabel : undefined,
  };
}

export function defaultDaemonRuntimeConfig(home = os.homedir()): DaemonRuntimeConfig {
  const paths = resolveDaemonRuntimePaths({ home });
  return daemonConfigFromInstallResult(paths);
}

export interface LaunchdPlistInput {
  label: string;
  binaryPath: string;
  socketPath: string;
  dbPath: string;
  peerListen?: string;
  stdoutPath: string;
  stderrPath: string;
}

export function renderLaunchdPlist(input: LaunchdPlistInput): string {
  const args = [input.binaryPath, "--socket", input.socketPath, "--db", input.dbPath];
  if (input.peerListen) args.push("--peer-listen", input.peerListen);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(input.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(input.stderrPath)}</string>
</dict>
</plist>
`;
}

export function defaultPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function defaultSocketPath(stateDir: string): string {
  const candidate = path.join(stateDir, "continuityd.sock");
  if (Buffer.byteLength(candidate) <= DEFAULT_UNIX_SOCKET_PATH_LIMIT_BYTES) return candidate;

  const hash = createHash("sha256").update(candidate).digest("hex").slice(0, 16);
  return path.join("/tmp", `continuityd-${hash}.sock`);
}

async function assertDaemonSource(daemonDir: string): Promise<void> {
  try {
    const info = await stat(path.join(daemonDir, "cmd", "continuityd", "main.go"));
    if (!info.isFile()) throw new Error("not a file");
  } catch (error) {
    throw new Error(`daemon source not found under ${daemonDir}: ${(error as Error).message}`);
  }
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
