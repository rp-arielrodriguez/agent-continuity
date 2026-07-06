import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEd25519Signer, type CheckpointPayload } from "../src/block.js";
import { claimAgentLane, handoffAgentLane, orientAgent, runAgentCommand, validateAgentCommandPolicy } from "../src/agent-harness.js";
import { MemoryProvider } from "../src/provider.js";

const ref = {
  projectId: "rp-arielrodriguez/agent-continuity",
  taskId: "agent-harness",
  laneId: "main",
};

test("orientAgent renders daemon canon, lane owner, and sync evidence for agent prompts", async () => {
  const provider = new MemoryProvider();
  const signer = createEd25519Signer({ nodeId: "a0263", actorId: "codex-session-1" });
  await provider.bootstrap({
    ...ref,
    signer,
    createdAt: "2026-07-06T10:00:00.000Z",
    payload: {
      summary: "Initialize harness lane.",
      canonMarkdown: "# Canon: agent-harness\n\nCurrent truth.",
    },
  });
  const claim = await provider.claimLane({
    ...ref,
    signer,
    createdAt: "2026-07-06T10:01:00.000Z",
    leaseUntil: "2026-07-06T10:10:00.000Z",
  });

  const result = await orientAgent({
    ...ref,
    provider,
    actor: signer,
    now: "2026-07-06T10:02:00.000Z",
    syncBeforeOrient: async () => ({
      ...ref,
      peers: [],
      advertisedBlocks: 3,
      missingBlocks: 0,
      fetchedBlocks: 0,
      acceptedBlocks: 0,
      insertedBlocks: 0,
      rejectedBlocks: 0,
      finalTip: claim.lane.tip,
    }),
  });

  assert.equal(result.action, "continue");
  assert.match(result.prompt, /<continuity-orient>/);
  assert.match(result.prompt, /owner: a0263\/codex-session-1/);
  assert.match(result.prompt, /sync inserted=0 rejected=0/);
  assert.match(result.prompt, /Current truth\./);
});

test("claimAgentLane bootstraps empty lanes and pauses on a fresh different owner", async () => {
  const provider = new MemoryProvider();
  const owner = createEd25519Signer({ nodeId: "a0263", actorId: "codex-session-1" });
  const other = createEd25519Signer({ nodeId: "mac-studio", actorId: "claude-session-2" });

  const first = await claimAgentLane({
    ...ref,
    provider,
    signer: owner,
    createdAt: "2026-07-06T10:00:00.000Z",
    now: "2026-07-06T10:00:00.000Z",
    leaseUntil: "2026-07-06T10:10:00.000Z",
  });
  assert.equal(first.bootstrap?.accepted, true);
  assert.equal(first.claim?.accepted, true);
  assert.equal(first.lane.owner?.actorId, "codex-session-1");
  assert.deepEqual((await provider.blocks(ref)).map((block) => block.kind), ["bootstrap", "claim_lane"]);

  const paused = await claimAgentLane({
    ...ref,
    provider,
    signer: other,
    createdAt: "2026-07-06T10:01:00.000Z",
    now: "2026-07-06T10:01:00.000Z",
  });
  assert.equal(paused.action, "pause");
  assert.equal(paused.claim, undefined);
  assert.equal(paused.lane.owner?.actorId, "codex-session-1");
});

test("handoffAgentLane can transfer and release ownership", async () => {
  const provider = new MemoryProvider();
  const owner = createEd25519Signer({ nodeId: "a0263", actorId: "codex-session-1" });

  await claimAgentLane({
    ...ref,
    provider,
    signer: owner,
    createdAt: "2026-07-06T10:00:00.000Z",
    leaseUntil: "2026-07-06T10:10:00.000Z",
  });

  const handoff = await handoffAgentLane({
    ...ref,
    provider,
    signer: owner,
    targetNodeId: "mac-studio",
    targetActorId: "opencode-agent-3",
    createdAt: "2026-07-06T10:02:00.000Z",
    leaseUntil: "2026-07-06T10:12:00.000Z",
  });
  assert.equal(handoff.accepted, true);
  assert.equal(handoff.mode, "handoff");
  assert.equal(handoff.lane.owner?.nodeId, "mac-studio");
  assert.equal(handoff.lane.owner?.actorId, "opencode-agent-3");

  const target = createEd25519Signer({ nodeId: "mac-studio", actorId: "opencode-agent-3" });
  const release = await handoffAgentLane({
    ...ref,
    provider,
    signer: target,
    createdAt: "2026-07-06T10:03:00.000Z",
    releaseReason: "handoff accepted",
  });
  assert.equal(release.accepted, true);
  assert.equal(release.mode, "release");
  assert.equal(release.lane.owner, undefined);
});

