import test from "node:test";
import assert from "node:assert/strict";
import { assertCanonTaskId, idempotencyKeyFor, lastReconciledFromCanon, parseJournalEntries, renderDefaultCanon, renderJournalEntry, withLastReconciled } from "../src/markdown.js";
import type { CheckpointInput } from "../src/types.js";

const input: CheckpointInput = {
  taskId: "demo-task",
  timestamp: "2026-06-14T00:00:00.000Z",
  modelId: "test-model",
  sessionId: "session-1",
  status: "completed",
  progress: "Validated durable checkpoint writes.",
  next: "Install integrations.",
};

test("renders journal entry in checkpoint format", () => {
  const entry = renderJournalEntry(input);
  assert.match(entry, /^## 2026-06-14T00:00:00\.000Z — test-model \(session session-1\)/);
  assert.match(entry, /\*\*Status\*\*: completed/);
  assert.match(entry, /\*\*Progress\*\*: Validated durable checkpoint writes\./);
});

test("uses stable idempotency key", () => {
  assert.equal(idempotencyKeyFor(input), "demo-task:2026-06-14T00:00:00.000Z:session-1");
});

test("default canon marks database as source of truth", () => {
  const canon = renderDefaultCanon(input);
  assert.match(canon, /PostgreSQL continuity tables/);
  assert.match(canon, /last-reconciled: 2026-06-14T00:00:00\.000Z/);
  assert.match(canon, /markdown is an exported projection/);
});

test("default canon marks daemon as source of truth for daemon checkpoints", () => {
  const canon = renderDefaultCanon({ ...input, source: "daemon-cli" });
  assert.match(canon, /Daemon continuity/);
  assert.match(canon, /continuity resume --daemon --task-id demo-task/);
});

test("default canon marks agent daemon checkpoints and bounded artifacts", () => {
  const canon = renderDefaultCanon({ ...input, source: "agent-run", files: `stdout:\n${"agent-output ".repeat(200)}` });
  assert.match(canon, /Daemon continuity/);
  assert.match(canon, /## ARTIFACTS/);
  assert.match(canon, /stdout:/);
  assert.match(canon, /\[truncated \d+ chars\]/);
});

test("normalizes canon last-reconciled header", () => {
  const canon = withLastReconciled("# Canon: demo\n\nlast-reconciled: old\n", "2026-06-14T01:00:00.000Z");
  assert.match(canon, /last-reconciled: 2026-06-14T01:00:00\.000Z/);
  assert.doesNotMatch(canon, /last-reconciled: old/);
});

test("rejects mismatched canon task id", () => {
  assert.throws(() => assertCanonTaskId("# Canon: other-task\n", "demo-task"), /canon task id mismatch/);
});

test("parses markdown journal entries for import", () => {
  const entries = parseJournalEntries("demo-task", renderJournalEntry(input));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].taskId, "demo-task");
  assert.equal(entries[0].progress, input.progress);
  assert.equal(entries[0].idempotencyKey, idempotencyKeyFor(input));
});

test("parses legacy journal headers with a title suffix", () => {
  const journal = renderJournalEntry(input).replace(
    "(session session-1)",
    "(session session-1) — STEP-1 DEPLOYED",
  );

  const entries = parseJournalEntries("demo-task", journal);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].sessionId, "session-1");
  assert.equal(entries[0].entryMarkdown, journal);
});

test("extracts canon last-reconciled header", () => {
  assert.equal(lastReconciledFromCanon("# Canon: demo\n\nlast-reconciled: 2026-06-14T00:00:00Z\n"), "2026-06-14T00:00:00Z");
});
