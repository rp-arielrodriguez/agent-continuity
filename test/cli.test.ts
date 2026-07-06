import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

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
        assert.match(result.stderr ?? "", /unsupported --target vim/);
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
