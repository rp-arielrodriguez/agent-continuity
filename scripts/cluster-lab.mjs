#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = process.cwd();
const runId = randomUUID().slice(0, 8);
const image = `agent-continuity-cluster:${runId}`;
const network = `continuity-cluster-${runId}`;
const tmp = await mkdtemp(path.join("/tmp", "continuity-cluster-"));
const rendezvousDir = path.join(tmp, "rendezvous");
const projectId = "rp-arielrodriguez/agent-continuity-cluster-lab";
const trustedNames = "orchestrator,worker-a,worker-b";
const nodes = [
  { name: "orchestrator" },
  { name: "worker-a" },
  { name: "worker-b" },
];
const containers = [];

try {
  await mkdir(rendezvousDir, { recursive: true });

  await scenario("build clean cluster node image", async () => {
    await docker(["build", "-f", "docker/cluster-node.Dockerfile", "-t", image, "."]);
  });

  await scenario("start isolated Docker network and three clean nodes", async () => {
    await docker(["network", "create", network]);
    for (const node of nodes) {
      await docker([
        "run",
        "-d",
        "--name",
        containerName(node.name),
        "--hostname",
        node.name,
        "--network",
        network,
        "-v",
        `${rendezvousDir}:/rendezvous`,
        image,
      ]);
      containers.push(containerName(node.name));
    }
  });

  await scenario("bootstrap CLI from install.sh and publish daemon presence", async () => {
    for (const node of nodes) {
      await execIn(node.name, [
        shellJoin(["/workspace/agent-continuity/install.sh", "--from-source", "/workspace/agent-continuity", "--prefix", "/root/.local", "--no-product-install"]),
        shellJoin(["/root/.local/bin/continuity", ...nodeInitArgs(node.name)]),
      ].join("\n"));
    }
  });

  await scenario("discover all peers through file rendezvous without fixed host IPs", async () => {
    for (const node of nodes) {
      await continuity(node.name, [
        ...nodeInitArgs(node.name),
        "--no-daemon-install",
        "--no-start",
        "--no-advertise",
        "--discover",
      ]);
      const peerList = await continuity(node.name, ["peer-list"]);
      for (const other of nodes.filter((entry) => entry.name !== node.name)) {
        assertIncludes(peerList.stdout, `tcp://${other.name}:9987`, `${node.name} should trust ${other.name}`);
      }
    }
  });

  await scenario("installed container CLI runs agent harness work and syncs it to orchestrator", async () => {
    const taskId = `cluster-harness-${runId}`;
    const result = await jsonContinuity("worker-a", [
      "agent-run",
      "--project-id",
      projectId,
      "--task-id",
      taskId,
      "--lane-id",
      "main",
      "--node-id",
      "worker-a",
      "--actor-id",
      "worker-a-codex",
      "--command",
      "printf container-harness-ok",
      "--allowed-commands",
      "printf",
      "--model-id",
      "cluster-model",
      "--session-id",
      "cluster-harness-run",
      "--json",
    ]);
    assertEqual(result.exitCode, 0, "container agent-run should complete");
    assertIncludes(result.stdout, "container-harness-ok", "container agent-run should expose stdout");
    assertEqual(result.checkpoint.appended, true, "container agent-run should checkpoint");

    const sync = await peerSyncLane("orchestrator", taskId, "main");
    assertAtLeast(sync.insertedBlocks, 3, "orchestrator should import harness bootstrap, claim, and checkpoint");
    assertEqual(sync.rejectedBlocks, 0, "orchestrator should not reject container harness blocks");

    const orient = await jsonContinuity("orchestrator", [
      "orient",
      "--project-id",
      projectId,
      "--task-id",
      taskId,
      "--lane-id",
      "main",
      "--node-id",
      "orchestrator",
      "--actor-id",
      "orchestrator-reader",
      "--json",
    ]);
    assertIncludes(orient.prompt, "container-harness-ok", "orchestrator orientation should include synced command proof");
  });

  await scenario("exclusive task is completed once and later workers drop to idle after sync", async () => {
    const taskId = `cluster-exclusive-${runId}`;
    await submitTask("orchestrator", taskId, {
      title: "Exclusive cluster task",
      instructions: "Exactly one codex worker should run this task.",
      policy: "exclusive",
      agents: "codex",
      modelFamilies: "gpt",
      tools: "shell,git",
    });

    const workerA = await schedulerWorkerLoop("worker-a", taskId, {
      workerId: "worker-a-codex",
      preset: "codex",
      command: "printf worker-a-exclusive-ok",
      sync: true,
      maxRuns: 1,
    });
    assertEqual(workerA.summary.lastResult.status, "completed", "worker-a should complete exclusive task");
    assertArtifactsInclude(workerA, "worker-a-exclusive-ok");

    const workerB = await schedulerWorkerLoop("worker-b", taskId, {
      workerId: "worker-b-codex",
      preset: "codex",
      command: "printf worker-b-should-not-run",
      sync: true,
      idleLimit: 1,
    });
    assertEqual(workerB.summary.lastResult.status, "idle", "worker-b should idle after seeing worker-a result");

    await peerSync("orchestrator", taskId);
    const dashboard = await schedulerDashboard("orchestrator", taskId);
    assertEqual(dashboard.counts.completed, 1, "exclusive dashboard should show one completed task");
    assertEqual(dashboard.results.length, 1, "exclusive task should have one result");
    assertEqual(dashboard.results[0].payload.workerId, "worker-a-codex", "exclusive result should come from worker-a");
    assertArtifactsInclude(dashboard.results[0].payload, "worker-a-exclusive-ok");
  });

  await scenario("capability routing keeps incompatible workers idle", async () => {
    const taskId = `cluster-capability-${runId}`;
    await submitTask("orchestrator", taskId, {
      title: "Capability-routed task",
      instructions: "Only the opencode/anthropic/browser-capable worker should run.",
      policy: "exclusive",
      agents: "opencode",
      modelFamilies: "anthropic",
      tools: "shell,browser",
    });

    const codex = await schedulerWorkerLoop("worker-a", taskId, {
      workerId: "worker-a-codex",
      preset: "codex",
      command: "printf codex-should-not-run",
      sync: true,
      idleLimit: 1,
    });
    assertEqual(codex.summary.lastResult.status, "idle", "codex worker should not match opencode/anthropic/browser requirements");

    const opencode = await schedulerWorkerLoop("worker-b", taskId, {
      workerId: "worker-b-opencode",
      preset: "opencode",
      command: "printf worker-b-opencode-ok",
      sync: true,
      maxRuns: 1,
    });
    assertEqual(opencode.summary.lastResult.status, "completed", "opencode worker should complete capability-routed task");
    assertArtifactsInclude(opencode, "worker-b-opencode-ok");

    await peerSync("orchestrator", taskId);
    const dashboard = await schedulerDashboard("orchestrator", taskId);
    assertEqual(dashboard.results.length, 1, "capability-routed task should have one result");
    assertEqual(dashboard.results[0].payload.workerId, "worker-b-opencode", "result should come from opencode worker");
  });

  await scenario("speculative task accepts competing useful results", async () => {
    const taskId = `cluster-speculative-${runId}`;
    await submitTask("orchestrator", taskId, {
      title: "Speculative cluster task",
      instructions: "Two codex workers may compete and both publish useful results.",
      policy: "speculative",
      agents: "codex",
      modelFamilies: "gpt",
      tools: "shell,git",
    });
    await Promise.all([peerSync("worker-a", taskId), peerSync("worker-b", taskId)]);
    const [workerA, workerB] = await Promise.all([
      schedulerWorkerLoop("worker-a", taskId, {
        workerId: "worker-a-codex",
        preset: "codex",
        command: "printf worker-a-speculative-ok",
        maxRuns: 1,
      }),
      schedulerWorkerLoop("worker-b", taskId, {
        workerId: "worker-b-codex",
        preset: "codex",
        command: "printf worker-b-speculative-ok",
        maxRuns: 1,
      }),
    ]);
    assertEqual(workerA.summary.lastResult.status, "completed", "worker-a should complete speculative task");
    assertEqual(workerB.summary.lastResult.status, "completed", "worker-b should complete speculative task");

    await peerSync("orchestrator", taskId);
    const dashboard = await schedulerDashboard("orchestrator", taskId);
    const workerIds = new Set(dashboard.results.map((result) => result.payload.workerId));
    assertEqual(dashboard.results.length, 2, "speculative task should keep both results");
    assertEqual(dashboard.heads.length, 2, "offline speculative results should produce two current heads before adjudication");
    assert(workerIds.has("worker-a-codex"), "speculative dashboard should include worker-a result");
    assert(workerIds.has("worker-b-codex"), "speculative dashboard should include worker-b result");

    const winner = dashboard.results.find((result) => result.payload.workerId === "worker-b-codex");
    assert(winner, "expected worker-b result to be available for adjudication");
    await schedulerAdjudicate("orchestrator", taskId, {
      intentBlockId: dashboard.intents[0].blockId,
      resultBlockIds: dashboard.results.map((result) => result.blockId),
      winnerResultBlockId: winner.blockId,
      summary: "Selected worker-b speculative output.",
    });
    const adjudicated = await schedulerDashboard("orchestrator", taskId);
    assertEqual(adjudicated.heads.length, 1, "adjudication should collapse fork heads");
    assertEqual(adjudicated.intents[0].latestAdjudication.payload.winnerResultBlockId, winner.blockId, "dashboard should record adjudication winner");
  });

  console.log("\ncluster-lab: passed");
} finally {
  for (const name of containers.reverse()) await docker(["rm", "-f", name], { allowFailure: true });
  await docker(["network", "rm", network], { allowFailure: true });
  await docker(["rmi", "-f", image], { allowFailure: true });
  await rm(tmp, { recursive: true, force: true });
}

