#!/usr/bin/env node
import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = process.cwd();
const cli = path.join(root, "dist/src/cli.js");
const daemonBinary = path.join(root, "dist/bin/continuityd");
const projectId = "rp-arielrodriguez/agent-continuity-acceptance";
const taskId = "acceptance-smoke";
const schedulerTaskId = "scheduler-acceptance-smoke";

await assertBuilt();

const tmp = await mkdtemp(path.join(os.tmpdir(), "continuity-acceptance-"));
const processes = [];
let httpServer;

try {
  const env = {
    ...process.env,
    CONTINUITY_HOME: path.join(tmp, "home"),
    CONTINUITY_DATABASE_URL: "",
    ABSURD_DATABASE_URL: "",
    GIT_AUTHOR_NAME: "Continuity Acceptance",
    GIT_AUTHOR_EMAIL: "continuity@example.local",
    GIT_COMMITTER_NAME: "Continuity Acceptance",
    GIT_COMMITTER_EMAIL: "continuity@example.local",
  };

  const sourcePort = await freePort();
  const targetPort = await freePort();
  const source = daemonPaths(tmp, "source");
  const target = daemonPaths(tmp, "target");
  const sourceEndpoint = `tcp://127.0.0.1:${sourcePort}`;
  const targetEndpoint = `tcp://127.0.0.1:${targetPort}`;

  await scenario("start two temporary daemons with read-only peer listeners", async () => {
    processes.push(await startDaemon(daemonBinary, source, sourcePort));
    processes.push(await startDaemon(daemonBinary, target, targetPort));
    await run(["daemon-status", "--socket", source.socket, "--db", source.db], { env });
    await run(["daemon-status", "--socket", target.socket, "--db", target.db], { env });
  });

  await scenario("source daemon accepts a checkpoint", async () => {
    await run([
      "checkpoint",
      "--daemon",
      "--socket",
      source.socket,
      "--state-dir",
      source.stateDir,
      "--project-id",
      projectId,
      "--task-id",
      taskId,
      "--status",
      "in_progress",
      "--progress",
      "Source checkpoint from acceptance smoke.",
      "--next",
      "Target should sync and resume this canon.",
      "--timestamp",
      "2026-07-05T21:00:00.000Z",
      "--model-id",
      "acceptance-model",
      "--session-id",
      "acceptance-session",
      "--node-id",
      "source-node",
      "--actor-id",
      "source-agent",
    ], { env });
  });

  await scenario("daemon-managed mDNS lifecycle is controllable", async () => {
    const name = `acceptance-${randomUUID().slice(0, 8)}`;
    const stopped = await run(["mdns-advertise-status", "--daemon", "--socket", source.socket, "--state-dir", source.stateDir], { env });
    assertIncludes(stopped.stdout, "mDNS advertiser: stopped");
    await run([
      "mdns-advertise",
      "--daemon",
      "--socket",
      source.socket,
      "--state-dir",
      source.stateDir,
      "--port",
      String(sourcePort),
      "--host",
      "acceptance-source",
      "--name",
      name,
      "--project-id",
      projectId,
    ], { env });
    const running = await run(["mdns-advertise-status", "--daemon", "--socket", source.socket, "--state-dir", source.stateDir], { env });
    assertIncludes(running.stdout, "mDNS advertiser: running");
    const duplicate = await run([
      "mdns-advertise",
      "--daemon",
      "--socket",
      source.socket,
      "--state-dir",
      source.stateDir,
      "--port",
      String(sourcePort),
      "--host",
      "acceptance-source",
      "--name",
      name,
    ], { env, expectFailure: true });
    assertIncludes(duplicate.stderr, "mDNS advertiser is already running");
    await run(["mdns-advertise-stop", "--daemon", "--socket", source.socket, "--state-dir", source.stateDir], { env });
    const stoppedAgain = await run(["mdns-advertise-status", "--daemon", "--socket", source.socket, "--state-dir", source.stateDir], { env });
    assertIncludes(stoppedAgain.stdout, "mDNS advertiser: stopped");
  });

  await scenario("file rendezvous publishes and discovers signed presence", async () => {
    const dir = path.join(tmp, "file-rendezvous");
    await run([
      "rendezvous-publish",
      "--backend",
      "file",
      "--dir",
      dir,
      "--endpoint",
      sourceEndpoint,
      "--name",
      "file-source",
      "--node-id",
      "file-source",
      "--state-dir",
      path.join(tmp, "file-state"),
      "--project-id",
      projectId,
    ], { env });
    const discovered = await run([
      "rendezvous-discover",
      "--backend",
      "file",
      "--dir",
      dir,
      "--trusted-names",
      "file-source",
      "--project-id",
      projectId,
    ], { env });
    assertIncludes(discovered.stdout, sourceEndpoint);
  });

  const gitRemote = path.join(tmp, "rendezvous.git");
  await scenario("git rendezvous discovers source and adds trusted peer", async () => {
    await execFile("git", ["init", "--bare", gitRemote], { env });
    await run([
      "rendezvous-publish",
      "--backend",
      "git",
      "--repo",
      gitRemote,
      "--branch",
      "continuity-rendezvous",
      "--dir",
      "rendezvous",
      "--worktree",
      path.join(tmp, "git-publisher"),
      "--endpoint",
      sourceEndpoint,
      "--name",
      "source-node",
      "--node-id",
      "source-node",
      "--state-dir",
      source.stateDir,
      "--project-id",
      projectId,
    ], { env });
    const guard = await run([
      "rendezvous-discover",
      "--backend",
      "git",
      "--repo",
      gitRemote,
      "--branch",
      "continuity-rendezvous",
      "--dir",
      "rendezvous",
      "--worktree",
      path.join(tmp, "git-guard-reader"),
      "--project-id",
      projectId,
      "--add",
    ], { env, expectFailure: true });
    assertIncludes(guard.stderr, "trusted");
    const discovered = await run([
      "rendezvous-discover",
      "--backend",
      "git",
      "--repo",
      gitRemote,
      "--branch",
      "continuity-rendezvous",
      "--dir",
      "rendezvous",
      "--worktree",
      path.join(tmp, "git-reader"),
      "--socket",
      target.socket,
      "--state-dir",
      target.stateDir,
      "--project-id",
      projectId,
      "--trusted-names",
      "source-node",
      "--add",
    ], { env });
    assertIncludes(discovered.stdout, sourceEndpoint);
    assertIncludes(discovered.stdout, "trusted: 1");
  });

  await scenario("HTTPS rendezvous publishes with PUT and discovers from index", async () => {
    const store = new Map();
    httpServer = http.createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      response.setHeader("connection", "close");
      if (request.method === "PUT") {
        let body = "";
        request.setEncoding("utf8");
        for await (const chunk of request) body += chunk;
        store.set(url.pathname, body);
        response.writeHead(204).end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/rendezvous/index.json") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ files: [...store.keys()].map((entry) => path.basename(entry)) }));
        return;
      }
      if (request.method === "GET" && store.has(url.pathname)) {
        response.setHeader("content-type", "application/json");
        response.end(store.get(url.pathname));
        return;
      }
      response.writeHead(404).end();
    });
    const port = await listenHttp(httpServer);
    const url = `http://127.0.0.1:${port}/rendezvous`;
    await run([
      "rendezvous-publish",
      "--backend",
      "https",
      "--url",
      url,
      "--endpoint",
      sourceEndpoint,
      "--name",
      "https-source",
      "--node-id",
      "https-source",
      "--state-dir",
      path.join(tmp, "https-state"),
      "--project-id",
      projectId,
    ], { env });
    const discovered = await run([
      "rendezvous-discover",
      "--backend",
      "https",
      "--url",
      url,
      "--trusted-names",
      "https-source",
      "--project-id",
      projectId,
    ], { env });
    assertIncludes(discovered.stdout, sourceEndpoint);
  });

  await scenario("S3-compatible rendezvous uses aws cp/sync contract", async () => {
    const fakeAws = path.join(tmp, "fake-aws.mjs");
    await writeFile(fakeAws, fakeAwsScript(), "utf8");
    await chmod(fakeAws, 0o755);
    const url = "s3://acceptance-bucket/continuity";
    await run([
      "rendezvous-publish",
      "--backend",
      "s3",
      "--url",
      url,
      "--aws-bin",
      fakeAws,
      "--s3-endpoint-url",
      "https://r2.example.local",
      "--endpoint",
      sourceEndpoint,
      "--name",
      "s3-source",
      "--node-id",
      "s3-source",
      "--state-dir",
      path.join(tmp, "s3-state"),
      "--project-id",
      projectId,
    ], { env });
    const discovered = await run([
      "rendezvous-discover",
      "--backend",
      "s3",
      "--url",
      url,
      "--aws-bin",
      fakeAws,
      "--s3-endpoint-url",
      "https://r2.example.local",
      "--trusted-names",
      "s3-source",
      "--project-id",
      projectId,
    ], { env });
    assertIncludes(discovered.stdout, sourceEndpoint);
  });

  await scenario("trusted peer sync, resume, and repeat sync are correct", async () => {
    const peerList = await run(["peer-list", "--socket", target.socket], { env });
    assertIncludes(peerList.stdout, sourceEndpoint);
    const sync = await run([
      "peer-sync",
      "--socket",
      target.socket,
      "--project-id",
      projectId,
      "--task-id",
      taskId,
      "--json",
    ], { env });
    const syncResult = JSON.parse(sync.stdout);
    assertAtLeast(syncResult.insertedBlocks, 3, "expected initial sync to insert remote blocks");
    assertEqual(syncResult.rejectedBlocks, 0, "expected no rejected blocks on initial sync");

    const resume = await run([
      "resume",
      "--daemon",
      "--sync",
      "--socket",
      target.socket,
      "--project-id",
      projectId,
      "--task-id",
      taskId,
    ], { env });
    assertIncludes(resume.stdout, "Source checkpoint from acceptance smoke.");
    assertIncludes(resume.stdout, "Target should sync and resume this canon.");

    const repeat = await run([
      "peer-sync",
      "--socket",
      target.socket,
      "--project-id",
      projectId,
      "--task-id",
      taskId,
      "--json",
    ], { env });
    const repeatResult = JSON.parse(repeat.stdout);
    assertEqual(repeatResult.insertedBlocks, 0, "expected repeat sync to be idempotent");
    assertEqual(repeatResult.rejectedBlocks, 0, "expected no rejected blocks on repeat sync");
  });

  await scenario("distributed scheduler task is executed on target and synced back to source", async () => {
    const submitted = await run([
      "scheduler-task-submit",
      "--socket",
      source.socket,
      "--state-dir",
      source.stateDir,
      "--project-id",
      projectId,
      "--task-id",
      schedulerTaskId,
      "--lane-id",
      "scheduler",
      "--title",
      "Distributed scheduler smoke",
      "--instructions",
      "Use the fake worker to produce a deterministic result.",
      "--requires-agents",
      "codex",
      "--requires-model-families",
      "gpt",
      "--requires-tools",
      "shell,git",
      "--node-id",
      "source-node",
      "--actor-id",
      "source-orchestrator",
      "--now",
      "2026-07-05T21:10:00.000Z",
      "--json",
    ], { env });
    const submittedResult = JSON.parse(submitted.stdout);
    assertIncludes(submittedResult.block.blockId, "blk_");

    const targetInitialSync = await run([
      "peer-sync",
      "--socket",
      target.socket,
      "--project-id",
      projectId,
      "--task-id",
      schedulerTaskId,
      "--lane-id",
      "scheduler",
      "--json",
    ], { env });
    const targetInitialSyncResult = JSON.parse(targetInitialSync.stdout);
    assertAtLeast(targetInitialSyncResult.insertedBlocks, 2, "expected target to import scheduler bootstrap and intent");
    assertEqual(targetInitialSyncResult.rejectedBlocks, 0, "expected no target scheduler sync rejections");

    const targetRun = await run([
      "scheduler-worker-loop",
      "--socket",
      target.socket,
      "--state-dir",
      target.stateDir,
      "--project-id",
      projectId,
      "--task-id",
      schedulerTaskId,
      "--lane-id",
      "scheduler",
      "--worker-id",
      "target-codex",
      "--agent",
      "codex",
      "--model-families",
      "gpt",
      "--tools",
      "shell,git",
      "--node-id",
      "target-node",
      "--actor-id",
      "target-worker",
      "--max-runs",
      "1",
      "--interval-ms",
      "0",
      "--json",
    ], { env });
    const targetRunResult = JSON.parse(targetRun.stdout);
    assertEqual(targetRunResult.summary.lastResult.status, "completed", "expected target worker to complete scheduler task");
    assertIncludes(targetRunResult.summary.lastResult.resultBlock.blockId, "blk_");

    await run([
      "peer-add",
      "--socket",
      source.socket,
      "--endpoint",
      targetEndpoint,
      "--name",
      "target-node",
      "--provider",
      "acceptance",
    ], { env });

    const sourceResultSync = await run([
      "peer-sync",
      "--socket",
      source.socket,
      "--project-id",
      projectId,
      "--task-id",
      schedulerTaskId,
      "--lane-id",
      "scheduler",
      "--json",
    ], { env });
    const sourceResultSyncResult = JSON.parse(sourceResultSync.stdout);
    assertAtLeast(sourceResultSyncResult.insertedBlocks, 3, "expected source to import worker profile, assignment, and result");
    assertEqual(sourceResultSyncResult.rejectedBlocks, 0, "expected no source scheduler result sync rejections");

    const dashboard = await run([
      "scheduler-dashboard",
      "--socket",
      source.socket,
      "--project-id",
      projectId,
      "--task-id",
      schedulerTaskId,
      "--lane-id",
      "scheduler",
      "--json",
    ], { env });
    const dashboardResult = JSON.parse(dashboard.stdout);
    assertEqual(dashboardResult.counts.completed, 1, "expected source scheduler dashboard to show completed task");
    assertEqual(dashboardResult.results[0].payload.workerId, "target-codex", "expected result to come from target worker");
  });

  console.log("\nacceptance-smoke: passed");
} finally {
  if (httpServer) await closeHttp(httpServer);
  for (const child of processes.reverse()) await stopDaemon(child);
  await rm(tmp, { recursive: true, force: true });
}

