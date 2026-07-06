#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = process.cwd();
const defaultStateFile = path.join(os.tmpdir(), "agent-continuity-cluster-playground.json");
const baseNodes = [
  { name: "orchestrator" },
  { name: "worker-a" },
  { name: "worker-b" },
];

const parsed = parseArgs(process.argv.slice(2));
const command = parsed.command || "help";
const stateFile = parsed.options.state ?? process.env.CONTINUITY_CLUSTER_STATE ?? defaultStateFile;

switch (command) {
  case "up":
    await up({ fresh: parsed.options.fresh === true });
    break;
  case "demo":
    await demo({ fresh: parsed.options.fresh === true });
    break;
  case "status":
    await status();
    break;
  case "down":
    await down({ missingOk: true });
    break;
  case "exec":
    await execCommand(parsed.rest);
    break;
  case "help":
  case "--help":
  case "-h":
    printHelp();
    break;
  default:
    throw new Error(`unknown command: ${command}`);
}

async function up({ fresh }) {
  if (fresh) await down({ missingOk: true });
  const existing = await readStateIfExists();
  if (existing) {
    console.log(`playground already exists: ${existing.runId}`);
    console.log(`state: ${stateFile}`);
    console.log(`run: npm run cluster:playground -- status`);
    return existing;
  }

  const runId = randomUUID().slice(0, 8);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "continuity-playground-"));
  const state = {
    runId,
    image: `agent-continuity-playground:${runId}`,
    network: `continuity-playground-${runId}`,
    tmp,
    rendezvousDir: path.join(tmp, "rendezvous"),
    projectId: `rp-arielrodriguez/agent-continuity-playground-${runId}`,
    trustedNames: baseNodes.map((node) => node.name).join(","),
    nodes: baseNodes,
    tasks: [],
  };

  try {
    await mkdir(state.rendezvousDir, { recursive: true });
    await saveState(state);

    await scenario("build playground node image", async () => {
      await docker(["build", "-f", "docker/cluster-node.Dockerfile", "-t", state.image, "."]);
    });

    await scenario("start playground network and nodes", async () => {
      await docker(["network", "create", state.network]);
      for (const node of state.nodes) {
        await docker([
          "run",
          "-d",
          "--name",
          containerName(state, node.name),
          "--hostname",
          node.name,
          "--network",
          state.network,
          "--label",
          `agent-continuity-playground=${state.runId}`,
          "-v",
          `${state.rendezvousDir}:/rendezvous`,
          state.image,
        ]);
      }
    });

    await scenario("bootstrap continuity and publish node presence", async () => {
      for (const node of state.nodes) {
        await execIn(state, node.name, [
          shellJoin(["/workspace/agent-continuity/install.sh", "--from-source", "/workspace/agent-continuity", "--prefix", "/root/.local", "--no-product-install"]),
          shellJoin(["/root/.local/bin/continuity", ...nodeInitArgs(state, node.name)]),
        ].join("\n"));
      }
    });

    await scenario("discover and trust all playground peers", async () => {
      for (const node of state.nodes) {
        await continuity(state, node.name, [
          ...nodeInitArgs(state, node.name),
          "--no-daemon-install",
          "--no-start",
          "--no-advertise",
          "--discover",
        ]);
      }
    });

    console.log(`\nplayground: ${state.runId}`);
    console.log(`state: ${stateFile}`);
    console.log(`project: ${state.projectId}`);
    console.log("next:");
    console.log("  npm run cluster:playground -- demo");
    console.log("  npm run cluster:playground -- status");
    console.log("  npm run cluster:playground -- exec orchestrator -- continuity peer-list");
    console.log("  npm run cluster:playground -- down");
    return state;
  } catch (error) {
    console.error(`\nup failed: ${error instanceof Error ? error.message : String(error)}`);
    await down({ missingOk: true, stateOverride: state });
    throw error;
  }
}