function nodeInitArgs(name) {
  return [
    "node-init",
    "--name",
    name,
    "--node-id",
    name,
    "--actor-id",
    `${name}-node-init`,
    "--project-id",
    projectId,
    "--peer-listen",
    ":9987",
    "--endpoint",
    `tcp://${name}:9987`,
    "--backend",
    "file",
    "--dir",
    "/rendezvous",
    "--trust-names",
    trustedNames,
    "--timeout-ms",
    "15000",
  ];
}

async function submitTask(nodeName, taskId, input) {
  return jsonContinuity(nodeName, [
    "scheduler-task-submit",
    "--project-id",
    projectId,
    "--task-id",
    taskId,
    "--lane-id",
    "scheduler",
    "--title",
    input.title,
    "--instructions",
    input.instructions,
    "--policy",
    input.policy,
    "--requires-agents",
    input.agents,
    "--requires-model-families",
    input.modelFamilies,
    "--requires-tools",
    input.tools,
    "--node-id",
    nodeName,
    "--actor-id",
    `${nodeName}-orchestrator`,
    "--json",
  ]);
}

async function schedulerWorkerLoop(nodeName, taskId, input) {
  const args = [
    "scheduler-worker-loop",
    "--project-id",
    projectId,
    "--task-id",
    taskId,
    "--lane-id",
    "scheduler",
    "--worker-id",
    input.workerId,
    "--runner",
    "command",
    "--command",
    input.command,
    "--node-id",
    nodeName,
    "--actor-id",
    `${nodeName}-${input.workerId}`,
    "--allowed-project-ids",
    projectId,
    "--allowed-commands",
    "printf",
    "--max-runner-timeout-ms",
    "5000",
    "--interval-ms",
    "0",
    "--json",
  ];
  if (input.preset) args.push("--preset", input.preset);
  else {
    args.push("--agent", input.agent, "--model-families", input.modelFamilies, "--tools", input.tools);
  }
  if (input.sync) args.push("--sync");
  if (input.maxRuns !== undefined) args.push("--max-runs", String(input.maxRuns));
  if (input.idleLimit !== undefined) args.push("--idle-limit", String(input.idleLimit));
  return jsonContinuity(nodeName, args);
}

