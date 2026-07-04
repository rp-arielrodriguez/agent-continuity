import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runDaemonCheckpoint, readDaemonCanon } from "../src/daemon-workflow.js";
import { loadOrCreateNodeSigner } from "../src/signer-store.js";
import { MemoryProvider } from "../src/provider.js";

const ref = {
  projectId: "rp-arielrodriguez/agent-continuity",
  taskId: "agent-continuity-decentralized-runtime",
  laneId: "main",
};

test("daemon checkpoint initializes lane, claims ownership, and updates canon", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "continuity-daemon-workflow-"));
  const provider = new MemoryProvider();
  try {
    const result = await runDaemonCheckpoint({
      ...ref,
      provider,
      stateDir,
      timestamp: "2026-07-04T00:20:00.000Z",
      modelId: "test-model",
      sessionId: "session-1",
      status: "in_progress",
      progress: "Daemon checkpoint accepted.",
      next: "Read daemon canon.",
    });

    assert.equal(result.appended, true);
    assert.equal(result.actor.actorId, "agent-cli");
    assert.ok(result.blockId?.startsWith("blk_"));
    assert.deepEqual((await provider.blocks(ref)).map((block) => block.kind), ["bootstrap", "claim_lane", "checkpoint"]);

    const resumed = await readDaemonCanon({ ...ref, provider });
    assert.match(resumed.canonMarkdown ?? "", /Daemon checkpoint accepted\./);
    assert.match(resumed.canonMarkdown ?? "", /last-reconciled: 2026-07-04T00:20:00.000Z/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("daemon checkpoint is idempotent by task timestamp and session", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "continuity-daemon-workflow-"));
  const provider = new MemoryProvider();
  const input = {
    ...ref,
    provider,
    stateDir,
    timestamp: "2026-07-04T00:21:00.000Z",
    modelId: "test-model",
    sessionId: "session-1",
    status: "in_progress" as const,
    progress: "Idempotent daemon checkpoint.",
    next: "Retry safely.",
  };
  try {
    const first = await runDaemonCheckpoint(input);
    const second = await runDaemonCheckpoint(input);

    assert.equal(first.appended, true);
    assert.equal(second.appended, false);
    assert.equal(second.blockId, first.blockId);
    assert.equal((await provider.blocks(ref)).length, 3);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("daemon checkpoint reuses current local owner when actor is omitted", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "continuity-daemon-workflow-"));
  const provider = new MemoryProvider();
  try {
    const migratedOwner = await loadOrCreateNodeSigner({
      stateDir,
      nodeId: "macbook-ariel",
      actorId: "migration-cli",
    });
    await provider.bootstrap({
      ...ref,
      signer: migratedOwner.signer,
      createdAt: "2026-07-04T00:22:00.000Z",
      payload: { summary: "Migrated lane." },
    });
    await provider.claimLane({
      ...ref,
      signer: migratedOwner.signer,
      createdAt: "2026-07-04T00:22:01.000Z",
      reason: "migration import",
    });

    const result = await runDaemonCheckpoint({
      ...ref,
      provider,
      stateDir,
      timestamp: "2026-07-04T00:23:00.000Z",
      modelId: "test-model",
      sessionId: "session-owner",
      status: "in_progress",
      progress: "Continued as migrated owner.",
    });

    assert.equal(result.appended, true);
    assert.equal(result.actor.actorId, "migration-cli");
    assert.equal((await provider.status({ ...ref })).lane.checkpoint?.progress, "Continued as migrated owner.");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