async function demo({ fresh }) {
  if (fresh) await down({ missingOk: true });
  const state = (await readStateIfExists()) ?? await up({ fresh: false });
  const demoId = Date.now().toString(36);
  const createdTasks = [];

  await scenario("exclusive: one worker completes, another drops after sync", async () => {
    const taskId = `play-exclusive-${demoId}`;
    await submitTask(state, "orchestrator", taskId, {
      title: "Playground exclusive task",
      instructions: "Only one codex worker should produce a result.",
      policy: "exclusive",
      agents: "codex",
      modelFamilies: "gpt",
      tools: "shell,git",
    });
    const workerA = await schedulerWorkerLoop(state, "worker-a", taskId, {
      workerId: "worker-a-codex",
      agent: "codex",
      modelFamilies: "gpt",
      tools: "shell,git",
      command: "printf playground-worker-a-exclusive",
      sync: true,
      maxRuns: 1,
    });
    const workerB = await schedulerWorkerLoop(state, "worker-b", taskId, {
      workerId: "worker-b-codex",
      agent: "codex",
      modelFamilies: "gpt",
      tools: "shell,git",
      command: "printf playground-worker-b-should-idle",
      sync: true,
      idleLimit: 1,
    });
    await peerSync(state, "orchestrator", taskId);
    const dashboard = await schedulerDashboard(state, "orchestrator", taskId);
    assertEqual(workerA.summary.lastResult.status, "completed", "worker-a should complete exclusive task");
    assertEqual(workerB.summary.lastResult.status, "idle", "worker-b should idle after seeing completed exclusive result");
    assertEqual(dashboard.results.length, 1, "exclusive task should keep one result");
    createdTasks.push({ id: taskId, scenario: "exclusive" });
    printTaskSummary(taskId, dashboard);
  });

  await scenario("capability routing: opencode/anthropic/browser worker wins", async () => {
    const taskId = `play-capability-${demoId}`;
    await submitTask(state, "orchestrator", taskId, {
      title: "Playground capability task",
      instructions: "Only an opencode anthropic browser-capable worker should run.",
      policy: "exclusive",
      agents: "opencode",
      modelFamilies: "anthropic",
      tools: "shell,browser",
    });
    const codex = await schedulerWorkerLoop(state, "worker-a", taskId, {
      workerId: "worker-a-codex",
      agent: "codex",
      modelFamilies: "gpt",
      tools: "shell,git",
      command: "printf codex-should-not-run",
      sync: true,
      idleLimit: 1,
    });
    const opencode = await schedulerWorkerLoop(state, "worker-b", taskId, {
      workerId: "worker-b-opencode",
      agent: "opencode",
      modelFamilies: "anthropic,gpt",
      tools: "shell,git,browser",
      command: "printf playground-worker-b-opencode",
      sync: true,
      maxRuns: 1,
    });
    await peerSync(state, "orchestrator", taskId);
    const dashboard = await schedulerDashboard(state, "orchestrator", taskId);
    assertEqual(codex.summary.lastResult.status, "idle", "codex worker should not match requirements");
    assertEqual(opencode.summary.lastResult.status, "completed", "opencode worker should match requirements");
    createdTasks.push({ id: taskId, scenario: "capability-routing" });
    printTaskSummary(taskId, dashboard);
  });

  await scenario("offline competition: two forked results, adjudication picks a winner", async () => {
    const taskId = `play-competition-${demoId}`;
    await submitTask(state, "orchestrator", taskId, {
      title: "Playground offline competition",
      instructions: "Two workers run from the same synced intent and publish competing results.",
      policy: "speculative",
      agents: "codex",
      modelFamilies: "gpt",
      tools: "shell,git",
    });
    await Promise.all([peerSync(state, "worker-a", taskId), peerSync(state, "worker-b", taskId)]);
    const [workerA, workerB] = await Promise.all([
      schedulerWorkerLoop(state, "worker-a", taskId, {
        workerId: "worker-a-codex",
        agent: "codex",
        modelFamilies: "gpt",
        tools: "shell,git",
        command: "printf playground-competition-worker-a",
        maxRuns: 1,
      }),
      schedulerWorkerLoop(state, "worker-b", taskId, {
        workerId: "worker-b-codex",
        agent: "codex",
        modelFamilies: "gpt",
        tools: "shell,git",
        command: "printf playground-competition-worker-b",
        maxRuns: 1,
      }),
    ]);
    assertEqual(workerA.summary.lastResult.status, "completed", "worker-a should complete competition task");
    assertEqual(workerB.summary.lastResult.status, "completed", "worker-b should complete competition task");
    await peerSync(state, "orchestrator", taskId);
    const forked = await schedulerDashboard(state, "orchestrator", taskId);
    assertEqual(forked.results.length, 2, "offline competition should have two results");
    assertEqual(forked.heads.length, 2, "offline competition should have two heads before adjudication");
    const winner = forked.results.find((result) => result.payload.workerId === "worker-b-codex");
    assert(winner, "expected worker-b result to exist");
    await schedulerAdjudicate(state, "orchestrator", taskId, {
      intentBlockId: forked.intents[0].blockId,
      resultBlockIds: forked.results.map((result) => result.blockId),
      winnerResultBlockId: winner.blockId,
      summary: "Selected worker-b output in playground demo.",
    });
    const adjudicated = await schedulerDashboard(state, "orchestrator", taskId);
    assertEqual(adjudicated.heads.length, 1, "adjudication should collapse heads");
    createdTasks.push({ id: taskId, scenario: "offline-competition" });
    printTaskSummary(taskId, adjudicated);
  });

  state.tasks.push(...createdTasks);
  await saveState(state);
  console.log("\nplayground demo completed and left running");
  console.log(`state: ${stateFile}`);
  console.log("inspect:");
  console.log("  npm run cluster:playground -- status");
  console.log("  npm run cluster:playground -- exec orchestrator -- continuity scheduler-dashboard --project-id " + state.projectId + " --task-id " + createdTasks.at(-1).id + " --lane-id scheduler");
  console.log("cleanup:");
  console.log("  npm run cluster:playground -- down");
}