async function peerSync(nodeName, taskId) {
  return peerSyncLane(nodeName, taskId, "scheduler");
}

async function peerSyncLane(nodeName, taskId, laneId) {
  return jsonContinuity(nodeName, [
    "peer-sync",
    "--project-id",
    projectId,
    "--task-id",
    taskId,
    "--lane-id",
    laneId,
    "--json",
  ]);
}

async function schedulerDashboard(nodeName, taskId) {
  return jsonContinuity(nodeName, [
    "scheduler-dashboard",
    "--project-id",
    projectId,
    "--task-id",
    taskId,
    "--lane-id",
    "scheduler",
    "--json",
  ]);
}

async function schedulerAdjudicate(nodeName, taskId, input) {
  return jsonContinuity(nodeName, [
    "scheduler-adjudicate",
    "--project-id",
    projectId,
    "--task-id",
    taskId,
    "--lane-id",
    "scheduler",
    "--intent-block-id",
    input.intentBlockId,
    "--result-block-ids",
    input.resultBlockIds.join(","),
    "--winner-result-block-id",
    input.winnerResultBlockId,
    "--summary",
    input.summary,
    "--json",
  ]);
}

async function jsonContinuity(nodeName, args) {
  const result = await continuity(nodeName, args);
  return JSON.parse(result.stdout);
}

async function continuity(nodeName, args) {
  return execIn(nodeName, shellJoin(["/root/.local/bin/continuity", ...args]));
}

async function execIn(nodeName, script) {
  return docker(["exec", containerName(nodeName), "bash", "-c", `set -euo pipefail\nexport PATH="/root/.local/bin:/usr/local/go/bin:$PATH"\n${script}`]);
}

async function docker(args, options = {}) {
  try {
    return await execFile("docker", args, {
      cwd: root,
      env: process.env,
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (error) {
    if (options.allowFailure) return { stdout: "", stderr: String(error) };
    const detail = [
      `docker ${args.map(String).join(" ")} failed`,
      error.stdout ? `stdout:\n${error.stdout}` : undefined,
      error.stderr ? `stderr:\n${error.stderr}` : undefined,
      error.message,
    ].filter(Boolean).join("\n");
    throw new Error(detail);
  }
}

async function scenario(name, fn) {
  process.stdout.write(`- ${name}... `);
  await fn();
  process.stdout.write("ok\n");
}

function shellJoin(args) {
  return args.map((arg) => shellQuote(String(arg))).join(" ");
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function containerName(name) {
  return `continuity-${runId}-${name}`;
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

function assertAtLeast(actual, expected, message) {
  if (typeof actual !== "number" || actual < expected) throw new Error(`${message}: expected >= ${expected}, got ${actual}`);
}

function assertIncludes(value, expected, message = "expected value to include substring") {
  if (!String(value).includes(expected)) throw new Error(`${message}: missing ${expected}\n${value}`);
}

function assertArtifactsInclude(result, expected) {
  const artifacts = result.artifacts ?? result.resultBlock?.payload?.artifacts ?? result.summary?.lastResult?.resultBlock?.payload?.artifacts ?? [];
  assertIncludes(artifacts.join("\n"), expected, "expected scheduler artifacts to include command output");
}
