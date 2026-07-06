import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createEd25519Signer } from "../src/block.js";
import { MemoryProvider } from "../src/provider.js";
import { resolveSchedulerWorkerProfile, schedulerWorkerPreset } from "../src/scheduler-presets.js";
import {
  deriveSchedulerState,
  loadSchedulerState,
  runSchedulerOnce,
  schedulerRunnerEnvironment,
  selectRunnableIntent,
  submitTaskAdjudication,
  submitTaskAssignment,
  submitTaskIntent,
  workerMatchesIntent,
} from "../src/scheduler.js";
import { runSchedulerWorkerLoop, startTmuxSession, stopTmuxSession, tmuxSessionStatus } from "../src/scheduler-worker.js";

const execFile = promisify(execFileCallback);

const ref = {
  projectId: "rp-arielrodriguez/agent-continuity",
  taskId: "scheduler-runtime",
  laneId: "scheduler",
};

test("worker matching enforces agent, model, and tool requirements", () => {
  assert.equal(
    workerMatchesIntent(
      {
        workerId: "a0263-codex",
        agent: "codex",
        modelFamilies: ["gpt"],
        models: ["gpt-5"],
        tools: ["shell", "git"],
      },
      {
        title: "Run smoke",
        instructions: "Run deterministic smoke.",
        requirements: {
          agents: ["codex"],
          modelFamilies: ["gpt"],
          tools: ["shell", "git"],
        },
      },
    ),
    true,
  );

  assert.equal(
    workerMatchesIntent(
      {
        workerId: "a0263-claude",
        agent: "claude",
        modelFamilies: ["anthropic"],
        tools: ["shell"],
      },
      {
        title: "Run smoke",
        instructions: "Run deterministic smoke.",
        requirements: {
          agents: ["codex"],
          tools: ["shell", "git"],
        },
      },
    ),
    false,
  );
});

test("worker presets provide agent model tool and command defaults", () => {
  const codex = schedulerWorkerPreset("codex");
  assert.equal(codex.worker.agent, "codex");
  assert.equal(codex.runner, "tmux");
  assert.match(codex.command, /CONTINUITY_TASK_INSTRUCTIONS/);

  const worker = resolveSchedulerWorkerProfile({
    preset: "opencode",
    nodeId: "a0263",
    tools: ["shell", "browser", "git", "custom-tool"],
  });
  assert.equal(worker.workerId, "a0263-opencode");
  assert.equal(worker.agent, "opencode");
  assert.deepEqual(worker.tools, ["shell", "browser", "git", "custom-tool"]);
  assert.deepEqual(worker.modelFamilies, ["gpt", "anthropic", "local"]);
});

