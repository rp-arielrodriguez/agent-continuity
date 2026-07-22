import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

test("command help does not execute commands or require runtime options", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-home-"));
  const env = { ...process.env, CONTINUITY_HOME: home, CONTINUITY_DATABASE_URL: "", ABSURD_DATABASE_URL: "" };
  const cli = path.join(process.cwd(), "dist/src/cli.js");

  try {
    for (const args of [["checkpoint", "--help"], ["checkpoint", "-h"], ["help", "checkpoint"]]) {
      const result = await execFile(process.execPath, [cli, ...args], { env });
      assert.match(result.stdout, /^continuity checkpoint/m);
      assert.match(result.stdout, /intent: checkpoint/);
      assert.match(result.stdout, /checkpoint --daemon/);
      assert.equal(result.stderr, "");
    }

    const json = await execFile(process.execPath, [cli, "checkpoint", "--help", "--json"], { env });
    const parsed = JSON.parse(json.stdout) as { command: string; contract: { intent: string; requiredContext: string[] } };
    assert.equal(parsed.command, "checkpoint");
    assert.equal(parsed.contract.intent, "checkpoint");
    assert.deepEqual(parsed.contract.requiredContext, ["projectId", "taskId", "status", "progress", "next"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("agent contract exposes success and actionable validation errors", async () => {
  const cli = path.join(process.cwd(), "dist/src/cli.js");
  const success = await execFile(process.execPath, [cli, "agent-contract", "--intent", "checkpoint", "--json"]);
  const parsed = JSON.parse(success.stdout) as { version: string; intent: string; preferredCommand: string };
  assert.equal(parsed.version, "1.0.0");
  assert.equal(parsed.intent, "checkpoint");
  assert.match(parsed.preferredCommand, /--progress <SUMMARY>/);

  await assert.rejects(
    execFile(process.execPath, [cli, "agent-contract", "--intent", "unknown"]),
    (error: unknown) => {
      const result = error as { stderr?: string; code?: number };
      assert.equal(result.code, 1);
      assert.match(result.stderr ?? "", /unsupported --intent unknown; expected orient, resume, checkpoint/);
      return true;
    },
  );
});

test("database commands fail clearly before setup", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-home-"));
  const env = { ...process.env, CONTINUITY_HOME: home, CONTINUITY_DATABASE_URL: "", ABSURD_DATABASE_URL: "" };
  const cli = path.join(process.cwd(), "dist/src/cli.js");

  try {
    await assert.rejects(
      execFile(process.execPath, [cli, "status"], { env }),
      (error: unknown) => {
        const result = error as { stderr?: string; code?: number };
        assert.equal(result.code, 1);
        assert.match(result.stderr ?? "", /run continuity setup --local or set CONTINUITY_DATABASE_URL/);
        return true;
      },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("daemon resume without project id fails loudly outside a git checkout", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-home-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-nongit-"));
  const env = { ...process.env, CONTINUITY_HOME: home };
  const cli = path.join(process.cwd(), "dist/src/cli.js");

  try {
    await assert.rejects(
      execFile(process.execPath, [cli, "resume", "--daemon", "--task-id", "TARCH-175"], { cwd, env }),
      (error: unknown) => {
        const result = error as { stderr?: string; code?: number };
        assert.equal(result.code, 1);
        assert.match(result.stderr ?? "", /missing --project-id and git remote\.origin\.url could not be read/);
        return true;
      },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("install rejects unsupported integration targets", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-home-"));
  const env = { ...process.env, CONTINUITY_HOME: home };
  const cli = path.join(process.cwd(), "dist/src/cli.js");

  try {
    await assert.rejects(
      execFile(process.execPath, [cli, "install", "--target", "vim"], { env }),
      (error: unknown) => {
        const result = error as { stderr?: string; code?: number };
        assert.equal(result.code, 1);
        assert.match(result.stderr ?? "", /unsupported --target vim; expected all, codex, opencode, or claude/);
        return true;
      },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("full install dry-run fails explicitly until supported", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-home-"));
  const env = { ...process.env, CONTINUITY_HOME: home };
  const cli = path.join(process.cwd(), "dist/src/cli.js");

  try {
    await assert.rejects(
      execFile(process.execPath, [cli, "install", "--dry-run"], { env }),
      (error: unknown) => {
        const result = error as { stderr?: string; code?: number };
        assert.equal(result.code, 1);
        assert.match(result.stderr ?? "", /--dry-run is only supported with install --target/);
        return true;
      },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("uninstall does not require a configured database", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-home-"));
  const env = { ...process.env, CONTINUITY_HOME: home, CONTINUITY_DATABASE_URL: "", ABSURD_DATABASE_URL: "" };
  const cli = path.join(process.cwd(), "dist/src/cli.js");

  try {
    const result = await execFile(process.execPath, [cli, "uninstall"], { env });
    assert.match(result.stdout, /daemon: skipped/);
    assert.match(result.stdout, /docker-runtime: skipped/);
    assert.match(result.stdout, /Data was kept/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("presence-publish can derive a signed endpoint from --port without a fixed IP", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-home-"));
  const rendezvous = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-rendezvous-"));
  const env = { ...process.env, CONTINUITY_HOME: home };
  const cli = path.join(process.cwd(), "dist/src/cli.js");

  try {
    const result = await execFile(process.execPath, [
      cli,
      "presence-publish",
      "--json",
      "--rendezvous",
      rendezvous,
      "--port",
      "9987",
      "--host",
      "other-machine",
      "--node-id",
      "smoke-node",
      "--state-dir",
      path.join(home, "daemon"),
      "--now",
      "2026-07-04T13:30:00.000Z",
    ], { env });

    const output = JSON.parse(result.stdout) as { presence: { endpoints: Array<{ endpoint: string }> } };
    assert.equal(output.presence.endpoints[0].endpoint, "tcp://other-machine.local:9987");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(rendezvous, { recursive: true, force: true });
  }
});

test("node-init discover requires an explicit trust filter", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-home-"));
  const rendezvous = await mkdtemp(path.join(os.tmpdir(), "agent-continuity-rendezvous-"));
  const env = { ...process.env, CONTINUITY_HOME: home };
  const cli = path.join(process.cwd(), "dist/src/cli.js");

  try {
    await assert.rejects(
      execFile(process.execPath, [
        cli,
        "node-init",
        "--no-daemon-install",
        "--no-start",
        "--no-advertise",
        "--discover",
        "--endpoint",
        "tcp://node-a:9987",
        "--backend",
        "file",
        "--dir",
        rendezvous,
        "--node-id",
        "node-a",
      ], { env }),
      (error: unknown) => {
        const result = error as { stderr?: string; code?: number };
        assert.equal(result.code, 1);
        assert.match(result.stderr ?? "", /node-init --discover requires --trusted-names, --trust-names, or --trusted-node-ids/);
        return true;
      },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(rendezvous, { recursive: true, force: true });
  }
});
