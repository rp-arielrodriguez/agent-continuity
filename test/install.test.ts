import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installAgentContinuity } from "../src/install.js";

test("installs OpenCode and Claude integrations into a home directory", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-home-"));
  try {
    const result = await installAgentContinuity({ home });
    assert.equal(result.target, "all");
    assert.ok(result.wrote.some((file) => file.endsWith(".claude/settings.json")));

    const opencodeConfig = JSON.parse(await readFile(path.join(home, ".config/opencode/opencode.json"), "utf8"));
    assert.equal(opencodeConfig.$schema, "https://opencode.ai/config.json");
    assert.equal(opencodeConfig.plugin.length, 1);
    assert.equal(opencodeConfig.plugin[0], "agent-continuity");

    const settings = JSON.parse(await readFile(path.join(home, ".claude/settings.json"), "utf8"));
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, "bash ~/.claude/hooks/agent-continuity-session-start.sh");
    assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, "bash ~/.claude/hooks/agent-continuity-user-prompt-submit.sh");

    const mode = (await stat(path.join(home, ".claude/hooks/agent-continuity-session-start.sh"))).mode;
    assert.equal(mode & 0o111, 0o111);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("installer is idempotent", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-home-"));
  try {
    await installAgentContinuity({ home });
    const second = await installAgentContinuity({ home });
    assert.equal(second.wrote.length, 0);
    assert.equal(second.removed.length, 0);
    assert.ok(second.skipped.some((file) => file.endsWith(".config/opencode/opencode.json")));
    assert.ok(second.skipped.some((file) => file.endsWith(".claude/settings.json")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("installer migrates legacy OpenCode file plugin to npm package", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-home-"));
  const pluginDir = path.join(home, ".config/opencode/plugins");
  const pluginPath = path.join(pluginDir, "agent-continuity.js");
  const configPath = path.join(home, ".config/opencode/opencode.json");
  try {
    await mkdir(pluginDir, { recursive: true });
    await writeFile(pluginPath, "export default async () => ({})\n", "utf8");
    await writeFile(configPath, JSON.stringify({ plugin: [`file://${pluginPath}`] }, null, 2), "utf8");

    const result = await installAgentContinuity({ home, target: "opencode" });
    const opencodeConfig = JSON.parse(await readFile(configPath, "utf8"));

    assert.deepEqual(opencodeConfig.plugin, ["agent-continuity"]);
    assert.ok(result.removed.includes(pluginPath));
    await assert.rejects(readFile(pluginPath, "utf8"), /ENOENT/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