test("runSchedulerOnce assigns a runnable intent and publishes a task result", async () => {
  const provider = new MemoryProvider();
  const signer = createEd25519Signer({ nodeId: "a0263", actorId: "scheduler-test" });

  const intent = await submitTaskIntent({
    ...ref,
    provider,
    signer,
    createdAt: "2026-07-05T22:00:00.000Z",
    payload: {
      title: "Acceptance smoke",
      instructions: "Run the acceptance smoke.",
      requirements: {
        agents: ["codex"],
        modelFamilies: ["gpt"],
        tools: ["shell", "git"],
      },
    },
  });

  const result = await runSchedulerOnce({
    ...ref,
    provider,
    signer,
    now: "2026-07-05T22:01:00.000Z",
    worker: {
      workerId: "a0263-codex",
      agent: "codex",
      modelFamilies: ["gpt"],
      tools: ["shell", "git"],
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.intent?.blockId, intent.blockId);
  assert.ok(result.assignmentBlock?.blockId.startsWith("blk_"));
  assert.ok(result.resultBlock?.blockId.startsWith("blk_"));

  const state = await loadSchedulerState(provider, ref);
  assert.equal(state.counts.completed, 1);
  assert.equal(state.intents[0].latestResult?.payload.workerId, "a0263-codex");

  const second = await runSchedulerOnce({
    ...ref,
    provider,
    signer,
    now: "2026-07-05T22:02:00.000Z",
    worker: {
      workerId: "a0263-codex",
      agent: "codex",
      modelFamilies: ["gpt"],
      tools: ["shell", "git"],
    },
  });
  assert.equal(second.status, "idle");
});

test("speculative intents can be assigned to another worker before a result lands", async () => {
  const provider = new MemoryProvider();
  const signer = createEd25519Signer({ nodeId: "a0263", actorId: "scheduler-test" });
  const intent = await submitTaskIntent({
    ...ref,
    provider,
    signer,
    createdAt: "2026-07-05T22:10:00.000Z",
    payload: {
      title: "Compare outputs",
      instructions: "Produce competing output.",
      policy: "speculative",
      requirements: { tools: ["shell"] },
    },
  });
  await submitTaskAssignment({
    ...ref,
    provider,
    signer,
    createdAt: "2026-07-05T22:11:00.000Z",
    payload: {
      intentBlockId: intent.blockId,
      workerId: "worker-a",
      assignedLaneId: "worker-a",
      mode: "automatic",
      leaseUntil: "2026-07-05T22:30:00.000Z",
    },
  });

  const state = deriveSchedulerState(ref, await provider.blocks(ref));
  const selected = selectRunnableIntent(
    state,
    {
      workerId: "worker-b",
      agent: "opencode",
      tools: ["shell"],
    },
    "2026-07-05T22:12:00.000Z",
  );

  assert.equal(selected?.blockId, intent.blockId);
});

test("speculative intents can accept another worker after a completed result lands", async () => {
  const provider = new MemoryProvider();
  const signer = createEd25519Signer({ nodeId: "a0263", actorId: "scheduler-test" });
  await submitTaskIntent({
    ...ref,
    provider,
    signer,
    createdAt: "2026-07-05T22:15:00.000Z",
    payload: {
      title: "Compare completed outputs",
      instructions: "Keep useful competing results.",
      policy: "speculative",
      requirements: { tools: ["shell"] },
    },
  });

  const first = await runSchedulerOnce({
    ...ref,
    provider,
    signer,
    now: "2026-07-05T22:16:00.000Z",
    worker: {
      workerId: "worker-a",
      agent: "codex",
      tools: ["shell"],
    },
  });
  assert.equal(first.status, "completed");

  const second = await runSchedulerOnce({
    ...ref,
    provider,
    signer,
    now: "2026-07-05T22:17:00.000Z",
    worker: {
      workerId: "worker-b",
      agent: "codex",
      tools: ["shell"],
    },
  });
  assert.equal(second.status, "completed");

  const state = await loadSchedulerState(provider, ref);
  assert.equal(state.results.length, 2);
});

test("scheduler adjudication records the winning result", async () => {
  const provider = new MemoryProvider();
  const signer = createEd25519Signer({ nodeId: "a0263", actorId: "scheduler-test" });
  const intent = await submitTaskIntent({
    ...ref,
    provider,
    signer,
    createdAt: "2026-07-05T22:18:00.000Z",
    payload: {
      title: "Adjudicate outputs",
      instructions: "Pick the best completed output.",
      policy: "speculative",
      requirements: { tools: ["shell"] },
    },
  });

  const first = await runSchedulerOnce({
    ...ref,
    provider,
    signer,
    now: "2026-07-05T22:19:00.000Z",
    worker: {
      workerId: "worker-a",
      agent: "codex",
      tools: ["shell"],
    },
  });
  const second = await runSchedulerOnce({
    ...ref,
    provider,
    signer,
    now: "2026-07-05T22:20:00.000Z",
    worker: {
      workerId: "worker-b",
      agent: "codex",
      tools: ["shell"],
    },
  });
  assert.ok(first.resultBlock);
  assert.ok(second.resultBlock);

  const before = await provider.status(ref);
  await submitTaskAdjudication({
    ...ref,
    provider,
    signer,
    parentTips: before.lane.heads,
    payload: {
      intentBlockId: intent.blockId,
      resultBlockIds: [first.resultBlock.blockId, second.resultBlock.blockId],
      winnerResultBlockId: second.resultBlock.blockId,
      summary: "worker-b produced the selected output.",
    },
  });

  const state = await loadSchedulerState(provider, ref);
  assert.equal(state.adjudications.length, 1);
  assert.equal(state.intents[0].latestAdjudication?.payload.winnerResultBlockId, second.resultBlock.blockId);
});

test("command runner timeout is recorded as a failed result", async () => {
  const provider = new MemoryProvider();
  const signer = createEd25519Signer({ nodeId: "a0263", actorId: "scheduler-test" });
  await submitTaskIntent({
    ...ref,
    provider,
    signer,
    createdAt: "2026-07-05T22:20:00.000Z",
    payload: {
      title: "Timeout smoke",
      instructions: "Run a command that does not finish before the runner timeout.",
      requirements: { tools: ["shell"] },
    },
  });

  const result = await runSchedulerOnce({
    ...ref,
    provider,
    signer,
    now: "2026-07-05T22:21:00.000Z",
    worker: {
      workerId: "a0263-command",
      agent: "codex",
      tools: ["shell"],
    },
    runner: "command",
    command: `${process.execPath} -e "setTimeout(() => {}, 1000)"`,
    runnerTimeoutMs: 50,
  });

  assert.equal(result.status, "failed");
  assert.match(result.resultBlock?.payload.summary ?? "", /timed out/);
});

test("command runner receives scheduler task context as environment", async () => {
  const provider = new MemoryProvider();
  const signer = createEd25519Signer({ nodeId: "a0263", actorId: "scheduler-test" });
  const intent = await submitTaskIntent({
    ...ref,
    provider,
    signer,
    createdAt: "2026-07-05T22:25:00.000Z",
    payload: {
      title: "Context smoke",
      instructions: "Read task context from environment.",
      requirements: { tools: ["shell"] },
    },
  });

  const result = await runSchedulerOnce({
    ...ref,
    provider,
    signer,
    now: "2026-07-05T22:26:00.000Z",
    worker: {
      workerId: "a0263-command",
      agent: "codex",
      tools: ["shell"],
    },
    runner: "command",
    command: `${process.execPath} -e ${JSON.stringify("console.log(process.env.CONTINUITY_TASK_TITLE); console.log(process.env.CONTINUITY_TASK_INSTRUCTIONS); console.log(process.env.CONTINUITY_INTENT_BLOCK_ID);")}`,
  });

  assert.equal(result.status, "completed");
  const artifacts = result.resultBlock?.payload.artifacts?.join("\n") ?? "";
  assert.match(artifacts, /Context smoke/);
  assert.match(artifacts, /Read task context from environment/);
  assert.match(artifacts, new RegExp(intent.blockId));

  const env = schedulerRunnerEnvironment(ref, result.intent!, {
    workerId: "a0263-command",
    agent: "codex",
    tools: ["shell"],
  });
  assert.equal(env.CONTINUITY_TASK_TITLE, "Context smoke");
  assert.equal(env.CONTINUITY_WORKER_ID, "a0263-command");
});

test("scheduler worker loop runs queued tasks until max-runs", async () => {
  const provider = new MemoryProvider();
  const signer = createEd25519Signer({ nodeId: "a0263", actorId: "scheduler-test" });
  for (const title of ["Loop smoke A", "Loop smoke B"]) {
    await submitTaskIntent({
      ...ref,
      provider,
      signer,
      createdAt: "2026-07-05T22:30:00.000Z",
      payload: {
        title,
        instructions: `Run ${title}.`,
        requirements: { tools: ["shell"] },
      },
    });
  }

  const events: string[] = [];
  const summary = await runSchedulerWorkerLoop({
    ...ref,
    provider,
    signer,
    worker: {
      workerId: "loop-worker",
      agent: "codex",
      tools: ["shell"],
    },
    intervalMs: 0,
    maxRuns: 2,
    onEvent: (event) => {
      events.push(event.type);
    },
  });

  assert.equal(summary.stopReason, "max-runs");
  assert.equal(summary.runs, 2);
  assert.equal(summary.completed, 2);
  assert.equal(summary.idle, 0);
  assert.deepEqual(events.filter((event) => event === "result").length, 2);

  const state = await loadSchedulerState(provider, ref);
  assert.equal(state.counts.completed, 2);
});

test("tmux worker session lifecycle starts, exposes tail output, and stops", async (t) => {
  try {
    await execFile("tmux", ["-V"]);
  } catch {
    t.skip("tmux is not installed");
    return;
  }

  const session = `continuity-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const started = await startTmuxSession({
      session,
      command: "printf tmux-smoke-ok; sleep 5",
      cwd: process.cwd(),
    });
    assert.equal(started.running, true);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const status = await tmuxSessionStatus({ session, tailLines: 10 });
    assert.equal(status.running, true);
    assert.match(status.tail ?? "", /tmux-smoke-ok/);
  } finally {
    const stopped = await stopTmuxSession({ session });
    assert.equal(stopped.running, false);
  }
});

test("scheduler worker loop stops after idle limit", async () => {
  const provider = new MemoryProvider();
  const signer = createEd25519Signer({ nodeId: "a0263", actorId: "scheduler-test" });

  const summary = await runSchedulerWorkerLoop({
    ...ref,
    provider,
    signer,
    worker: {
      workerId: "idle-worker",
      agent: "codex",
      tools: ["shell"],
    },
    intervalMs: 0,
    idleLimit: 2,
  });

  assert.equal(summary.stopReason, "idle-limit");
  assert.equal(summary.runs, 0);
  assert.equal(summary.idle, 2);
  assert.equal(summary.iterations, 2);
});

test("scheduler worker loop enforces project command and timeout policy before running", async () => {
  const provider = new MemoryProvider();
  const signer = createEd25519Signer({ nodeId: "a0263", actorId: "scheduler-test" });
  const worker = {
    workerId: "policy-worker",
    agent: "codex",
    tools: ["shell"],
  };

  await assert.rejects(
    runSchedulerWorkerLoop({
      ...ref,
      provider,
      signer,
      worker,
      allowedProjectIds: ["other/project"],
      idleLimit: 1,
    }),
    /not allowed/,
  );

  await assert.rejects(
    runSchedulerWorkerLoop({
      ...ref,
      provider,
      signer,
      worker,
      runner: "command",
      command: "rm -rf /tmp/nope",
      allowedCommands: ["codex", "claude"],
      idleLimit: 1,
    }),
    /not in --allowed-commands/,
  );

  await assert.rejects(
    runSchedulerWorkerLoop({
      ...ref,
      provider,
      signer,
      worker,
      runnerTimeoutMs: 2000,
      maxRunnerTimeoutMs: 1000,
      idleLimit: 1,
    }),
    /exceeds --max-runner-timeout-ms/,
  );
});

test("command runner executes inside per-task worktree root when configured", async () => {
  const provider = new MemoryProvider();
  const signer = createEd25519Signer({ nodeId: "a0263", actorId: "scheduler-test" });
  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "continuity-worktrees-"));

  try {
    await submitTaskIntent({
      ...ref,
      provider,
      signer,
      createdAt: "2026-07-05T22:40:00.000Z",
      payload: {
        title: "Worktree smoke",
        instructions: "Run inside isolated worktree.",
        requirements: { tools: ["shell"] },
      },
    });

    const result = await runSchedulerOnce({
      ...ref,
      provider,
      signer,
      worker: {
        workerId: "worktree-worker",
        agent: "codex",
        tools: ["shell"],
      },
      runner: "command",
      command: `${process.execPath} -e ${JSON.stringify("console.log(process.cwd()); console.log(process.env.CONTINUITY_WORKTREE_DIR);")}`,
      worktreeRoot,
    });

    assert.equal(result.status, "completed");
    const artifacts = result.resultBlock?.payload.artifacts?.join("\n") ?? "";
    assert.match(artifacts, new RegExp(worktreeRoot.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(worktreeRoot, { recursive: true, force: true });
    await execFile("git", ["worktree", "prune"]).catch(() => undefined);
  }
});

test("speculative workers receive separate worktrees for the same task intent", async () => {
  const provider = new MemoryProvider();
  const signer = createEd25519Signer({ nodeId: "a0263", actorId: "scheduler-test" });
  const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), "continuity-worktrees-"));

  try {
    await submitTaskIntent({
      ...ref,
      provider,
      signer,
      createdAt: "2026-07-05T22:45:00.000Z",
      payload: {
        title: "Same-machine speculative worktree smoke",
        instructions: "Multiple local workers should not share one checkout.",
        policy: "speculative",
        requirements: { tools: ["shell"] },
      },
    });

    const command = `${process.execPath} -e ${JSON.stringify("console.log(process.env.CONTINUITY_WORKER_ID); console.log(process.env.CONTINUITY_WORKTREE_DIR);")}`;
    const first = await runSchedulerOnce({
      ...ref,
      provider,
      signer,
      now: "2026-07-05T22:46:00.000Z",
      worker: {
        workerId: "local-codex-a",
        agent: "codex",
        tools: ["shell"],
      },
      runner: "command",
      command,
      worktreeRoot,
    });
    const second = await runSchedulerOnce({
      ...ref,
      provider,
      signer,
      now: "2026-07-05T22:47:00.000Z",
      worker: {
        workerId: "local-codex-b",
        agent: "codex",
        tools: ["shell"],
      },
      runner: "command",
      command,
      worktreeRoot,
    });

    assert.equal(first.status, "completed");
    assert.equal(second.status, "completed");
    const firstArtifacts = first.resultBlock?.payload.artifacts?.join("\n") ?? "";
    const secondArtifacts = second.resultBlock?.payload.artifacts?.join("\n") ?? "";
    const worktreePattern = new RegExp(`${worktreeRoot.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]+`, "g");
    const firstWorktree = firstArtifacts.match(worktreePattern)?.at(-1);
    const secondWorktree = secondArtifacts.match(worktreePattern)?.at(-1);
    assert.ok(firstWorktree);
    assert.ok(secondWorktree);
    assert.notEqual(firstWorktree, secondWorktree);
    assert.match(firstWorktree, /local-codex-a/);
    assert.match(secondWorktree, /local-codex-b/);
  } finally {
    await rm(worktreeRoot, { recursive: true, force: true });
    await execFile("git", ["worktree", "prune"]).catch(() => undefined);
  }
});
