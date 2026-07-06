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
        evaluation: {
          mode: "agent",
          autoAdjudicate: false,
          confidenceThreshold: "high",
          requiredChecks: ["tests_pass", "ux_use_cases_pass"],
          rubric: [
            { name: "correctness", weight: 0.35 },
            { name: "ux_quality", weight: 0.25, description: "Operator experience and use-case clarity." },
          ],
          useCases: [
            {
              id: "UC-001",
              title: "User understands the selected winner",
              mustPass: true,
              evidence: ["dashboard shows recommendation"],
            },
          ],
        },
      },
    },
    signer,
  );

  assert.equal(validateTaskBlock(block).ok, true);

  const evaluation = await createSignedTaskBlock(
    {
      ...ref,
      kind: "task_evaluation",
      leaseEpoch: 0,
      payload: {
        intentBlockId: block.blockId,
        resultBlockIds: [block.blockId],
        recommendedWinnerResultBlockId: block.blockId,
        confidence: "high",
        scores: [
          {
            resultBlockId: block.blockId,
            totalScore: 92.5,
            criteria: [
              {
                name: "ux_quality",
                score: 9,
                rationale: "The workflow is visible from the dashboard.",
              },
            ],
          },
        ],
        requiredChecks: [
          {
            name: "ux_use_cases_pass",
            passed: true,
            evidence: ["UC-001 passed"],
          },
        ],
        useCases: [
          {
            id: "UC-001",
            passed: true,
            evidence: ["recommendation rendered"],
            notes: "The evaluator summary is actionable.",
          },
        ],
        risks: ["Manual override was not exercised."],
        autoAdjudicateEligible: false,
        summary: "Recommended deterministic result.",
      },
    },
    signer,
  );
  assert.equal(validateTaskBlock(evaluation).ok, true);

  const adjudication = await createSignedTaskBlock(
    {
      ...ref,
      kind: "task_adjudication",
      leaseEpoch: 0,
      payload: {
        intentBlockId: block.blockId,
        resultBlockIds: [block.blockId],
        winnerResultBlockId: block.blockId,
        summary: "Selected deterministic result.",
      },
    },
    signer,
  );
  assert.equal(validateTaskBlock(adjudication).ok, true);

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

  await assert.rejects(
    createSignedTaskBlock(
      {
        ...ref,
        kind: "task_evaluation",
        leaseEpoch: 0,
        payload: {
          intentBlockId: block.blockId,
          resultBlockIds: [block.blockId],
          recommendedWinnerResultBlockId: adjudication.blockId,
          summary: "Invalid recommendation.",
        } as never,
      },
      signer,
    ),
    /recommendedWinnerResultBlockId must be one of resultBlockIds/,
  );

  await assert.rejects(
    createSignedTaskBlock(
      {
        ...ref,
        kind: "task_evaluation",
        leaseEpoch: 0,
        payload: {
          intentBlockId: block.blockId,
          resultBlockIds: [block.blockId],
          scores: [{ resultBlockId: adjudication.blockId, totalScore: 1 }],
          summary: "Invalid score target.",
        } as never,
      },
      signer,
    ),
    /scores\[0\]\.resultBlockId must be one of resultBlockIds/,
  );
});

test("validates lane snapshot payloads", async () => {
  const signer = createEd25519Signer({ nodeId: "macbook-ariel", actorId: "codex-session-1" });
  const base = await createSignedTaskBlock(
    {
      ...ref,
      kind: "bootstrap",
      leaseEpoch: 0,
      payload: {
        summary: "Start lane before compaction.",
      },
    },
    signer,
  );
  const snapshot = await createSignedTaskBlock(
    {
      ...ref,
      kind: "lane_snapshot",
      parentTips: [base.blockId],
      leaseEpoch: 0,
      payload: {
        summary: "Compacted lane history.",
        baseBlockIds: [base.blockId],
        compactedBlockCount: 1,
        canonMarkdown: "# Canon: compacted\n",
        checkpoint: {
          status: "in_progress",
          progress: "Snapshot carries current checkpoint projection.",
        },
        owner: {
          nodeId: "macbook-ariel",
          actorId: "codex-session-1",
          leaseEpoch: 0,
        },
      },
    },
    signer,
  );

  assert.equal(validateTaskBlock(snapshot).ok, true);

  await assert.rejects(
    createSignedTaskBlock(
      {
        ...ref,
        kind: "lane_snapshot",
        leaseEpoch: 0,
        payload: {
          summary: "Invalid snapshot.",
          baseBlockIds: [],
        } as never,
      },
      signer,
    ),
    /baseBlockIds must contain at least one valid block id/,
  );
});
