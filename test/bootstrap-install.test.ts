import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = process.cwd();
const installer = path.join(root, "install.sh");

test("bootstrap installer has valid bash syntax", async () => {
  await execFile("bash", ["-n", installer]);
});

test("bootstrap installer help describes fresh install modes", async () => {
  const { stdout } = await execFile("bash", [installer, "--help"]);

  assert.match(stdout, /Agent Continuity bootstrap installer/);
  assert.match(stdout, /--from-source DIR/);
  assert.match(stdout, /--from-tarball FILE\|URL/);
  assert.match(stdout, /--no-product-install/);
});

test("bootstrap installer dry-run installs a package without product install", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "continuity-bootstrap-home-"));
  try {
    const prefix = path.join(home, ".local");
    const { stdout } = await execFile("bash", [
      installer,
      "--dry-run",
      "--prefix",
      prefix,
      "--package",
      "agent-continuity-test",
      "--no-product-install",
    ]);

    assert.match(stdout, new RegExp(`prefix: ${escapeRegExp(prefix)}`));
    assert.match(stdout, /package: agent-continuity-test/);
    assert.match(stdout, /\+ npm install -g --prefix .* agent-continuity-test/);
    assert.match(stdout, /skipped product install/);
    assert.doesNotMatch(stdout, /continuity install/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("bootstrap installer dry-run supports source checkout and install arg passthrough", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "continuity-bootstrap-home-"));
  try {
    const prefix = path.join(home, ".local");
    const { stdout } = await execFile("bash", [
      installer,
      "--dry-run",
      "--prefix",
      prefix,
      "--from-source",
      ".",
      "--",
      "--no-integrations",
      "--peer-listen",
      ":9987",
    ]);

    assert.match(stdout, new RegExp(`package: ${escapeRegExp(root)}`));
    assert.match(stdout, /\+ npm install -g --prefix .*agent-continuity/);
    assert.match(stdout, /continuity install .*--no-integrations .*--peer-listen :9987/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
