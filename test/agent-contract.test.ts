import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  AGENT_CONTRACT_VERSION,
  agentIntentContract,
  agentIntentKinds,
  commandIntentContract,
  parseAgentIntentKind,
  renderAgentIntentContract,
} from "../src/agent-contract.js";

const execFile = promisify(execFileCallback);

test("agent contract covers every supported semantic intent", () => {
  assert.deepEqual(agentIntentKinds(), [
    "orient",
    "resume",
    "checkpoint",
    "claim",
    "sync",
    "session",
    "run-event",
    "handoff",
    "delegate",
    "speculate",
    "result",
    "evaluate",
    "adjudicate",
    "recover",
  ]);

  const checkpoint = agentIntentContract("checkpoint");
  assert.equal(checkpoint.version, AGENT_CONTRACT_VERSION);
  assert.match(checkpoint.preferredCommand, /checkpoint --daemon/);
  assert.match(checkpoint.preferredCommand, /--project-id <PROJECT-ID>/);
  assert.match(checkpoint.invariants.join("\n"), /Do not edit markdown checkpoint projections as authority/);
  assert.equal(commandIntentContract("checkpoint"), checkpoint);
});

test("agent contract has stable human and machine validation behavior", () => {
  const rendered = renderAgentIntentContract(agentIntentContract("recover"));
  assert.match(rendered, /^Agent Continuity contract 1\.0\.0/m);
  assert.match(rendered, /continuity session-resume --last/);
  assert.throws(() => parseAgentIntentKind("guess"), /unsupported --intent guess/);
});

test("agent adapters delegate guidance to the executable contract", async () => {
  const root = process.cwd();
  const files = [
    "integrations/shared/hooks/user-prompt-submit.sh",
    "integrations/codex/hooks/subagent-start.sh",
    "integrations/codex/hooks/post-compact.sh",
    "integrations/shared/skills/checkpoints/SKILL.md",
    "src/opencode.ts",
  ];

  for (const file of files) {
    const content = await readFile(path.join(root, file), "utf8");
    assert.match(content, /agent-contract/, `${file} must query or teach the executable contract`);
    assert.doesNotMatch(content, /PostgreSQL\/Absurd is the authority/, `${file} contains stale authority guidance`);
    assert.doesNotMatch(content, /checkpoint through PostgreSQL\/Absurd/, `${file} contains a stale checkpoint command`);
  }
});

test("prompt and compaction hooks query the installed executable contract", async () => {
  const root = process.cwd();
  const binDir = await mkdtemp(path.join(os.tmpdir(), "continuity-contract-bin-"));
  const fakeContinuity = path.join(binDir, "continuity");
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };
  try {
    await writeFile(fakeContinuity, "#!/usr/bin/env bash\nprintf 'contract-call: %s\\n' \"$*\"\n", "utf8");
    await chmod(fakeContinuity, 0o755);

    const prompt = await execFile(
      "bash",
      ["-c", "bash \"$1\" </dev/null", "hook-test", path.join(root, "integrations/shared/hooks/user-prompt-submit.sh")],
      { env: { ...env, CLAUDE_USER_PROMPT: "checkpoint this task" } },
    );
    assert.equal(prompt.stdout, "contract-call: agent-contract --intent checkpoint\n");

    const compact = await execFile(
      "bash",
      ["-c", "bash \"$1\" </dev/null", "hook-test", path.join(root, "integrations/codex/hooks/post-compact.sh")],
      { env },
    );
    const output = JSON.parse(compact.stdout) as { continue: boolean; systemMessage: string };
    assert.equal(output.continue, true);
    assert.equal(output.systemMessage, "contract-call: agent-contract --intent recover");
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
});
