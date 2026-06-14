import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installAgentContinuity } from "../src/install.js";

test("installs OpenCode and Claude integrations into a home directory", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-home-"));
  try {
    const result = await installAgentContinuity({ home });
    assert.equal(result.target, "all");
    assert.ok(result.wrote.some((file) => file.endsWith(".config/opencode/plugins/agent-continuity.js")));
    assert.ok(result.wrote.some((file) => file.endsWith(".claude/settings.json")));

    const opencodeConfig = JSON.parse(await readFile(path.join(home, ".config/opencode/opencode.json"), "utf8"));
    assert.equal(opencodeConfig.$schema, "https://opencode.ai/config.json");
    assert.equal(opencodeConfig.plugin.length, 1);
    assert.match(opencodeConfig.plugin[0], /^file:\/\/.*agent-continuity\.js$/);

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
    assert.ok(second.skipped.some((file) => file.endsWith(".config/opencode/plugins/agent-continuity.js")));
    assert.ok(second.skipped.some((file) => file.endsWith(".claude/settings.json")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
