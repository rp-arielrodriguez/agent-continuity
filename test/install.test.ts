import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installAgentContinuity, uninstallAgentContinuity } from "../src/install.js";

test("installs Codex, OpenCode, and Claude integrations into a home directory", async () => {
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
    assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, "bash ~/.claude/hooks/agent-continuity-user-prompt-submit.sh");
    assert.equal(settings.hooks.SessionStart, undefined);

    const codex = JSON.parse(await readFile(path.join(home, ".codex/hooks.json"), "utf8"));
    assert.equal(codex.hooks.UserPromptSubmit[0].hooks[0].command, "bash ~/.codex/hooks/agent-continuity-user-prompt-submit.sh");
    assert.equal(codex.hooks.SubagentStart[0].hooks[0].command, "bash ~/.codex/hooks/agent-continuity-subagent-start.sh");
    assert.equal(codex.hooks.PostCompact[0].matcher, "manual|auto");
    assert.equal(codex.hooks.SessionStart, undefined);

    const mode = (await stat(path.join(home, ".claude/hooks/agent-continuity-user-prompt-submit.sh"))).mode;
    assert.equal(mode & 0o111, 0o111);
    const codexMode = (await stat(path.join(home, ".codex/hooks/agent-continuity-post-compact.sh"))).mode;
    assert.equal(codexMode & 0o111, 0o111);

    for (const skill of [
      path.join(home, ".config/opencode/skills/checkpoints/SKILL.md"),
      path.join(home, ".claude/skills/checkpoints/SKILL.md"),
      path.join(home, ".codex/skills/checkpoints/SKILL.md"),
    ]) {
      const content = await readFile(skill, "utf8");
      assert.match(content, /continuity agent-contract/);
      assert.doesNotMatch(content, /PostgreSQL\/Absurd is the authority/);
    }
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
    assert.ok(second.skipped.some((file) => file.endsWith(".codex/hooks.json")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("installer repairs executable hook permissions without rewriting content", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-home-"));
  const hook = path.join(home, ".codex/hooks/agent-continuity-user-prompt-submit.sh");
  try {
    await installAgentContinuity({ home, target: "codex" });
    await chmod(hook, 0o644);

    const result = await installAgentContinuity({ home, target: "codex" });

    assert.ok(result.wrote.includes(hook));
    assert.equal((await stat(hook)).mode & 0o777, 0o755);
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

test("installer removes legacy Claude continuity session start hook", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-home-"));
  const settingsPath = path.join(home, ".claude/settings.json");
  try {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { hooks: [{ type: "command", command: "echo keep-model-rule" }] },
              { hooks: [{ type: "command", command: "bash ~/.claude/hooks/agent-continuity-session-start.sh" }] },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await installAgentContinuity({ home, target: "claude" });
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));

    assert.deepEqual(settings.hooks.SessionStart, [{ hooks: [{ type: "command", command: "echo keep-model-rule" }] }]);
    assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, "bash ~/.claude/hooks/agent-continuity-user-prompt-submit.sh");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("installer replaces legacy Codex continuity hooks without touching unrelated hooks", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-home-"));
  const hooksPath = path.join(home, ".codex/hooks.json");
  const hooksDir = path.join(home, ".codex/hooks");
  try {
    await mkdir(hooksDir, { recursive: true });
    await writeFile(path.join(hooksDir, "agent-continuity-session-start.sh"), "stale\n", "utf8");
    await writeFile(
      hooksPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "echo keep-model-rule" }] },
            { hooks: [{ type: "command", command: "bash /old/agent-continuity-session-start.sh" }] },
          ],
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "bash /old/agent-continuity-user-prompt-submit.sh" }] },
          ],
        },
      }, null, 2),
      "utf8",
    );

    await installAgentContinuity({ home, target: "codex" });
    const settings = JSON.parse(await readFile(hooksPath, "utf8"));

    assert.deepEqual(settings.hooks.SessionStart, [{ hooks: [{ type: "command", command: "echo keep-model-rule" }] }]);
    assert.equal(settings.hooks.UserPromptSubmit.length, 1);
    assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, "bash ~/.codex/hooks/agent-continuity-user-prompt-submit.sh");
    await assert.rejects(readFile(path.join(hooksDir, "agent-continuity-session-start.sh"), "utf8"), /ENOENT/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("uninstaller removes Codex, OpenCode, and Claude integrations", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-home-"));
  try {
    await installAgentContinuity({ home });
    const result = await uninstallAgentContinuity({ home });

    const opencodeConfig = JSON.parse(await readFile(path.join(home, ".config/opencode/opencode.json"), "utf8"));
    const settings = JSON.parse(await readFile(path.join(home, ".claude/settings.json"), "utf8"));
    const codex = JSON.parse(await readFile(path.join(home, ".codex/hooks.json"), "utf8"));

    assert.equal(opencodeConfig.plugin, undefined);
    assert.equal(settings.hooks, undefined);
    assert.equal(codex.hooks, undefined);
    assert.ok(result.removed.some((file) => file.endsWith("agent-continuity-user-prompt-submit.sh")));
    assert.ok(result.wrote.some((file) => file.endsWith(".config/opencode/opencode.json")));
    assert.ok(result.wrote.some((file) => file.endsWith(".claude/settings.json")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
