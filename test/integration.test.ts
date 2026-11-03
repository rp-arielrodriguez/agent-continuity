import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { runCheckpoint, readCanon } from "../src/workflow.js";
import type { CheckpointInput, ContinuityConfig } from "../src/types.js";

test("writes checkpoint through Absurd and exports markdown", { skip: !process.env.CONTINUITY_TEST_DATABASE_URL }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-"));
  const config: ContinuityConfig = {
    databaseUrl: process.env.CONTINUITY_TEST_DATABASE_URL!,
    queueName: process.env.CONTINUITY_TEST_QUEUE ?? "default",
    checkpointDir: dir,
    workerTimeoutSeconds: 30,
  };
  const input: CheckpointInput = {
    taskId: `integration-${Date.now()}`,
    timestamp: new Date().toISOString(),
    modelId: "node-test",
    sessionId: "integration-session",
    status: "completed",
    progress: "Integration checkpoint completed.",
    next: "Clean up.",
    checkpointDir: dir,
    source: "test",
  };

  try {
    const result = await runCheckpoint(input, config);
    assert.equal(result.appended, true);
    assert.equal(await readCanon(input.taskId, config), await readFile(result.canonPath, "utf8"));
    assert.match(await readFile(result.journalPath, "utf8"), /Integration checkpoint completed\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("progress-only checkpoint carries the previous canon forward on the PostgreSQL path", { skip: !process.env.CONTINUITY_TEST_DATABASE_URL }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-"));
  const config: ContinuityConfig = {
    databaseUrl: process.env.CONTINUITY_TEST_DATABASE_URL!,
    queueName: process.env.CONTINUITY_TEST_QUEUE ?? "default",
    checkpointDir: dir,
    workerTimeoutSeconds: 30,
  };
  const taskId = `integration-carry-${Date.now()}`;
  const base: CheckpointInput = {
    taskId,
    timestamp: new Date().toISOString(),
    modelId: "node-test",
    sessionId: "integration-session",
    status: "in_progress",
    progress: "First.",
    next: "Second.",
    checkpointDir: dir,
    source: "test",
  };

  try {
    await runCheckpoint({
      ...base,
      canonMarkdown: `# Canon: ${taskId}\n\nlast-reconciled: x\n\n## CURRENT-TRUTH / INVARIANTS\n- INVARIANT-X: keep me.\n\n## NEXT-ACTION\n- Old.\n`,
    }, config);
    await runCheckpoint({ ...base, timestamp: new Date(Date.parse(base.timestamp) + 1000).toISOString(), progress: "Progress only.", next: "New next." }, config);
    const canon = await readCanon(taskId, config);
    assert.match(canon ?? "", /INVARIANT-X: keep me\./);
    assert.match(canon ?? "", /## LATEST-PROGRESS\n- Progress only\.\n/);
    assert.match(canon ?? "", /## NEXT-ACTION\n- New next\.\n/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a recorded decision survives later checkpoints and an unknown --resolve writes nothing on the PostgreSQL path", { skip: !process.env.CONTINUITY_TEST_DATABASE_URL }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-"));
  const config: ContinuityConfig = {
    databaseUrl: process.env.CONTINUITY_TEST_DATABASE_URL!,
    queueName: process.env.CONTINUITY_TEST_QUEUE ?? "default",
    checkpointDir: dir,
    workerTimeoutSeconds: 30,
  };
  const taskId = `integration-decision-${Date.now()}`;
  const start = Date.now();
  const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
  const base: CheckpointInput = { taskId, timestamp: at(0), modelId: "node-test", sessionId: "integration-session", status: "in_progress", progress: "Seed.", checkpointDir: dir, source: "test" };
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const journalCount = async () => Number((await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM continuity.journal_entries WHERE task_id = $1`, [taskId])).rows[0].n);

  try {
    await runCheckpoint({ ...base, canonMarkdown: `# Canon: ${taskId}\n\n## OPEN DESIGN\nCompute CLI shape. Awaiting Ariel's choice.\nConcurrency contract.\n\n## NEXT-ACTION\n- Decide.\n` }, config);
    const decided = await runCheckpoint({ ...base, timestamp: at(1), progress: "Ariel decided.", next: "Implement.", decisions: ["Compute: persisted apply flag."], resolve: ["awaiting ariel"] }, config);
    assert.deepEqual(decided.openItems, [{ section: "OPEN DESIGN", text: "Concurrency contract." }]);
    assert.deepEqual(decided.warnings, []);
    await runCheckpoint({ ...base, timestamp: at(2), progress: "Unrelated progress." }, config);

    const canon = (await readCanon(taskId, config)) ?? "";
    assert.match(canon, /## DECISIONS\n- Compute: persisted apply flag\.\n/);
    assert.doesNotMatch(canon, /Awaiting/);
    assert.match(canon, /## LATEST-PROGRESS\n- Unrelated progress\.\n/);

    const entries = await journalCount();
    await assert.rejects(runCheckpoint({ ...base, timestamp: at(3), progress: "Bad.", resolve: ["no such item"] }, config), /no open item matches --resolve "no such item"/);
    assert.equal(await journalCount(), entries);
    assert.equal(await readCanon(taskId, config), canon);
  } finally {
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  }
});
