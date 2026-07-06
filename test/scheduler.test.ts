import test from "node:test";
import assert from "node:assert/strict";
import { createEd25519Signer } from "../src/block.js";
import { MemoryProvider } from "../src/provider.js";
import {
  deriveSchedulerState,
  loadSchedulerState,
  runSchedulerOnce,
  selectRunnableIntent,
  submitTaskAssignment,
  submitTaskIntent,
  workerMatchesIntent,
} from "../src/scheduler.js";

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
