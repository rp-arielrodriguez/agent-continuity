import { execFile, spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { LocalDaemonProvider } from "./daemon-provider.js";
import { defaultDaemonRuntimeConfig } from "./daemon-install.js";
import type { ActionReport } from "./setup.js";
import type { DaemonRuntimeConfig } from "./types.js";

const execFileAsync = promisify(execFile);

interface ChildExitState {
  error?: Error;
  code?: number | null;
  signal?: NodeJS.Signals | null;
}

export interface DaemonLifecycleOptions {
  daemon?: DaemonRuntimeConfig;
  home?: string;
  launchd?: boolean;
  peerListen?: string;
  timeoutMs?: number;
}

export async function daemonStatus(options: DaemonLifecycleOptions = {}): Promise<ActionReport[]> {
  const runtime = resolveRuntime(options);
  const health = await checkHealth(runtime.socketPath, options.timeoutMs);
  const dbExists = await fileExists(runtime.dbPath);
  return [
    { name: "daemon-socket", status: health.ok ? "ok" : "missing", detail: health.ok ? runtime.socketPath : health.error },
    { name: "daemon-db", status: dbExists ? "ok" : "missing", detail: runtime.dbPath },
  ];
}

export async function startDaemon(options: DaemonLifecycleOptions = {}): Promise<ActionReport[]> {
  const runtime = resolveRuntime(options);
  if (await isDaemonHealthy(runtime, options.timeoutMs)) {
    return [{ name: "continuityd", status: "running", detail: runtime.socketPath }];
  }
  if (options.launchd) return startLaunchd(runtime);

  await mkdir(runtime.stateDir, { recursive: true });
  const stdoutPath = path.join(runtime.stateDir, "continuityd.out.log");
  const stderrPath = path.join(runtime.stateDir, "continuityd.err.log");
  const args = ["--socket", runtime.socketPath, "--db", runtime.dbPath];
  if (options.peerListen) args.push("--peer-listen", options.peerListen);
  const stdoutFd = await openAppend(stdoutPath);
  const stderrFd = await openAppend(stderrPath);
  const detached = shouldDetachDaemonProcess();
  const child = spawn(runtime.binaryPath, args, {
    detached,
    stdio: ["ignore", stdoutFd, stderrFd],
  });
  closeSync(stdoutFd);
  closeSync(stderrFd);
  const childExitState = trackChildExit(child);
  child.unref();
  await writeFile(pidPath(runtime), `${child.pid ?? ""}\n`, { encoding: "utf8", mode: 0o644 });
  try {
    await waitForHealthOrExit(runtime.socketPath, options.timeoutMs ?? 5000, childExitState, stderrPath);
  } catch (error) {
    await rm(pidPath(runtime), { force: true });
    if (!childExitState() && child.pid) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // Preserve the startup error; the log path above has the actionable detail.
      }
    }
    throw error;
  }
  return [
    { name: "continuityd", status: "started", detail: runtime.socketPath },
    { name: "daemon-pid", status: "updated", detail: pidPath(runtime) },
  ];
}

function shouldDetachDaemonProcess(): boolean {
  // Detached macOS children can fail to use mDNS/VPN routes that are reachable
  // from the same binary when launched as a normal child. `unref` still lets
  // the CLI return while the daemon survives parent exit.
  return process.platform !== "darwin";
}

