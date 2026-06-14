import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configPath, databaseUrlFor, loadConfig, localDockerConfig, maskDatabaseUrl, readStoredConfig, writeStoredConfig } from "../src/config.js";

test("stores and loads local Docker config", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-home-"));
  try {
    const runtime = localDockerConfig({ containerName: "test-container", volumeName: "test-volume", password: "secret", port: 55433 });
    const stored = {
      version: 1 as const,
      databaseUrl: databaseUrlFor(runtime),
      queueName: "default",
      checkpointDir: "~/.config/opencode/checkpoints",
      workerTimeoutSeconds: 45,
      runtime,
    };
    assert.equal(await writeStoredConfig(stored, home), configPath(home));
    assert.deepEqual(await readStoredConfig(home), stored);

    const loaded = loadConfig({ CONTINUITY_HOME: home });
    assert.equal(loaded.databaseUrl, stored.databaseUrl);
    assert.equal(loaded.checkpointDir, path.join(home, ".config/opencode/checkpoints"));
    assert.equal(loaded.workerTimeoutSeconds, 45);
    assert.equal(loaded.runtime?.kind, "docker");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("masks database password", () => {
  assert.equal(maskDatabaseUrl("postgresql://user:secret@127.0.0.1:5433/db"), "postgresql://user:***@127.0.0.1:5433/db");
});

test("ignores empty database environment variables", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-home-"));
  try {
    const loaded = loadConfig({ CONTINUITY_HOME: home, CONTINUITY_DATABASE_URL: "", ABSURD_DATABASE_URL: "" });
    assert.equal(loaded.databaseConfigured, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
