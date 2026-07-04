import test from "node:test";
import assert from "node:assert/strict";
import { projectIdFromRemote } from "../src/project.js";

test("project id parser supports common git remote URL shapes", () => {
  assert.equal(projectIdFromRemote("git@github.com:rp-arielrodriguez/agent-continuity.git"), "rp-arielrodriguez/agent-continuity");
  assert.equal(projectIdFromRemote("https://github.com/rp-arielrodriguez/agent-continuity.git"), "rp-arielrodriguez/agent-continuity");
  assert.equal(projectIdFromRemote("ssh://git@github.com/rp-arielrodriguez/agent-continuity.git"), "rp-arielrodriguez/agent-continuity");
});

test("project id parser rejects values without owner and repo", () => {
  assert.equal(projectIdFromRemote("agent-continuity"), null);
});