export async function stopDaemon(options: DaemonLifecycleOptions = {}): Promise<ActionReport[]> {
  const runtime = resolveRuntime(options);
  if (options.launchd) return stopLaunchd(runtime);

  const pid = await readPid(runtime);
  if (!pid) {
    return [{ name: "continuityd", status: "missing", detail: pidPath(runtime) }];
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await waitForStop(runtime.socketPath, options.timeoutMs ?? 5000);
  await rm(pidPath(runtime), { force: true });
  return [
    { name: "continuityd", status: "stopped", detail: runtime.socketPath },
    { name: "daemon-pid", status: "removed", detail: pidPath(runtime) },
  ];
}

function resolveRuntime(options: DaemonLifecycleOptions): DaemonRuntimeConfig {
  return options.daemon ?? defaultDaemonRuntimeConfig(options.home);
}

async function startLaunchd(runtime: DaemonRuntimeConfig): Promise<ActionReport[]> {
  const plist = requiredLaunchdPlist(runtime);
  const domain = launchdDomain();
  const actions: ActionReport[] = [];
  try {
    await execFileAsync("launchctl", ["bootstrap", domain, plist]);
    actions.push({ name: "launchd-bootstrap", status: "started", detail: plist });
  } catch (error) {
    actions.push({ name: "launchd-bootstrap", status: "skipped", detail: (error as Error).message });
  }
  await execFileAsync("launchctl", ["kickstart", "-k", `${domain}/${runtime.launchdLabel ?? "com.agent-continuity.continuityd"}`]);
  actions.push({ name: "launchd-kickstart", status: "ok", detail: runtime.launchdLabel });
  return actions;
}

async function stopLaunchd(runtime: DaemonRuntimeConfig): Promise<ActionReport[]> {
  const plist = requiredLaunchdPlist(runtime);
  const domain = launchdDomain();
  try {
    await execFileAsync("launchctl", ["bootout", domain, plist]);
    return [{ name: "launchd-bootout", status: "stopped", detail: plist }];
  } catch (error) {
    return [{ name: "launchd-bootout", status: "not-running", detail: (error as Error).message }];
  }
}

function requiredLaunchdPlist(runtime: DaemonRuntimeConfig): string {
  if (process.platform !== "darwin") throw new Error("launchd is only supported on macOS");
  if (!runtime.launchdPlistPath) throw new Error("daemon launchd plist is not configured; run daemon-install --launchd first");
  return runtime.launchdPlistPath;
}

function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? os.userInfo().uid}`;
}

async function isDaemonHealthy(runtime: DaemonRuntimeConfig, timeoutMs?: number): Promise<boolean> {
  return (await checkHealth(runtime.socketPath, timeoutMs)).ok;
}

async function checkHealth(socketPath: string, timeoutMs?: number): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await new LocalDaemonProvider({ socketPath, timeoutMs: timeoutMs ?? 1000 }).health();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

async function waitForHealthOrExit(
  socketPath: string,
  timeoutMs: number,
  childExitState: () => ChildExitState | null,
  stderrPath: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    const health = await checkHealth(socketPath, 500);
    if (health.ok) return;
    lastError = health.error;

    const exitState = childExitState();
    if (exitState) {
      const detail = await startupFailureDetail(exitState, stderrPath);
      throw new Error(`continuityd exited before becoming healthy on ${socketPath}: ${detail}`);
    }
    await sleep(100);
  }
  throw new Error(`continuityd did not become healthy on ${socketPath}: ${lastError}`);
}

async function waitForStop(socketPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await checkHealth(socketPath, 500)).ok) return;
    await sleep(100);
  }
  throw new Error(`continuityd did not stop on ${socketPath}`);
}

async function readPid(runtime: DaemonRuntimeConfig): Promise<number | null> {
  try {
    const value = Number((await readFile(pidPath(runtime), "utf8")).trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function pidPath(runtime: DaemonRuntimeConfig): string {
  return path.join(runtime.stateDir, "continuityd.pid");
}

function trackChildExit(child: ChildProcess): () => ChildExitState | null {
  let state: ChildExitState | null = null;
  child.once("error", (error) => {
    state = { error };
  });
  child.once("exit", (code, signal) => {
    state = { code, signal };
  });
  return () => state;
}

async function startupFailureDetail(exitState: ChildExitState, stderrPath: string): Promise<string> {
  const reason = exitState.error
    ? exitState.error.message
    : `exit code ${exitState.code ?? "<none>"}${exitState.signal ? ` signal ${exitState.signal}` : ""}`;
  const stderr = await readLogTail(stderrPath);
  return stderr ? `${reason}; stderr: ${stderr}` : reason;
}

async function readLogTail(file: string): Promise<string> {
  try {
    const content = await readFile(file, "utf8");
    return content.trim().slice(-2000);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
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

async function openAppend(file: string): Promise<number> {
  await mkdir(path.dirname(file), { recursive: true });
  return openSync(file, "a", 0o644);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
