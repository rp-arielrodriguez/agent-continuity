import test from "node:test";
import assert from "node:assert/strict";
import { createEd25519Signer, createSignedTaskBlock } from "../src/block.js";
import { MemoryProvider } from "../src/provider.js";

const ref = {
  projectId: "rp-arielrodriguez/agent-continuity",
  taskId: "agent-continuity-decentralized-runtime",
  laneId: "main",
};

test("memory provider accepts bootstrap, claim, and checkpoint blocks", async () => {
  const provider = new MemoryProvider();
  const signer = createEd25519Signer({ nodeId: "macbook-ariel", actorId: "codex-session-1" });

  const bootstrap = await provider.bootstrap({
    ...ref,
    signer,
    payload: {
      summary: "Created decentralized runtime architecture.",
      canonMarkdown: "# Canon: agent-continuity-decentralized-runtime\n",
    },
    createdAt: "2026-07-03T18:00:00.000Z",
  });
  assert.equal(bootstrap.accepted, true);
  assert.equal(bootstrap.lane.leaseEpoch, 0);

  const claim = await provider.claimLane({
    ...ref,
    signer,
    leaseUntil: "2026-07-03T18:15:00.000Z",
    createdAt: "2026-07-03T18:01:00.000Z",
  });
  assert.equal(claim.accepted, true);
  assert.equal(claim.lane.owner?.actorId, "codex-session-1");
  assert.equal(claim.lane.leaseEpoch, 1);

  const checkpoint = await provider.checkpoint({
    ...ref,
    signer,
    expectedTip: claim.block?.blockId,
    createdAt: "2026-07-03T18:02:00.000Z",
    payload: {
      status: "in_progress",
      progress: "Implemented provider API and validation contract.",
      next: "Add local store.",
    },
  });
  assert.equal(checkpoint.accepted, true);
  assert.equal(checkpoint.lane.checkpoint?.progress, "Implemented provider API and validation contract.");
  assert.equal((await provider.blocks(ref)).length, 3);

  const status = await provider.status({ ...ref, actor: signer });
  assert.equal(status.action, "continue");
});

test("memory provider pauses a different actor while the current owner is active", async () => {
  const provider = new MemoryProvider();
  const owner = createEd25519Signer({ nodeId: "macbook-ariel", actorId: "codex-session-1" });
  const other = createEd25519Signer({ nodeId: "workstation", actorId: "claude-session-2" });

  await provider.bootstrap({
    ...ref,
    signer: owner,
    payload: { summary: "Start lane." },
    createdAt: "2026-07-03T18:00:00.000Z",
  });
  await provider.claimLane({
    ...ref,
    signer: owner,
    leaseUntil: "2026-07-03T18:15:00.000Z",
    createdAt: "2026-07-03T18:01:00.000Z",
  });

  const status = await provider.status({ ...ref, actor: other, now: "2026-07-03T18:02:00.000Z" });
  assert.equal(status.action, "pause");

  const claim = await provider.claimLane({
    ...ref,
    signer: other,
    now: "2026-07-03T18:02:00.000Z",
    createdAt: "2026-07-03T18:02:00.000Z",
  });
  assert.equal(claim.accepted, false);
  assert.equal(claim.action, "pause");
  assert.equal(claim.rejection?.code, "owner_active");
});

