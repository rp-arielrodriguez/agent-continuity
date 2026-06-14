import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readStoredConfig, writeStoredConfig } from "../src/config.js";
import { setupLocal } from "../src/setup.js";

test("setup reuses existing database config without Docker runtime", { skip: !process.env.CONTINUITY_TEST_DATABASE_URL }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-home-"));
  const stored = {
    version: 1 as const,
    databaseUrl: process.env.CONTINUITY_TEST_DATABASE_URL!,
    queueName: process.env.CONTINUITY_TEST_QUEUE ?? "default",
    checkpointDir: "~/.config/opencode/checkpoints",
    workerTimeoutSeconds: 30,
  };

  try {
    await writeStoredConfig(stored, home);
    const result = await setupLocal({ home, install: false });

    assert.equal(result.databaseUrl, stored.databaseUrl);
    assert.equal(result.actions.some((action) => action.name === "docker-container"), false);
    assert.equal(result.actions.some((action) => action.name === "docker-volume"), false);
    assert.deepEqual(await readStoredConfig(home), stored);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
