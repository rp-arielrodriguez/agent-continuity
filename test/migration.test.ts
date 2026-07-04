import test from "node:test";
import assert from "node:assert/strict";
import { createEd25519Signer, type CheckpointPayload } from "../src/block.js";
import { idempotencyKeyFor, renderJournalEntry } from "../src/markdown.js";
import { migrateTaskHistoryToProvider } from "../src/migration.js";
import { MemoryProvider } from "../src/provider.js";
import type { CanonRecord, CheckpointInput, JournalEntry } from "../src/types.js";

const ref = {
  projectId: "rp-arielrodriguez/agent-continuity",
  taskId: "agent-continuity-decentralized-runtime",
  laneId: "main",
};

test("migrates journal entries and canon into signed task blocks", async () => {
  const provider = new MemoryProvider();
  const signer = createEd25519Signer({ nodeId: "macbook-ariel", actorId: "migration-agent" });
  const entries = [
    journalEntry({
      timestamp: "2026-07-03T19:20:00.000Z",
      status: "in_progress",
      progress: "Second entry.",
      next: "Update canon.",
    }),
    journalEntry({
      timestamp: "2026-07-03T19:10:00.000Z",
      status: "in_progress",
      progress: "First entry.",
      next: "Continue migration.",
    }),
  ];
  const canon: CanonRecord = {
    taskId: ref.taskId,
    lastReconciled: "2026-07-03T19:20:00.000Z",
    updatedAt: "2026-07-03T19:21:00.000Z",
    canonMarkdown: "# Canon: agent-continuity-decentralized-runtime\n\n## CURRENT-TRUTH\n- Migrated canon.\n",
  };

  const result = await migrateTaskHistoryToProvider({
    ...ref,
    provider,
    signer,
    entries,
    canon,
  });

  assert.equal(result.migrated, true);
  assert.equal(result.journalEntries, 2);
  assert.equal(result.acceptedBlocks, 5);
  assert.equal(result.blockIds.length, 5);

  const blocks = await provider.blocks(ref);
  assert.deepEqual(blocks.map((block) => block.kind), ["bootstrap", "claim_lane", "checkpoint", "checkpoint", "canon_update"]);
  assert.equal((blocks[2].payload as CheckpointPayload).progress, "First entry.");
  assert.equal((blocks[3].payload as CheckpointPayload).progress, "Second entry.");
  assert.equal((blocks[2].payload as CheckpointPayload).idempotencyKey, entries[1].idempotencyKey);
  assert.equal((blocks[3].payload as CheckpointPayload).sessionId, entries[0].sessionId);

  const status = await provider.status({ ...ref, actor: signer });
  assert.equal(status.lane.tip, result.finalTip);
  assert.equal(status.lane.canonMarkdown, canon.canonMarkdown);
  assert.equal(status.lane.checkpoint?.progress, "Second entry.");
});

test("migration skips a target lane that already has a tip", async () => {
  const provider = new MemoryProvider();
  const signer = createEd25519Signer({ nodeId: "macbook-ariel", actorId: "migration-agent" });

  await provider.bootstrap({
    ...ref,
    signer,
    payload: { summary: "Already migrated." },
    createdAt: "2026-07-03T19:00:00.000Z",
  });

  const result = await migrateTaskHistoryToProvider({
    ...ref,
    provider,
    signer,
    entries: [journalEntry({ timestamp: "2026-07-03T19:10:00.000Z", progress: "Should not import." })],
  });

  assert.equal(result.migrated, false);
  assert.match(result.reason ?? "", /target lane already has tip/);
  assert.equal(result.acceptedBlocks, 0);
  assert.equal((await provider.blocks(ref)).length, 1);
});

function journalEntry(partial: Partial<CheckpointInput> & Pick<CheckpointInput, "timestamp" | "progress">): JournalEntry {
  const input: CheckpointInput = {
    taskId: ref.taskId,
    timestamp: partial.timestamp,
    modelId: partial.modelId ?? "test-model",
    sessionId: partial.sessionId ?? `session-${partial.timestamp}`,
    status: partial.status ?? "in_progress",
    progress: partial.progress,
    files: partial.files,
    blocking: partial.blocking,
    next: partial.next,
    source: "test",
  };
  return {
    ...input,
    idempotencyKey: idempotencyKeyFor(input),
    entryMarkdown: renderJournalEntry(input),
  };
}
