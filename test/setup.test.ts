import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, readStoredConfig, writeStoredConfig } from "../src/config.js";
import { installAgentContinuity } from "../src/install.js";
import { setupLocal, uninstallProduct } from "../src/setup.js";

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

test("product uninstall removes config and integrations without database access", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-home-"));
  const stored = {
    version: 1 as const,
    databaseUrl: "postgresql://continuity:secret@127.0.0.1:5433/agent_continuity",
    queueName: "default",
    checkpointDir: "~/.config/opencode/checkpoints",
    workerTimeoutSeconds: 30,
  };

  try {
    await writeStoredConfig(stored, home);
    await installAgentContinuity({ home });

    const config = loadConfig({ ...process.env, CONTINUITY_HOME: home });
    const actions = await uninstallProduct(config);
    const opencodeConfig = JSON.parse(await readFile(path.join(home, ".config/opencode/opencode.json"), "utf8"));
    const settings = JSON.parse(await readFile(path.join(home, ".claude/settings.json"), "utf8"));

    assert.equal(await readStoredConfig(home), null);
    assert.equal(opencodeConfig.plugin, undefined);
    assert.equal(settings.hooks, undefined);
    assert.ok(actions.some((action) => action.name === "docker-runtime" && action.status === "skipped"));
    assert.ok(actions.some((action) => action.name === "config" && action.status === "removed"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
