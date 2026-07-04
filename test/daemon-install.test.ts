import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { installDaemonRuntime, renderLaunchdPlist } from "../src/daemon-install.js";

test("daemon installer dry-run reports binary, state, socket, database, and launchd paths", async () => {
  const home = "/Users/ariel";
  const result = await installDaemonRuntime({
    home,
    dryRun: true,
    launchd: true,
    peerListen: "100.64.0.2:9987",
  });

  assert.equal(result.binaryPath, path.join(home, ".local", "bin", "continuityd"));
  assert.equal(result.stateDir, path.join(home, ".local", "state", "agent-continuity"));
  assert.equal(result.socketPath, path.join(result.stateDir, "continuityd.sock"));
  assert.equal(result.dbPath, path.join(result.stateDir, "continuity.db"));
  assert.equal(result.launchdPlistPath, path.join(home, "Library", "LaunchAgents", "com.agent-continuity.continuityd.plist"));
  assert.deepEqual(
    result.actions.map((action) => action.status),
    ["skipped", "skipped", "skipped", "skipped"],
  );
});

test("daemon installer keeps long default socket paths under Unix socket limits", async () => {
  const home = `/tmp/${"very-long-continuity-home-".repeat(6)}`;
  const result = await installDaemonRuntime({
    home,
    dryRun: true,
  });

  assert.equal(result.stateDir, path.join(home, ".local", "state", "agent-continuity"));
  assert.match(result.socketPath, /^\/tmp\/continuityd-[a-f0-9]{16}\.sock$/);
  assert.ok(Buffer.byteLength(result.socketPath) <= 100);
});

test("launchd plist escapes values and includes peer listener when configured", () => {
  const plist = renderLaunchdPlist({
    label: "com.example.<continuity>",
    binaryPath: "/Users/ariel/.local/bin/continuityd",
    socketPath: "/tmp/continuityd.sock",
    dbPath: "/tmp/continuity.db",
    peerListen: "100.64.0.2:9987",
    stdoutPath: "/tmp/out.log",
    stderrPath: "/tmp/err.log",
  });

  assert.match(plist, /com\.example\.&lt;continuity&gt;/);
  assert.match(plist, /<string>--peer-listen<\/string>/);
  assert.match(plist, /<string>100.64.0.2:9987<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>/);
});
