#!/usr/bin/env node
import { execFile as execFileCallback, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = process.cwd();
const cli = path.join(root, "dist/src/cli.js");
const daemonBinary = path.join(root, "dist/bin/continuityd");
const runId = new Date().toISOString().replaceAll(/[^0-9A-Za-z]/g, "").slice(0, 14);
const projectId = "rp-arielrodriguez/agent-continuity-real-agents";
const laneId = "scheduler";
const defaultRunnerTimeoutMs = 600_000;
const agentConfigs = {
  codex: {
    preset: "codex",
    modelFamily: "gpt",
    command: 'codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "$CONTINUITY_TASK_INSTRUCTIONS"',
  },
  claude: {
    preset: "claude",
    modelFamily: "anthropic",
    command: 'claude -p --dangerously-skip-permissions --allowedTools=Write,Edit,Bash "$CONTINUITY_TASK_INSTRUCTIONS"',
  },
  opencode: {
    preset: "opencode",
    modelFamily: "gpt",
    model: process.env.CONTINUITY_REAL_AGENT_OPENCODE_MODEL ?? "github-copilot/gpt-5-mini",
    command: `opencode run --model ${shellQuote(process.env.CONTINUITY_REAL_AGENT_OPENCODE_MODEL ?? "github-copilot/gpt-5-mini")} --dangerously-skip-permissions "$CONTINUITY_TASK_INSTRUCTIONS"`,
  },
};
const requestedAgents = parseAgents(optionValue("--agents") ?? "codex,claude,opencode");
const allowMissing = hasOption("--allow-missing");
const runnerTimeoutMs = Number(optionValue("--runner-timeout-ms") ?? defaultRunnerTimeoutMs);
const keepTmp = process.env.CONTINUITY_REAL_AGENT_KEEP_TMP === "1";

await assertBuilt();
const tmp = await mkdtemp(path.join(os.tmpdir(), "continuity-real-agents-"));
const paths = daemonPaths(tmp, "node");
const worktreeRoot = path.join(tmp, "worktrees");
const evidence = [];
let daemon;
let failed = false;

try {
  await mkdir(worktreeRoot, { recursive: true });
  const env = {
    ...process.env,
    PATH: `${path.join(os.homedir(), ".local", "bin")}:/opt/homebrew/bin:${process.env.PATH ?? ""}`,
    CONTINUITY_HOME: path.join(tmp, "home"),
    CONTINUITYD_SOCKET: paths.socket,
    CONTINUITY_DATABASE_URL: "",
    ABSURD_DATABASE_URL: "",
    GIT_AUTHOR_NAME: "Continuity Real Agent Acceptance",
    GIT_AUTHOR_EMAIL: "continuity@example.local",
    GIT_COMMITTER_NAME: "Continuity Real Agent Acceptance",
    GIT_COMMITTER_EMAIL: "continuity@example.local",
  };

  const agents = await resolveAvailableAgents(requestedAgents, env);
  if (agents.length === 0) throw new Error("no selected real-agent CLIs are available");

  await scenario("start isolated daemon for real-agent scheduler acceptance", async () => {
    daemon = await startDaemon(daemonBinary, paths);
    await run(["daemon-status", "--socket", paths.socket, "--db", paths.db], { env });
  });

  for (const agent of agents) {
    await scenario(`${agent} completes an exclusive scheduler task with real filesystem work`, async () => {
      evidence.push(await runExclusiveAgentTask(agent, env));
    });
  }

  if (agents.length > 1) {
    await scenario(`${agents.join(", ")} compete on one speculative task and are adjudicated`, async () => {
      evidence.push(await runSpeculativeCompetition(agents, env));
    });
  }

  console.log("\nreal-agent-acceptance: passed");
  console.log(JSON.stringify({ runId, projectId, agents, evidence }, null, 2));
} catch (error) {
  failed = true;
  throw error;
} finally {
  if (daemon) await stopDaemon(daemon);
  if (failed || keepTmp) {
    console.error(`real-agent-acceptance: preserving temp dir ${tmp}`);
  } else {
    await cleanupWorktrees(worktreeRoot);
    await rm(tmp, { recursive: true, force: true });
  }
}

async function runExclusiveAgentTask(agent, env) {
  const config = agentConfigs[agent];
  const taskId = `real-exclusive-${agent}-${runId}`;
  const workerId = `real-${agent}`;
  const proofFile = `continuity-real-agent-${agent}.txt`;
  const proofContent = `real ${agent} work through continuity ${runId}\n`;

  await submitTask({
    env,
    taskId,
    title: `Real ${agent} exclusive work`,
    instructions: proofInstructions(proofFile, proofContent),
    policy: "exclusive",
    agents: agent,
    modelFamilies: config.modelFamily,
    tools: "shell,git",
  });

  const workerOutput = await workerLoop({ env, taskId, agent, workerId, maxRuns: 1 });
  assertEqual(workerOutput.summary.lastResult.status, "completed", `${agent} exclusive worker should complete`);
  assertEqual(workerOutput.summary.lastResult.workerId, workerId, `${agent} result should use selected worker id`);

  const dashboard = await schedulerDashboard(env, taskId);
  assertEqual(dashboard.results.length, 1, `${agent} exclusive task should have exactly one result`);
  assertEqual(dashboard.counts.completed, 1, `${agent} exclusive dashboard should show completion`);

  const proof = await verifyProofFiles(proofFile, proofContent, 1);
  return {
    type: "exclusive",
    agent,
    taskId,
    workerId,
    resultBlockId: workerOutput.summary.lastResult.resultBlock.blockId,
    proofFiles: proof.map((entry) => entry.relativeWorktreeFile),
  };
}

async function runSpeculativeCompetition(agents, env) {
  const taskId = `real-competition-${runId}`;
  const proofFile = "continuity-real-agent-competition.txt";
  const proofContent = `real competition work through continuity ${runId}\n`;

  await submitTask({
    env,
    taskId,
    title: "Real multi-agent speculative competition",
    instructions: proofInstructions(proofFile, proofContent),
    policy: "speculative",
    tools: "shell,git",
  });

  const outputs = await Promise.all(
    agents.map((agent) => workerLoop({
      env,
      taskId,
      agent,
      workerId: `competition-${agent}`,
      maxRuns: 1,
    })),
  );
  for (const output of outputs) {
    assertEqual(output.summary.lastResult.status, "completed", `${output.summary.workerId} should complete speculative work`);
  }

  const beforeAdjudication = await schedulerDashboard(env, taskId);
  assertEqual(beforeAdjudication.results.length, agents.length, "speculative task should keep one result per real agent");
  assertEqual(beforeAdjudication.counts.completed, 1, "speculative dashboard should mark the task completed once");

  const proof = await verifyProofFiles(proofFile, proofContent, agents.length);
  const winner = beforeAdjudication.results.find((result) => result.payload.workerId === `competition-${agents[0]}`);
  assert(winner, "expected first selected agent result to exist for adjudication");

  await run([
    "scheduler-adjudicate",
    "--socket",
    paths.socket,
    "--state-dir",
    paths.stateDir,
    "--project-id",
    projectId,
    "--task-id",
    taskId,
    "--lane-id",
    laneId,
    "--intent-block-id",
    beforeAdjudication.intents[0].blockId,
    "--result-block-ids",
    beforeAdjudication.results.map((result) => result.blockId).join(","),
    "--winner-result-block-id",
    winner.blockId,
    "--summary",
    `Selected ${winner.payload.workerId} as real-agent competition winner.`,
    "--json",
  ], { env });

  const afterAdjudication = await schedulerDashboard(env, taskId);
  assertEqual(afterAdjudication.intents[0].latestAdjudication.payload.winnerResultBlockId, winner.blockId, "adjudication should record selected winner");
  assert(afterAdjudication.results.some((result) => result.blockId === winner.blockId), "adjudicated winner should still be present in scheduler results");
  assertEqual(afterAdjudication.heads.length, 1, "adjudication should collapse scheduler heads to one");

  return {
    type: "speculative-competition",
    agents,
    taskId,
    winnerResultBlockId: winner.blockId,
    resultBlockIds: beforeAdjudication.results.map((result) => result.blockId),
    proofFiles: proof.map((entry) => entry.relativeWorktreeFile),
  };
}

async function submitTask(input) {
  const args = [
    "scheduler-task-submit",
    "--socket",
    paths.socket,
    "--state-dir",
    paths.stateDir,
    "--project-id",
    projectId,
    "--task-id",
    input.taskId,
    "--lane-id",
    laneId,
    "--title",
    input.title,
    "--instructions",
    input.instructions,
    "--policy",
    input.policy,
    "--node-id",
    "real-node",
    "--actor-id",
    "real-orchestrator",
    "--json",
  ];
  if (input.agents) args.push("--requires-agents", input.agents);
  if (input.modelFamilies) args.push("--requires-model-families", input.modelFamilies);
  if (input.tools) args.push("--requires-tools", input.tools);
  return JSON.parse((await run(args, { env: input.env })).stdout);
}

async function workerLoop(input) {
  const config = agentConfigs[input.agent];
  return JSON.parse((await run([
    "scheduler-worker-loop",
    "--socket",
    paths.socket,
    "--state-dir",
    paths.stateDir,
    "--project-id",
    projectId,
    "--task-id",
    input.taskId,
    "--lane-id",
    laneId,
    "--preset",
    config.preset,
    ...(config.model ? ["--models", config.model] : []),
    "--worker-id",
    input.workerId,
    "--node-id",
    "real-node",
    "--actor-id",
    `${input.workerId}-actor`,
    "--runner",
    "command",
    "--command",
    config.command,
    "--worktree-root",
    worktreeRoot,
    "--allowed-project-ids",
    projectId,
    "--allowed-commands",
    input.agent,
    "--max-runner-timeout-ms",
    String(runnerTimeoutMs),
    "--runner-timeout-ms",
    String(runnerTimeoutMs),
    "--max-runs",
    String(input.maxRuns),
    "--interval-ms",
    "0",
    "--json",
  ], { env: input.env, timeout: runnerTimeoutMs + 60_000 })).stdout);
}

async function schedulerDashboard(env, taskId) {
  return JSON.parse((await run([
    "scheduler-dashboard",
    "--socket",
    paths.socket,
    "--project-id",
    projectId,
    "--task-id",
    taskId,
    "--lane-id",
    laneId,
    "--json",
  ], { env })).stdout);
}

function proofInstructions(fileName, content) {
  return [
    "You are being executed by Agent Continuity scheduler inside an isolated git worktree.",
    "Use the available coding tools or shell to perform real filesystem work.",
    `Create or overwrite exactly one file in the current working directory: ${fileName}`,
    "The file content must be exactly this single line, including the trailing newline:",
    content.trimEnd(),
    "Do not edit, create, delete, stage, commit, or rename any other files.",
    "After writing the file, verify its content and reply with a short done message.",
  ].join("\n");
}

async function verifyProofFiles(fileName, expectedContent, expectedCount) {
  const matches = await findFiles(worktreeRoot, fileName);
  assertEqual(matches.length, expectedCount, `expected ${expectedCount} proof file(s) named ${fileName}`);
  const proof = [];
  for (const file of matches) {
    const content = await readFile(file, "utf8");
    assertEqual(content, expectedContent, `proof file ${file} should contain exact expected content`);
    const worktree = path.dirname(file);
    const status = (await execFile("git", ["-C", worktree, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" })).stdout
      .trim()
      .split("\n")
      .filter(Boolean);
    const changedFiles = status.map((line) => line.slice(3));
    assertEqual(changedFiles.length, 1, `worktree ${worktree} should contain only the proof file change`);
    assertEqual(changedFiles[0], fileName, `worktree ${worktree} changed an unexpected file`);
    proof.push({ file, worktree, relativeWorktreeFile: path.relative(worktreeRoot, file) });
  }
  return proof.sort((left, right) => left.file.localeCompare(right.file));
}

async function findFiles(dir, basename) {
  const found = [];
  if (!(await exists(dir))) return found;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...await findFiles(file, basename));
    } else if (entry.isFile() && entry.name === basename) {
      found.push(file);
    }
  }
  return found;
}

async function resolveAvailableAgents(agents, env) {
  const available = [];
  for (const agent of agents) {
    if (await commandExists(agent, env)) {
      available.push(agent);
    } else if (allowMissing) {
      console.warn(`real-agent-acceptance: skipping missing ${agent}`);
    } else {
      throw new Error(`selected agent CLI is missing from PATH: ${agent}`);
    }
  }
  return available;
}

async function commandExists(command, env) {
  try {
    await execFile("sh", ["-lc", `command -v ${shellQuote(command)}`], { env, encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

async function assertBuilt() {
  try {
    await stat(cli);
    await stat(daemonBinary);
  } catch {
    throw new Error("dist CLI and daemon are required; run npm run build:all first");
  }
}

function daemonPaths(rootDir, name) {
  const stateDir = path.join(rootDir, name);
  return {
    stateDir,
    socket: path.join(stateDir, "continuityd.sock"),
    db: path.join(stateDir, "continuity.db"),
  };
}

async function startDaemon(binary, daemonPath) {
  await mkdir(daemonPath.stateDir, { recursive: true });
  const child = spawn(binary, ["--socket", daemonPath.socket, "--db", daemonPath.db], {
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
  await waitForSocket(daemonPath.socket, () => stderr);
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
  return execFile(process.execPath, [cli, ...args], {
    cwd: root,
    env: options.env ?? process.env,
    timeout: options.timeout ?? 30_000,
    maxBuffer: 50 * 1024 * 1024,
    encoding: "utf8",
  }).catch((error) => {
    const stderr = error.stderr ? `\nstderr:\n${error.stderr}` : "";
    const stdout = error.stdout ? `\nstdout:\n${error.stdout}` : "";
    throw new Error(`continuity ${args.join(" ")} failed: ${error.message}${stdout}${stderr}`);
  });
}

async function cleanupWorktrees(rootDir) {
  if (!(await exists(rootDir))) return;
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(rootDir, entry.name);
    await execFile("git", ["worktree", "remove", "--force", dir], { encoding: "utf8" }).catch(() => undefined);
  }
  await rm(rootDir, { recursive: true, force: true });
  await execFile("git", ["worktree", "prune"], { encoding: "utf8" }).catch(() => undefined);
}

function parseAgents(value) {
  const agents = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const agent of agents) {
    if (!agentConfigs[agent]) throw new Error(`unsupported real-agent ${agent}; expected ${Object.keys(agentConfigs).join(", ")}`);
  }
  return [...new Set(agents)];
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasOption(name) {
  return process.argv.includes(name);
}

async function scenario(name, fn) {
  process.stdout.write(`- ${name}... `);
  await fn();
  process.stdout.write("ok\n");
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
