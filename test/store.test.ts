import test from "node:test";
import assert from "node:assert/strict";
import { getCanon, upsertCanon } from "../src/store.js";
import type { Queryable } from "../src/schema.js";
import type { CheckpointInput } from "../src/types.js";

// In-memory continuity.canons table; `beforeWrite` runs once, just before the first write.
function canonTable(seed: Record<string, string>, beforeWrite: (rows: Map<string, string>) => void): Queryable {
  const rows = new Map(Object.entries(seed));
  let intercepted = false;
  return {
    async query<T>(text: string, params: unknown[] = []) {
      const [taskId, , canon, previous] = params as string[];
      if (text.includes("SELECT")) {
        const value = rows.get(taskId);
        const found = value === undefined ? [] : [{ task_id: taskId, last_reconciled: new Date(0), canon_markdown: value, updated_at: new Date(0) }];
        return { rows: found as T[], rowCount: found.length };
      }
      if (!intercepted) {
        intercepted = true;
        beforeWrite(rows);
      }
      if (text.includes("DO NOTHING")) {
        if (rows.has(taskId)) return { rows: [], rowCount: 0 };
        rows.set(taskId, canon);
        return { rows: [], rowCount: 1 };
      }
      if (text.trimStart().startsWith("UPDATE")) {
        if (rows.get(taskId) !== previous) return { rows: [], rowCount: 0 };
        rows.set(taskId, canon);
        return { rows: [], rowCount: 1 };
      }
      rows.set(taskId, canon);
      return { rows: [], rowCount: 1 };
    },
  };
}

const input: CheckpointInput = {
  taskId: "store-task",
  timestamp: "2026-07-04T01:00:00.000Z",
  modelId: "test-model",
  sessionId: "session-1",
  status: "in_progress",
  progress: "Progress only.",
};

test("carry-forward rereads the canon when another write lands after the read", async () => {
  const db = canonTable(
    { "store-task": "# Canon: store-task\n\n## DECISIONS\n- OLD-DECISION.\n" },
    (rows) => rows.set("store-task", "# Canon: store-task\n\n## DECISIONS\n- INTERVENING-DECISION.\n"),
  );
  await upsertCanon(db, input);

  const canon = (await getCanon(db, "store-task"))?.canonMarkdown ?? "";
  assert.match(canon, /INTERVENING-DECISION/);
  assert.doesNotMatch(canon, /OLD-DECISION/);
  assert.match(canon, /## LATEST-PROGRESS\n- Progress only\.\n/);
});

test("carry-forward keeps a canon inserted by another writer for a new task", async () => {
  const db = canonTable({}, (rows) => rows.set("store-task", "# Canon: store-task\n\n## DECISIONS\n- FIRST-WRITER.\n"));
  await upsertCanon(db, input);

  const canon = (await getCanon(db, "store-task"))?.canonMarkdown ?? "";
  assert.match(canon, /FIRST-WRITER/);
  assert.match(canon, /## LATEST-PROGRESS\n- Progress only\.\n/);
});