async function status() {
  const state = await requireState();
  console.log(`playground: ${state.runId}`);
  console.log(`state: ${stateFile}`);
  console.log(`project: ${state.projectId}`);
  console.log("");
  console.log("containers:");
  for (const node of state.nodes) {
    const name = containerName(state, node.name);
    const result = await docker(["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}} {{.Status}}"], { allowFailure: true });
    console.log(`  ${result.stdout.trim() || `${name} <missing>`}`);
  }
  console.log("");
  console.log("peers:");
  for (const node of state.nodes) {
    const peers = await continuity(state, node.name, ["peer-list"]);
    console.log(`  ${node.name}:`);
    for (const line of peers.stdout.trim().split("\n").filter(Boolean)) console.log(`    ${line}`);
  }
  console.log("");
  console.log("tasks:");
  if (state.tasks.length === 0) {
    console.log("  <none>");
    return;
  }
  for (const task of state.tasks) {
    const dashboard = await schedulerDashboard(state, "orchestrator", task.id);
    printTaskSummary(task.id, dashboard, `  ${task.scenario}: `);
  }
}

async function down({ missingOk, stateOverride } = {}) {
  const state = stateOverride ?? await readStateIfExists();
  if (!state) {
    if (missingOk) return;
    throw new Error(`no playground state at ${stateFile}`);
  }
  for (const node of [...state.nodes].reverse()) {
    await docker(["rm", "-f", containerName(state, node.name)], { allowFailure: true });
  }
  await docker(["network", "rm", state.network], { allowFailure: true });
  await docker(["rmi", "-f", state.image], { allowFailure: true });
  await rm(state.tmp, { recursive: true, force: true });
  await rm(stateFile, { force: true });
  console.log(`removed playground ${state.runId}`);
}

async function execCommand(args) {
  const separator = args.indexOf("--");
  const nodeName = separator >= 0 ? args[0] : args.shift();
  const commandArgs = separator >= 0 ? args.slice(separator + 1) : args;
  if (!nodeName || commandArgs.length === 0) throw new Error("usage: cluster-playground exec <node> -- <command...>");
  const state = await requireState();
  const command = commandArgs[0] === "continuity"
    ? shellJoin(["/root/.local/bin/continuity", ...commandArgs.slice(1)])
    : shellJoin(commandArgs);
  const result = await execIn(state, nodeName, command);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}

function nodeInitArgs(state, name) {
  return [
    "node-init",
    "--name",
    name,
    "--node-id",
    name,
    "--actor-id",
    `${name}-node-init`,
    "--project-id",
    state.projectId,
    "--peer-listen",
    ":9987",
    "--endpoint",
    `tcp://${name}:9987`,
    "--backend",
    "file",
    "--dir",
    "/rendezvous",
    "--trust-names",
    state.trustedNames,
    "--timeout-ms",
    "15000",
  ];
}

