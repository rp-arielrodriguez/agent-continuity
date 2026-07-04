import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEd25519Signer, createSignedTaskBlock } from "../src/block.js";
import { SQLiteProvider } from "../src/local-store.js";

const ref = {
  projectId: "rp-arielrodriguez/agent-continuity",
  taskId: "agent-continuity-decentralized-runtime",
  laneId: "main",
};

test("sqlite provider persists accepted blocks and lane projection across reopen", async () => {
  await withSqliteProvider(async (provider, file) => {
    const signer = createEd25519Signer({ nodeId: "macbook-ariel", actorId: "codex-session-1" });

    await provider.bootstrap({
      ...ref,
      signer,
      payload: {
        summary: "Started durable local block store.",
        canonMarkdown: "# Canon: agent-continuity-decentralized-runtime\n",
      },
      createdAt: "2026-07-03T19:30:00.000Z",
    });
    const claim = await provider.claimLane({
      ...ref,
      signer,
      leaseUntil: "2026-07-03T19:45:00.000Z",
      createdAt: "2026-07-03T19:31:00.000Z",
    });
    const checkpoint = await provider.checkpoint({
      ...ref,
      signer,
      expectedTip: claim.block?.blockId,
      createdAt: "2026-07-03T19:32:00.000Z",
      payload: {
        status: "in_progress",
        progress: "SQLite store persists accepted task blocks.",
        next: "Replay projections.",
      },
    });
    assert.equal(checkpoint.accepted, true);
    provider.close();

    const reopened = SQLiteProvider.open({ file });
    try {
      const status = await reopened.status({ ...ref, actor: signer, now: "2026-07-03T19:33:00.000Z" });
      assert.equal(status.action, "continue");
      assert.equal(status.lane.tip, checkpoint.block?.blockId);
      assert.equal(status.lane.owner?.actorId, "codex-session-1");
      assert.equal(status.lane.checkpoint?.progress, "SQLite store persists accepted task blocks.");
      assert.equal((await reopened.blocks(ref)).length, 3);
    } finally {
      reopened.close();
    }
  });
});

test("sqlite provider treats duplicate block ingest as idempotent", async () => {
  await withSqliteProvider(async (provider) => {
    const signer = createEd25519Signer({ nodeId: "macbook-ariel", actorId: "codex-session-1" });

    await provider.bootstrap({
      ...ref,
      signer,
      payload: { summary: "Start lane." },
      createdAt: "2026-07-03T19:30:00.000Z",
    });
    const claim = await provider.claimLane({
      ...ref,
      signer,
      leaseUntil: "2026-07-03T19:45:00.000Z",
      createdAt: "2026-07-03T19:31:00.000Z",
    });

    assert.ok(claim.block);
    const duplicate = await provider.submitBlock(claim.block);

    assert.equal(duplicate.accepted, true);
    assert.equal((await provider.blocks(ref)).length, 2);
  });
});

test("sqlite provider rebuilds lane projections by replaying accepted blocks", async () => {
  await withSqliteProvider(async (provider) => {
    const signer = createEd25519Signer({ nodeId: "macbook-ariel", actorId: "codex-session-1" });

    await provider.bootstrap({
      ...ref,
      signer,
      payload: { summary: "Start lane." },
      createdAt: "2026-07-03T19:30:00.000Z",
    });
    const claim = await provider.claimLane({
      ...ref,
      signer,
      leaseUntil: "2026-07-03T19:45:00.000Z",
      createdAt: "2026-07-03T19:31:00.000Z",
    });
    const checkpoint = await provider.checkpoint({
      ...ref,
      signer,
      expectedTip: claim.block?.blockId,
      createdAt: "2026-07-03T19:32:00.000Z",
      payload: {
        status: "in_progress",
        progress: "Projection rebuild should derive this.",
      },
    });

    assert.equal(provider.rebuildProjections(), 3);
    const status = await provider.status({ ...ref, actor: signer });

    assert.equal(status.lane.tip, checkpoint.block?.blockId);
    assert.equal(status.lane.checkpoint?.progress, "Projection rebuild should derive this.");
    assert.equal(status.lane.owner?.leaseEpoch, 1);
  });
});

test("sqlite provider rejects externally built stale parent tips", async () => {
  await withSqliteProvider(async (provider) => {
    const signer = createEd25519Signer({ nodeId: "macbook-ariel", actorId: "codex-session-1" });

    await provider.bootstrap({
      ...ref,
      signer,
      payload: { summary: "Start lane." },
      createdAt: "2026-07-03T19:30:00.000Z",
    });
    const claim = await provider.claimLane({
      ...ref,
      signer,
      leaseUntil: "2026-07-03T19:45:00.000Z",
      createdAt: "2026-07-03T19:31:00.000Z",
    });
    const staleTip = claim.block?.blockId;
    const heartbeat = await provider.heartbeat({
      ...ref,
      signer,
      leaseUntil: "2026-07-03T19:46:00.000Z",
      expectedTip: staleTip,
      createdAt: "2026-07-03T19:32:00.000Z",
    });
    assert.equal(heartbeat.accepted, true);

    const staleBlock = await createSignedTaskBlock(
      {
        ...ref,
        kind: "checkpoint",
        parentTips: staleTip ? [staleTip] : [],
        leaseEpoch: 1,
        createdAt: "2026-07-03T19:33:00.000Z",
        payload: {
          status: "in_progress",
          progress: "This block is stale.",
        },
      },
      signer,
    );

    const result = await provider.submitBlock(staleBlock);

    assert.equal(result.accepted, false);
    assert.equal(result.action, "reconcile");
    assert.equal(result.rejection?.code, "stale_parent_tip");
  });
});

async function withSqliteProvider(run: (provider: SQLiteProvider, file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-sqlite-"));
  const file = path.join(dir, "continuity.db");
  const provider = SQLiteProvider.open({ file });
  try {
    await run(provider, file);
  } finally {
    provider.close();
    await rm(dir, { recursive: true, force: true });
  }
}
