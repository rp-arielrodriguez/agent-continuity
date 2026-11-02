import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readDaemonCanon, runDaemonCheckpoint } from "../src/daemon-workflow.js";
import { MemoryProvider } from "../src/provider.js";
import { assertCanonEditsApply, getCanon, upsertCanon } from "../src/store.js";
import type { Queryable } from "../src/schema.js";
import type { CheckpointInput } from "../src/types.js";

// In-memory continuity.canons table; `beforeWrite` runs once, just before the first write.
function canonTable(seed: Record<string, string>, beforeWrite: (rows: Map<string, string>) => void): Queryable {
  const rows = new Map(Object.entries(seed));
  let intercepted = false;
  return {
    async query<T>(text: string, params: unknown[] = []) {
      const [taskId, , canon, previous] = params as string[];
      if (text.includes("journal_entries")) return { rows: [] as T[], rowCount: 0 };
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

const incidentCanon = `# Canon: store-task

## DECISIONS
Option B.

## OPEN DESIGN
Compute CLI shape. Awaiting Ariel's choice.
Concurrency contract.

## NEXT-ACTION
- Decide compute shape.
`;

test("--resolve that matches nothing fails before any PostgreSQL write", async () => {
  let writes = 0;
  const db = canonTable({ "store-task": incidentCanon }, () => (writes += 1));
  const bad = { ...input, decisions: ["X."], resolve: ["no such item"] };
  await assert.rejects(assertCanonEditsApply(db, bad), /no open item matches --resolve "no such item"/);
  await assert.rejects(upsertCanon(db, bad), /no open item matches/);
  assert.equal(writes, 0);
  assert.equal((await getCanon(db, "store-task"))?.canonMarkdown, incidentCanon);
  await assertCanonEditsApply(db, { ...input, resolve: ["awaiting ariel"] });
});

test("PostgreSQL and daemon paths produce the same canon for the same decision sequence", async () => {
  const steps = [
    { timestamp: "2026-11-01T07:01:00.000Z", progress: "Ariel decided.", decisions: ["Compute: persisted apply flag."], resolve: ["Awaiting Ariel's choice"], next: "Parent lane." },
    { timestamp: "2026-11-01T07:02:00.000Z", progress: "Unrelated progress.", decisions: ["Compute: persisted apply flag."] },
  ];
  const db = canonTable({ "store-task": incidentCanon }, () => undefined);
  for (const step of steps) await upsertCanon(db, { ...input, ...step });

  const stateDir = await mkdtemp(path.join(os.tmpdir(), "continuity-store-parity-"));
  const provider = new MemoryProvider();
  const lane = { projectId: "parity/project", taskId: "store-task", laneId: "main" };
  try {
    await runDaemonCheckpoint({ ...input, ...lane, provider, stateDir, timestamp: "2026-11-01T07:00:00.000Z", progress: "Seed.", canonMarkdown: incidentCanon });
    for (const step of steps) await runDaemonCheckpoint({ ...input, ...lane, provider, stateDir, ...step });
    const daemonCanon = (await readDaemonCanon({ ...lane, provider })).canonMarkdown;
    const postgresCanon = (await getCanon(db, "store-task"))?.canonMarkdown;
    assert.equal(daemonCanon, postgresCanon);
    assert.match(postgresCanon ?? "", /## DECISIONS\nOption B\.\n- Compute: persisted apply flag\.\n\n/);
    assert.doesNotMatch(postgresCanon ?? "", /Awaiting/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
