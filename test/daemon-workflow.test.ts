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

test("daemon progress-only checkpoint carries the previous canon forward", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "continuity-daemon-workflow-"));
  const provider = new MemoryProvider();
  const base = { ...ref, provider, stateDir, modelId: "test-model", sessionId: "session-1", status: "in_progress" as const };
  const customCanon = `# Canon: ${ref.taskId}

last-reconciled: 2026-07-04T00:30:00.000Z

## SOURCE-OF-TRUTH
- Daemon continuity.

## CURRENT-TRUTH / INVARIANTS
- INVARIANT-X: the review gate is required.

## DECISIONS
- Current checkpoint status: in_progress.
- DECISION-Y: use the loop design.

## REJECTED (do not re-derive)
- REJECTED-Z: skipping the gate.

## NEXT-ACTION
- Old next action.
`;
  try {
    // (d) first checkpoint without canon uses the template
    await runDaemonCheckpoint({ ...base, timestamp: "2026-07-04T00:29:00.000Z", progress: "First.", next: "Second." });
    const first = (await readDaemonCanon({ ...ref, provider })).canonMarkdown ?? "";
    assert.match(first, /## CURRENT-TRUTH \/ INVARIANTS\n- First\./);
    assert.doesNotMatch(first, /LATEST-PROGRESS/);

    // (c) explicit canon still replaces
    await runDaemonCheckpoint({ ...base, timestamp: "2026-07-04T00:30:00.000Z", progress: "Explicit.", canonMarkdown: customCanon });
    const explicit = (await readDaemonCanon({ ...ref, provider })).canonMarkdown ?? "";
    assert.match(explicit, /INVARIANT-X/);
    assert.doesNotMatch(explicit, /## CURRENT-TRUTH \/ INVARIANTS\n- First\./);

    // (a)+(b) progress-only checkpoint carries forward
    await runDaemonCheckpoint({ ...base, timestamp: "2026-07-04T00:31:00.000Z", progress: "Progress only.", next: "New next." });
    const carried = (await readDaemonCanon({ ...ref, provider })).canonMarkdown ?? "";
    assert.match(carried, /INVARIANT-X: the review gate is required\./);
    assert.match(carried, /DECISION-Y: use the loop design\./);
    assert.match(carried, /REJECTED-Z: skipping the gate\./);
    assert.match(carried, /last-reconciled: 2026-07-04T00:31:00\.000Z/);
    assert.match(carried, /## LATEST-PROGRESS\n- Progress only\.\n/);
    assert.match(carried, /## NEXT-ACTION\n- New next\.\n/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
