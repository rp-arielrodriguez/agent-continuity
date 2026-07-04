import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

test("cross-machine resume syncs from a trusted peer address book", async (t) => {
  const root = process.cwd();
  const daemonBinary = path.join(root, "dist/bin/continuityd");
  try {
    await stat(daemonBinary);
  } catch {
    t.skip("dist/bin/continuityd is not built; run npm run test:e2e");
    return;
  }

  const cli = path.join(root, "dist/src/cli.js");
  const tmp = await mkdtemp(path.join(os.tmpdir(), "continuity-e2e-"));
  const remote = daemonPaths(tmp, "remote");
  const local = daemonPaths(tmp, "local");
  const env = {
    ...process.env,
    CONTINUITY_HOME: path.join(tmp, "home"),
    CONTINUITY_DATABASE_URL: "",
    ABSURD_DATABASE_URL: "",
  };
  const processes: ChildProcess[] = [];

  try {
    processes.push(await startDaemon(daemonBinary, remote));
    processes.push(await startDaemon(daemonBinary, local));

    await execFile(process.execPath, [
      cli,
      "checkpoint",
      "--daemon",
      "--socket",
      remote.socket,
      "--state-dir",
      remote.stateDir,
      "--project-id",
      "rp-arielrodriguez/agent-continuity-e2e",
      "--task-id",
      "multi-daemon-e2e",
      "--status",
      "in_progress",
      "--progress",
      "Remote checkpoint from multi-daemon e2e.",
      "--next",
      "Resume from synced daemon canon.",
      "--timestamp",
      "2026-07-04T12:00:00.000Z",
      "--model-id",
      "e2e-model",
      "--session-id",
      "e2e-session",
      "--node-id",
      "remote-node",
      "--actor-id",
      "remote-agent",
    ], { env });

    await execFile(process.execPath, [
      cli,
      "peer-add",
      "--socket",
      local.socket,
      "--endpoint",
      `unix://${remote.socket}`,
      "--name",
      "remote-node",
      "--provider",
      "unix",
    ], { env });

    const sync = await execFile(process.execPath, [
      cli,
      "peer-sync",
      "--socket",
      local.socket,
      "--project-id",
      "rp-arielrodriguez/agent-continuity-e2e",
      "--task-id",
      "multi-daemon-e2e",
      "--json",
    ], { env });
    const syncResult = JSON.parse(sync.stdout) as { insertedBlocks: number; peers: Array<{ endpoint: string; error?: string }> };
    assert.equal(syncResult.insertedBlocks, 3);
    assert.equal(syncResult.peers[0].endpoint, `unix://${remote.socket}`);
    assert.equal(syncResult.peers[0].error, undefined);

    const resume = await execFile(process.execPath, [
      cli,
      "resume",
      "--daemon",
      "--sync",
      "--socket",
      local.socket,
      "--project-id",
      "rp-arielrodriguez/agent-continuity-e2e",
      "--task-id",
      "multi-daemon-e2e",
    ], { env });

    assert.match(resume.stdout, /Remote checkpoint from multi-daemon e2e\./);
    assert.match(resume.stdout, /Resume from synced daemon canon\./);
  } finally {
    for (const process of processes.reverse()) {
      await stopDaemon(process);
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

function daemonPaths(root: string, name: string): { stateDir: string; socket: string; db: string } {
  const stateDir = path.join(root, name);
  return {
    stateDir,
    socket: path.join(stateDir, "continuityd.sock"),
    db: path.join(stateDir, "continuity.db"),
  };
}

async function startDaemon(binary: string, paths: { socket: string; db: string }): Promise<ChildProcess> {
  const child = spawn(binary, ["--socket", paths.socket, "--db", paths.db], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  child.once("exit", (code, signal) => {
    if (code !== null && code !== 0) stderr += `continuityd exited with code ${code}\n`;
    if (signal) stderr += `continuityd exited with signal ${signal}\n`;
  });

  await waitForSocket(paths.socket, () => stderr);
  return child;
}

async function stopDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForSocket(socketPath: string, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await canConnect(socketPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`daemon socket was not ready at ${socketPath}: ${stderr()}`);
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}
