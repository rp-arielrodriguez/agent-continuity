import test from "node:test";
import assert from "node:assert/strict";
import {
  blockIdFor,
  createEd25519Signer,
  createSignedTaskBlock,
  hashJson,
  validateTaskBlock,
  verifyBlockSignature,
  type TaskBlock,
} from "../src/block.js";

const ref = {
  projectId: "rp-arielrodriguez/agent-continuity",
  taskId: "agent-continuity-decentralized-runtime",
  laneId: "main",
};

test("creates signed task blocks with stable payload hash and verifiable signature", async () => {
  const signer = createEd25519Signer({ nodeId: "macbook-ariel", actorId: "codex-session-1" });
  const block = await createSignedTaskBlock(
    {
      ...ref,
      kind: "checkpoint",
      parentTips: [],
      leaseEpoch: 1,
      createdAt: "2026-07-03T18:00:00.000Z",
      payload: {
        status: "in_progress",
        progress: "Implemented provider contract.",
        next: "Wire daemon provider.",
      },
    },
    signer,
  );

  assert.match(block.blockId, /^blk_[a-f0-9]{64}$/);
  assert.equal(block.payloadHash, hashJson(block.payload));
  assert.equal(block.blockId, blockIdFor(block));
  assert.equal(verifyBlockSignature(block), true);
  assert.deepEqual(validateTaskBlock(block).issues, []);
});

test("rejects tampered task block payload", async () => {
  const signer = createEd25519Signer({ nodeId: "macbook-ariel", actorId: "codex-session-1" });
  const block = await createSignedTaskBlock(
    {
      ...ref,
      kind: "checkpoint",
      leaseEpoch: 1,
      createdAt: "2026-07-03T18:00:00.000Z",
      payload: {
        status: "in_progress",
        progress: "Original progress.",
      },
    },
    signer,
  );
  const tampered: TaskBlock = {
    ...block,
    payload: {
      status: "in_progress",
      progress: "Tampered progress.",
    },
  };

  const result = validateTaskBlock(tampered);

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.code === "invalid_payload_hash"));
  assert.ok(result.issues.some((entry) => entry.code === "invalid_block_id"));
  assert.ok(result.issues.some((entry) => entry.code === "invalid_signature"));
});

test("canonical JSON hashing is independent from object key order", () => {
  assert.equal(hashJson({ b: "two", a: "one" }), hashJson({ a: "one", b: "two" }));
});

test("rejects payloads that do not match their block kind", async () => {
  const signer = createEd25519Signer({ nodeId: "macbook-ariel", actorId: "codex-session-1" });

  await assert.rejects(
    createSignedTaskBlock(
      {
        ...ref,
        kind: "checkpoint",
        leaseEpoch: 1,
        payload: {
          status: "in_progress",
        } as never,
      },
      signer,
    ),
    /progress must be a non-empty string/,
  );
});

test("validates scheduler block payloads", async () => {
  const signer = createEd25519Signer({ nodeId: "macbook-ariel", actorId: "codex-session-1" });
  const block = await createSignedTaskBlock(
    {
      ...ref,
      kind: "task_intent",
      leaseEpoch: 0,
      payload: {
        title: "Run scheduler acceptance",
        instructions: "Run deterministic acceptance test.",
        requirements: {
          agents: ["codex"],
          modelFamilies: ["gpt"],
          tools: ["shell", "git"],
        },
      },
    },
    signer,
  );

  assert.equal(validateTaskBlock(block).ok, true);

  await assert.rejects(
    createSignedTaskBlock(
      {
        ...ref,
        kind: "task_result",
        leaseEpoch: 0,
        payload: {
          intentBlockId: "not-a-block",
          workerId: "a0263-codex",
          status: "completed",
          summary: "Done.",
        } as never,
      },
      signer,
    ),
    /intentBlockId must be a valid block id/,
  );
});
