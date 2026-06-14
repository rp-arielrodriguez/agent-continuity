import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