test("memory provider rejects stale parent tips before accepting a checkpoint", async () => {
  const provider = new MemoryProvider();
  const signer = createEd25519Signer({ nodeId: "macbook-ariel", actorId: "codex-session-1" });

  await provider.bootstrap({
    ...ref,
    signer,
    payload: { summary: "Start lane." },
    createdAt: "2026-07-03T18:00:00.000Z",
  });
  const claim = await provider.claimLane({
    ...ref,
    signer,
    leaseUntil: "2026-07-03T18:15:00.000Z",
    createdAt: "2026-07-03T18:01:00.000Z",
  });
  const staleTip = claim.block?.blockId;
  const heartbeat = await provider.heartbeat({
    ...ref,
    signer,
    leaseUntil: "2026-07-03T18:16:00.000Z",
    expectedTip: staleTip,
    createdAt: "2026-07-03T18:02:00.000Z",
  });
  assert.equal(heartbeat.accepted, true);

  const checkpoint = await provider.checkpoint({
    ...ref,
    signer,
    expectedTip: staleTip,
    createdAt: "2026-07-03T18:03:00.000Z",
    payload: {
      status: "in_progress",
      progress: "This write was based on an old tip.",
    },
  });
  assert.equal(checkpoint.accepted, false);
  assert.equal(checkpoint.action, "reconcile");
  assert.equal(checkpoint.rejection?.code, "stale_parent_tip");

  const staleExternalBlock = await createSignedTaskBlock(
    {
      ...ref,
      kind: "checkpoint",
      parentTips: staleTip ? [staleTip] : [],
      leaseEpoch: 1,
      createdAt: "2026-07-03T18:04:00.000Z",
      payload: {
        status: "in_progress",
        progress: "Externally built stale block.",
      },
    },
    signer,
  );
  const externalSubmit = await provider.submitBlock(staleExternalBlock);
  assert.equal(externalSubmit.accepted, false);
  assert.equal(externalSubmit.rejection?.code, "stale_parent_tip");
});

test("memory provider accepts lane snapshots and resets heads", async () => {
  const provider = new MemoryProvider();
  const signer = createEd25519Signer({ nodeId: "macbook-ariel", actorId: "codex-session-1" });

  await provider.bootstrap({
    ...ref,
    signer,
    payload: {
      summary: "Start lane.",
      canonMarkdown: "# Canon: before snapshot\n",
    },
    createdAt: "2026-07-03T18:00:00.000Z",
  });
  await provider.claimLane({
    ...ref,
    signer,
    leaseUntil: "2026-07-03T18:15:00.000Z",
    createdAt: "2026-07-03T18:01:00.000Z",
  });
  const checkpoint = await provider.checkpoint({
    ...ref,
    signer,
    createdAt: "2026-07-03T18:02:00.000Z",
    payload: {
      status: "in_progress",
      progress: "Ready to compact.",
    },
  });
  const baseBlockIds = (await provider.blocks(ref)).map((block) => block.blockId);

  const snapshot = await provider.snapshot({
    ...ref,
    signer,
    expectedTip: checkpoint.lane.tip,
    createdAt: "2026-07-03T18:03:00.000Z",
    payload: {
      summary: "Compacted active lane.",
      baseBlockIds,
      compactedBlockCount: baseBlockIds.length,
      canonMarkdown: "# Canon: after snapshot\n",
      checkpoint: {
        status: "in_progress",
        progress: "Ready to compact.",
      },
      owner: checkpoint.lane.owner,
    },
  });

  assert.equal(snapshot.accepted, true);
  assert.deepEqual(snapshot.lane.heads, [snapshot.block?.blockId]);
  assert.equal(snapshot.lane.canonMarkdown, "# Canon: after snapshot\n");
  assert.equal(snapshot.lane.checkpoint?.progress, "Ready to compact.");
});

test("memory provider allows takeover after soft lease expiry and grace", async () => {
  const provider = new MemoryProvider();
  const owner = createEd25519Signer({ nodeId: "macbook-ariel", actorId: "codex-session-1" });
  const other = createEd25519Signer({ nodeId: "workstation", actorId: "claude-session-2" });

  await provider.bootstrap({
    ...ref,
    signer: owner,
    payload: { summary: "Start lane." },
    createdAt: "2026-07-03T18:00:00.000Z",
  });
  await provider.claimLane({
    ...ref,
    signer: owner,
    leaseUntil: "2026-07-03T18:01:00.000Z",
    createdAt: "2026-07-03T18:00:30.000Z",
  });

  const takeover = await provider.claimLane({
    ...ref,
    signer: other,
    now: "2026-07-03T18:02:00.001Z",
    leaseUntil: "2026-07-03T18:10:00.000Z",
    createdAt: "2026-07-03T18:02:00.001Z",
  });

  assert.equal(takeover.accepted, true);
  assert.equal(takeover.lane.owner?.actorId, "claude-session-2");
  assert.equal(takeover.lane.leaseEpoch, 2);
});
