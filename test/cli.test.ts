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
