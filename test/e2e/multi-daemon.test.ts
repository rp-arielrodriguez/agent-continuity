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
  const fresh = daemonPaths(tmp, "fresh");
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
    processes.push(await startDaemon(daemonBinary, fresh));

    const harnessTaskId = "agent-harness-e2e";
    const claim = await execFile(process.execPath, [
      cli,
      "claim",
      "--socket",
      local.socket,
      "--state-dir",
      local.stateDir,
      "--project-id",
      "rp-arielrodriguez/agent-continuity-e2e",
      "--task-id",
      harnessTaskId,
      "--node-id",
      "local-node",
      "--actor-id",
      "codex-e2e",
      "--lease-until",
      "2026-07-06T10:10:00.000Z",
      "--now",
      "2026-07-06T10:00:00.000Z",
      "--json",
    ], { env });
    const claimResult = JSON.parse(claim.stdout) as { action: string; lane: { owner?: { actorId: string } } };
    assert.equal(claimResult.action, "continue");
    assert.equal(claimResult.lane.owner?.actorId, "codex-e2e");

    const orient = await execFile(process.execPath, [
      cli,
      "orient",
      "--socket",
      local.socket,
      "--state-dir",
      local.stateDir,
      "--project-id",
      "rp-arielrodriguez/agent-continuity-e2e",
      "--task-id",
      harnessTaskId,
      "--node-id",
      "local-node",
      "--actor-id",
      "codex-e2e",
      "--now",
      "2026-07-06T10:01:00.000Z",
      "--json",
    ], { env });
    const orientResult = JSON.parse(orient.stdout) as { prompt: string; action: string };
    assert.equal(orientResult.action, "continue");
    assert.match(orientResult.prompt, /<continuity-orient>/);
    assert.match(orientResult.prompt, /owner: local-node\/codex-e2e/);

    const save = await execFile(process.execPath, [
      cli,
      "save",
      "--socket",
      local.socket,
      "--state-dir",
      local.stateDir,
      "--project-id",
      "rp-arielrodriguez/agent-continuity-e2e",
      "--task-id",
      harnessTaskId,
      "--node-id",
      "local-node",
      "--actor-id",
      "codex-e2e",
      "--timestamp",
      "2026-07-06T10:02:00.000Z",
      "--model-id",
      "e2e-model",
      "--session-id",
      "e2e-save",
      "--status",
      "in_progress",
      "--progress",
      "Agent harness e2e save checkpoint.",
      "--next",
      "Run agent command.",
      "--json",
    ], { env });
    const saveResult = JSON.parse(save.stdout) as { appended: boolean; blockId?: string };
    assert.equal(saveResult.appended, true);
    assert.match(saveResult.blockId ?? "", /^blk_/);

    const agentRun = await execFile(process.execPath, [
      cli,
      "agent-run",
      "--socket",
      local.socket,
      "--state-dir",
      local.stateDir,
      "--project-id",
      "rp-arielrodriguez/agent-continuity-e2e",
      "--task-id",
      harnessTaskId,
      "--node-id",
      "local-node",
      "--actor-id",
      "codex-e2e",
      "--command",
      `${process.execPath} -e ${JSON.stringify("console.log(process.env.CONTINUITY_TASK_ID); console.log(process.env.CONTINUITY_ACTOR_ID);")}`,
      "--allowed-commands",
      process.execPath,
      "--timestamp",
      "2026-07-06T10:03:00.000Z",
      "--model-id",
      "e2e-model",
      "--session-id",
      "e2e-agent-run",
      "--json",
    ], { env });
    const agentRunResult = JSON.parse(agentRun.stdout) as { exitCode: number; stdout: string; checkpoint?: { appended: boolean } };
    assert.equal(agentRunResult.exitCode, 0);
    assert.match(agentRunResult.stdout, /agent-harness-e2e/);
    assert.match(agentRunResult.stdout, /codex-e2e/);
    assert.equal(agentRunResult.checkpoint?.appended, true);

    const handoff = await execFile(process.execPath, [
      cli,
      "handoff",
      "--socket",
      local.socket,
      "--state-dir",
      local.stateDir,
      "--project-id",
      "rp-arielrodriguez/agent-continuity-e2e",
      "--task-id",
      harnessTaskId,
      "--node-id",
      "local-node",
      "--actor-id",
      "codex-e2e",
      "--target-node-id",
      "local-node",
      "--target-actor-id",
      "claude-e2e",
      "--lease-until",
      "2026-07-06T10:20:00.000Z",
      "--now",
      "2026-07-06T10:04:00.000Z",
      "--json",
    ], { env });
    const handoffResult = JSON.parse(handoff.stdout) as { accepted: boolean; lane: { owner?: { actorId: string } } };
    assert.equal(handoffResult.accepted, true);
    assert.equal(handoffResult.lane.owner?.actorId, "claude-e2e");

    const release = await execFile(process.execPath, [
      cli,
      "handoff",
      "--socket",
      local.socket,
      "--state-dir",
      local.stateDir,
      "--project-id",
      "rp-arielrodriguez/agent-continuity-e2e",
      "--task-id",
      harnessTaskId,
      "--node-id",
      "local-node",
      "--actor-id",
      "claude-e2e",
      "--reason",
      "e2e handoff accepted",
      "--now",
      "2026-07-06T10:05:00.000Z",
      "--json",
    ], { env });
    const releaseResult = JSON.parse(release.stdout) as { accepted: boolean; lane: { owner?: unknown } };
    assert.equal(releaseResult.accepted, true);
    assert.equal(releaseResult.lane.owner, undefined);

    const blobTaskId = "blob-cli-e2e";
    const largeCanon = "# Canon: blob-cli-e2e\n\n" + "large canonical state\n".repeat(200);
    await execFile(process.execPath, [
      cli,
      "checkpoint",
      "--daemon",
      "--socket",
      local.socket,
      "--state-dir",
      local.stateDir,
      "--project-id",
      "rp-arielrodriguez/agent-continuity-e2e",
      "--task-id",
      blobTaskId,
      "--status",
      "in_progress",
      "--progress",
      "Large canon stored through blob-backed daemon checkpoint.",
      "--canon",
      largeCanon,
      "--timestamp",
      "2026-07-06T10:06:00.000Z",
      "--model-id",
      "e2e-model",
      "--session-id",
      "e2e-blob",
      "--node-id",
      "local-node",
      "--actor-id",
      "blob-e2e",
    ], { env });
    const blobInventory = await execFile(process.execPath, [
      cli,
      "lane-inventory",
      "--socket",
      local.socket,
      "--project-id",
      "rp-arielrodriguez/agent-continuity-e2e",
      "--task-id",
      blobTaskId,
      "--lane-id",
      "main",
      "--json",
    ], { env });
    const blobInventoryResult = JSON.parse(blobInventory.stdout) as { blocks: Array<{ blobDigests?: string[] }> };
    const digest = blobInventoryResult.blocks.flatMap((block) => block.blobDigests ?? [])[0];
    assert.match(digest ?? "", /^sha256:/);
    const blob = await execFile(process.execPath, [
      cli,
      "blob-get",
      "--socket",
      local.socket,
      "--digest",
      digest,
    ], { env });
    assert.match(blob.stdout, /large canonical state/);

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
    const syncResult = JSON.parse(sync.stdout) as { advertisedBlocks: number; missingBlocks: number; fetchedBlocks: number; insertedBlocks: number; peers: Array<{ endpoint: string; error?: string }> };
    assert.equal(syncResult.advertisedBlocks, 3);
    assert.equal(syncResult.missingBlocks, 3);
    assert.equal(syncResult.fetchedBlocks, 3);
    assert.equal(syncResult.insertedBlocks, 3);
    assert.equal(syncResult.peers[0].endpoint, `unix://${remote.socket}`);
    assert.equal(syncResult.peers[0].error, undefined);

    const repeatSync = await execFile(process.execPath, [
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
    const repeatSyncResult = JSON.parse(repeatSync.stdout) as { advertisedBlocks: number; missingBlocks: number; fetchedBlocks: number; insertedBlocks: number };
    assert.equal(repeatSyncResult.advertisedBlocks, 3);
    assert.equal(repeatSyncResult.missingBlocks, 0);
    assert.equal(repeatSyncResult.fetchedBlocks, 0);
    assert.equal(repeatSyncResult.insertedBlocks, 0);

    const localInventory = await execFile(process.execPath, [
      cli,
      "lane-inventory",
      "--socket",
      local.socket,
      "--project-id",
      "rp-arielrodriguez/agent-continuity-e2e",
      "--task-id",
      "multi-daemon-e2e",
      "--lane-id",
      "main",
      "--json",
    ], { env });
    const localInventoryResult = JSON.parse(localInventory.stdout) as { blockCount: number; archivedCount: number };
    assert.equal(localInventoryResult.blockCount, 3);
    assert.equal(localInventoryResult.archivedCount, 0);

    const snapshot = await execFile(process.execPath, [
      cli,
      "lane-snapshot",
      "--socket",
      remote.socket,
      "--state-dir",
      remote.stateDir,
      "--project-id",
      "rp-arielrodriguez/agent-continuity-e2e",
      "--task-id",
      "multi-daemon-e2e",
      "--lane-id",
      "main",
      "--node-id",
      "remote-node",
      "--actor-id",
      "remote-agent",
      "--summary",
      "Compacted multi-daemon e2e lane.",
      "--now",
      "2026-07-04T12:01:00.000Z",
      "--json",
    ], { env });
    const snapshotResult = JSON.parse(snapshot.stdout) as { accepted: boolean; block?: { blockId: string }; lane: { tip?: string } };
    assert.equal(snapshotResult.accepted, true);
    assert.equal(snapshotResult.lane.tip, snapshotResult.block?.blockId);

    const retention = await execFile(process.execPath, [
      cli,
      "lane-retain",
      "--socket",
      remote.socket,
      "--project-id",
      "rp-arielrodriguez/agent-continuity-e2e",
      "--task-id",
      "multi-daemon-e2e",
      "--lane-id",
      "main",
      "--keep-recent",
      "1",
      "--reason",
      "multi-daemon e2e compaction",
      "--now",
      "2026-07-04T12:02:00.000Z",
      "--json",
    ], { env });
    const retentionResult = JSON.parse(retention.stdout) as { archivedBlocks: number; activeBlocks: number; latestSnapshot?: string };
    assert.equal(retentionResult.archivedBlocks, 3);
    assert.equal(retentionResult.activeBlocks, 1);
    assert.equal(retentionResult.latestSnapshot, snapshotResult.block?.blockId);

    const compactedInventory = await execFile(process.execPath, [
      cli,
      "lane-inventory",
      "--socket",
      remote.socket,
      "--project-id",
      "rp-arielrodriguez/agent-continuity-e2e",
      "--task-id",
      "multi-daemon-e2e",
      "--lane-id",
      "main",
      "--json",
    ], { env });
    const compactedInventoryResult = JSON.parse(compactedInventory.stdout) as { blockCount: number; archivedCount: number; blocks: Array<{ kind: string }> };
    assert.equal(compactedInventoryResult.blockCount, 1);
    assert.equal(compactedInventoryResult.archivedCount, 3);
    assert.equal(compactedInventoryResult.blocks[0].kind, "lane_snapshot");

    await execFile(process.execPath, [
      cli,
      "peer-add",
      "--socket",
      fresh.socket,
      "--endpoint",
      `unix://${remote.socket}`,
      "--name",
      "remote-node",
      "--provider",
      "unix",
    ], { env });
    const freshSync = await execFile(process.execPath, [
      cli,
      "peer-sync",
      "--socket",
      fresh.socket,
      "--project-id",
      "rp-arielrodriguez/agent-continuity-e2e",
      "--task-id",
      "multi-daemon-e2e",
      "--json",
    ], { env });
    const freshSyncResult = JSON.parse(freshSync.stdout) as { advertisedBlocks: number; missingBlocks: number; fetchedBlocks: number; insertedBlocks: number };
    assert.equal(freshSyncResult.advertisedBlocks, 1);
    assert.equal(freshSyncResult.missingBlocks, 1);
    assert.equal(freshSyncResult.fetchedBlocks, 1);
    assert.equal(freshSyncResult.insertedBlocks, 1);

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

    const freshResume = await execFile(process.execPath, [
      cli,
      "resume",
      "--daemon",
      "--socket",
      fresh.socket,
      "--project-id",
      "rp-arielrodriguez/agent-continuity-e2e",
      "--task-id",
      "multi-daemon-e2e",
    ], { env });
    assert.match(freshResume.stdout, /Remote checkpoint from multi-daemon e2e\./);
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
