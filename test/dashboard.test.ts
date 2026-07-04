import test from "node:test";
import assert from "node:assert/strict";
import { loadDashboardSnapshot, renderDashboard, type DashboardProvider } from "../src/dashboard.js";
import type { TaskBlock } from "../src/block.js";

const ref = {
  projectId: "rp-arielrodriguez/agent-continuity",
  taskId: "agent-continuity-decentralized-runtime",
  laneId: "main",
};

test("loads and renders a tmux-friendly dashboard snapshot", async () => {
  const provider: DashboardProvider = {
    async health() {
      return { ok: true, provider: "continuityd", version: 1 };
    },
    async status() {
      return {
        action: "continue",
        lane: {
          ...ref,
          tip: "blk_1111111111111111111111111111111111111111111111111111111111111111",
          leaseEpoch: 2,
          owner: {
            nodeId: "macbook-ariel",
            actorId: "codex-session-1",
            leaseEpoch: 2,
            leaseUntil: "2026-07-03T23:00:00.000Z",
          },
          checkpoint: {
            status: "in_progress",
            progress: "Phase 9 dashboard implementation.",
            next: "Wire CLI command.",
          },
        },
      };
    },
    async blocks() {
      return [
        block("bootstrap", "2026-07-03T22:00:00.000Z"),
        block("claim_lane", "2026-07-03T22:01:00.000Z"),
        block("checkpoint", "2026-07-03T22:02:00.000Z"),
      ];
    },
    async discoverPeers() {
      return {
        peers: [
          {
            provider: "tailscale",
            nodeId: "node-trusted",
            name: "workstation",
            endpoint: "tcp://100.64.0.2:9987",
            online: true,
          },
        ],
        warnings: ["zerotier discovery failed: executable file not found"],
      };
    },
  };

  const snapshot = await loadDashboardSnapshot(provider, {
    ...ref,
    now: "2026-07-03T22:10:00.000Z",
    recentLimit: 2,
    discovery: {
      port: 9987,
      trustedNames: ["workstation"],
    },
  });
  const rendered = renderDashboard(snapshot);

  assert.equal(snapshot.blockCount, 3);
  assert.equal(snapshot.recentBlocks.length, 2);
  assert.match(rendered, /Continuity Dashboard/);
  assert.match(rendered, /action\s+continue/);
  assert.match(rendered, /owner\s+macbook-ariel\/codex-session-1/);
  assert.match(rendered, /tailscale workstation tcp:\/\/100\.64\.0\.2:9987 online/);
  assert.match(rendered, /Warnings/);
});

function block(kind: TaskBlock["kind"], createdAt: string): TaskBlock {
  const suffix = kind.padEnd(16, "_");
  return {
    version: 1,
    blockId: `blk_${suffix}111111111111111111111111111111111111111111111111`,
    projectId: ref.projectId,
    taskId: ref.taskId,
    laneId: ref.laneId,
    kind,
    parentTips: [],
    nodeId: "macbook-ariel",
    actorId: "codex-session-1",
    leaseEpoch: 1,
    createdAt,
    payloadHash: "sha256:test",
    payload: {},
    signature: {
      scheme: "ed25519",
      publicKey: "test",
      value: "test",
    },
  } as TaskBlock;
}