async function assertBuilt() {
  try {
    await stat(cli);
    await stat(daemonBinary);
  } catch {
    throw new Error("dist CLI and daemon are required; run npm run build:all first");
  }
}

async function scenario(name, fn) {
  process.stdout.write(`- ${name}... `);
  await fn();
  process.stdout.write("ok\n");
}

function daemonPaths(rootDir, name) {
  const stateDir = path.join(rootDir, name);
  return {
    stateDir,
    socket: path.join(stateDir, "continuityd.sock"),
    db: path.join(stateDir, "continuity.db"),
  };
}

async function startDaemon(binary, paths, peerPort) {
  await mkdir(paths.stateDir, { recursive: true });
  const child = spawn(binary, ["--socket", paths.socket, "--db", paths.db, "--peer-listen", `127.0.0.1:${peerPort}`], {
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

async function stopDaemon(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
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

async function waitForSocket(socketPath, stderr) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await canConnect(socketPath)) return;
    await delay(25);
  }
  throw new Error(`daemon socket was not ready at ${socketPath}: ${stderr()}`);
}

function canConnect(socketPath) {
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

function run(args, options = {}) {
  const env = options.env ?? process.env;
  return execFile(process.execPath, [cli, ...args], { env, timeout: options.timeout ?? 15000 })
    .then((result) => {
      if (options.expectFailure) throw new Error(`expected command to fail: continuity ${args.join(" ")}`);
      return result;
    })
    .catch((error) => {
      if (!options.expectFailure) {
        const stderr = error.stderr ? `\nstderr:\n${error.stderr}` : "";
        const stdout = error.stdout ? `\nstdout:\n${error.stdout}` : "";
        throw new Error(`continuity ${args.join(" ")} failed: ${error.message}${stdout}${stderr}`);
      }
      return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code };
    });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("failed to allocate a free port");
  return port;
}

function listenHttp(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || !address) throw new Error("HTTP server did not expose an address");
      resolve(address.port);
    });
  });
}

function closeHttp(server) {
  return new Promise((resolve) => server.close(resolve));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertIncludes(value, expected) {
  if (!value.includes(expected)) throw new Error(`expected output to include ${JSON.stringify(expected)}, got:\n${value}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

function assertAtLeast(actual, expected, message) {
  if (typeof actual !== "number" || actual < expected) throw new Error(`${message}: expected >= ${expected}, got ${actual}`);
}

function fakeAwsScript() {
  return `#!/usr/bin/env node
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "fake-s3");
const args = process.argv.slice(2);
while (args[0]?.startsWith("--")) args.splice(0, args[0] === "--endpoint-url" || args[0] === "--profile" ? 2 : 1);
const [namespace, command, first, second] = args;
if (namespace !== "s3") throw new Error("expected s3 namespace");

function s3Path(value) {
  const url = new URL(value);
  return path.join(root, url.hostname, decodeURIComponent(url.pathname));
}

if (command === "cp") {
  const target = s3Path(second);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(first, target);
} else if (command === "sync") {
  await mkdir(second, { recursive: true });
  await cp(s3Path(first), second, { recursive: true });
} else {
  throw new Error("unsupported command " + command);
}
`;
}