test("runAgentCommand injects continuity context and checkpoints successful work", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "continuity-agent-harness-"));
  const provider = new MemoryProvider();
  const signer = createEd25519Signer({ nodeId: "a0263", actorId: "codex-session-1" });
  try {
    const command = `${process.execPath} -e ${JSON.stringify("console.log(process.env.CONTINUITY_TASK_ID); console.log(process.env.CONTINUITY_ACTOR_ID); console.log(process.env.CONTINUITY_ORIENTATION.includes('<continuity-orient>'))")}`;
    const result = await runAgentCommand({
      ...ref,
      provider,
      signer,
      command,
      allowedCommands: [process.execPath],
      now: "2026-07-06T10:00:00.000Z",
      leaseUntil: "2026-07-06T10:10:00.000Z",
      checkpoint: {
        stateDir,
        timestamp: "2026-07-06T10:01:00.000Z",
        modelId: "harness-test",
        sessionId: "harness-session",
      },
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /agent-harness/);
    assert.match(result.stdout, /codex-session-1/);
    assert.match(result.stdout, /true/);
    assert.equal(result.checkpoint?.appended, true);

    const blocks = await provider.blocks(ref);
    assert.deepEqual(blocks.map((block) => block.kind), ["bootstrap", "claim_lane", "checkpoint"]);
    const checkpointPayload = blocks.at(-1)?.payload as CheckpointPayload;
    assert.equal(checkpointPayload.status, "completed");
    assert.match(checkpointPayload.files ?? "", /agent-harness/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("runAgentCommand checkpoints failed commands as blocked", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "continuity-agent-harness-"));
  const provider = new MemoryProvider();
  const signer = createEd25519Signer({ nodeId: "a0263", actorId: "codex-session-1" });
  try {
    const result = await runAgentCommand({
      ...ref,
      provider,
      signer,
      command: `${process.execPath} -e ${JSON.stringify("console.error('failure proof'); process.exit(7)")}`,
      allowedCommands: [process.execPath],
      now: "2026-07-06T10:00:00.000Z",
      checkpoint: {
        stateDir,
        timestamp: "2026-07-06T10:01:00.000Z",
        modelId: "harness-test",
        sessionId: "harness-failure-session",
      },
    });

    assert.equal(result.exitCode, 7);
    const blocks = await provider.blocks(ref);
    const checkpointPayload = blocks.at(-1)?.payload as CheckpointPayload;
    assert.equal(checkpointPayload.status, "blocked");
    assert.match(checkpointPayload.blocking ?? "", /failure proof/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("runAgentCommand pauses before executing when another actor has a fresh lease", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "continuity-agent-harness-"));
  const marker = path.join(stateDir, "should-not-exist");
  const provider = new MemoryProvider();
  const owner = createEd25519Signer({ nodeId: "a0263", actorId: "codex-session-1" });
  const other = createEd25519Signer({ nodeId: "mac-studio", actorId: "claude-session-2" });
  try {
    await claimAgentLane({
      ...ref,
      provider,
      signer: owner,
      createdAt: "2026-07-06T10:00:00.000Z",
      now: "2026-07-06T10:00:00.000Z",
      leaseUntil: "2026-07-06T10:10:00.000Z",
    });

    await assert.rejects(
      runAgentCommand({
        ...ref,
        provider,
        signer: other,
        command: `${process.execPath} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`)}`,
        allowedCommands: [process.execPath],
        now: "2026-07-06T10:01:00.000Z",
        checkpoint: { stateDir, timestamp: "2026-07-06T10:01:00.000Z" },
      }),
      /agent-run could not claim lane before executing command/,
    );
    await assert.rejects(stat(marker), /ENOENT/);
    assert.equal((await provider.blocks(ref)).length, 2);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("validateAgentCommandPolicy requires commands to match allowed prefixes", () => {
  assert.doesNotThrow(() => validateAgentCommandPolicy("printf ok", ["printf"]));
  assert.throws(() => validateAgentCommandPolicy("rm -rf /tmp/example", ["printf"]), /not in --allowed-commands/);
  assert.throws(() => validateAgentCommandPolicy("   ", ["printf"]), /--command is required/);
});