async function submitTask(state, nodeName, taskId, input) {
  return jsonContinuity(state, nodeName, [
    "scheduler-task-submit",
    "--project-id",
    state.projectId,
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

async function schedulerWorkerLoop(state, nodeName, taskId, input) {
  const args = [
    "scheduler-worker-loop",
    "--project-id",
    state.projectId,
    "--task-id",
    taskId,
    "--lane-id",
    "scheduler",
    "--worker-id",
    input.workerId,
    "--agent",
    input.agent,
    "--model-families",
    input.modelFamilies,
    "--tools",
    input.tools,
    "--runner",
    "command",
    "--command",
    input.command,
    "--node-id",
    nodeName,
    "--actor-id",
    `${nodeName}-${input.workerId}`,
    "--interval-ms",
    "0",
    "--json",
  ];
  if (input.sync) args.push("--sync");
  if (input.maxRuns !== undefined) args.push("--max-runs", String(input.maxRuns));
  if (input.idleLimit !== undefined) args.push("--idle-limit", String(input.idleLimit));
  return jsonContinuity(state, nodeName, args);
}

async function peerSync(state, nodeName, taskId) {
  return jsonContinuity(state, nodeName, [
    "peer-sync",
    "--project-id",
    state.projectId,
    "--task-id",
    taskId,
    "--lane-id",
    "scheduler",
    "--json",
  ]);
}

async function schedulerDashboard(state, nodeName, taskId) {
  return jsonContinuity(state, nodeName, [
    "scheduler-dashboard",
    "--project-id",
    state.projectId,
    "--task-id",
    taskId,
    "--lane-id",
    "scheduler",
    "--json",
  ]);
}

async function schedulerAdjudicate(state, nodeName, taskId, input) {
  return jsonContinuity(state, nodeName, [
    "scheduler-adjudicate",
    "--project-id",
    state.projectId,
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

async function jsonContinuity(state, nodeName, args) {
  const result = await continuity(state, nodeName, args);
  return JSON.parse(result.stdout);
}

async function continuity(state, nodeName, args) {
  return execIn(state, nodeName, shellJoin(["/root/.local/bin/continuity", ...args]));
}

async function execIn(state, nodeName, script) {
  return docker(["exec", containerName(state, nodeName), "bash", "-c", `set -euo pipefail\nexport PATH="/root/.local/bin:/usr/local/go/bin:$PATH"\n${script}`]);
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

async function readStateIfExists() {
  try {
    await access(stateFile);
    return JSON.parse(await readFile(stateFile, "utf8"));
  } catch {
    return undefined;
  }
}

async function requireState() {
  const state = await readStateIfExists();
  if (!state) throw new Error(`no playground state at ${stateFile}; run npm run cluster:playground -- up`);
  return state;
}

async function saveState(state) {
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function scenario(name, fn) {
  process.stdout.write(`- ${name}... `);
  await fn();
  process.stdout.write("ok\n");
}

function printTaskSummary(taskId, dashboard, prefix = "") {
  const heads = dashboard.heads?.length ? dashboard.heads.length : 0;
  const latest = dashboard.intents?.[0]?.latestResult?.payload;
  const winner = dashboard.intents?.[0]?.latestAdjudication?.payload?.winnerResultBlockId;
  console.log(`${prefix}${taskId}: tasks=${dashboard.intents.length} results=${dashboard.results.length} heads=${heads} completed=${dashboard.counts.completed}`);
  if (latest) console.log(`${prefix}  latest=${latest.workerId}/${latest.status}`);
  if (winner) console.log(`${prefix}  winner=${winner}`);
}

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--") {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    i += 1;
  }
  return { command, options, rest: positional };
}

function shellJoin(args) {
  return args.map((arg) => shellQuote(String(arg))).join(" ");
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function containerName(state, name) {
  return `continuity-play-${state.runId}-${name}`;
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

function printHelp() {
  console.log(`continuity cluster playground

Usage:
  npm run cluster:playground -- up [--fresh]
  npm run cluster:playground -- demo [--fresh]
  npm run cluster:playground -- status
  npm run cluster:playground -- exec <node> -- <command...>
  npm run cluster:playground -- down

Examples:
  npm run cluster:playground -- demo --fresh
  npm run cluster:playground -- status
  npm run cluster:playground -- exec orchestrator -- continuity peer-list
  npm run cluster:playground -- exec orchestrator -- continuity scheduler-dashboard --project-id <PROJECT> --task-id <TASK> --lane-id scheduler

State:
  ${stateFile}
`);
}
