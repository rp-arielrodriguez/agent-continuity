import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSignedTaskBlock, verifyBlockSignature } from "../src/block.js";
import { loadOrCreateNodeSigner } from "../src/signer-store.js";

test("node signer store creates and reuses durable key material", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "continuity-node-key-"));
  try {
    const first = await loadOrCreateNodeSigner({
      stateDir,
      nodeId: "macbook-ariel",
      actorId: "migration-cli",
    });
    const second = await loadOrCreateNodeSigner({
      stateDir,
      nodeId: "macbook-ariel",
      actorId: "dashboard-cli",
    });
    const implicitNode = await loadOrCreateNodeSigner({
      stateDir,
      actorId: "checkpoint-cli",
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(implicitNode.created, false);
    assert.equal(first.signer.publicKey, second.signer.publicKey);
    assert.equal(implicitNode.signer.nodeId, "macbook-ariel");
    assert.equal(second.signer.actorId, "dashboard-cli");

    const block = await createSignedTaskBlock(
      {
        projectId: "rp-arielrodriguez/agent-continuity",
        taskId: "agent-continuity-decentralized-runtime",
        laneId: "main",
        kind: "bootstrap",
        leaseEpoch: 0,
        createdAt: "2026-07-03T22:40:00.000Z",
        payload: { summary: "Durable signer test." },
      },
      second.signer,
    );
    assert.equal(verifyBlockSignature(block), true);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("node signer store rejects node-id drift for an existing key file", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "continuity-node-key-"));
  try {
    await loadOrCreateNodeSigner({
      stateDir,
      nodeId: "macbook-ariel",
      actorId: "migration-cli",
    });
    await assert.rejects(
      () =>
        loadOrCreateNodeSigner({
          stateDir,
          nodeId: "other-node",
          actorId: "migration-cli",
        }),
      /belongs to macbook-ariel/,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
