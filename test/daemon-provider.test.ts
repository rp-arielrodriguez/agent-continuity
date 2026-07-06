import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createEd25519Signer, type TaskBlock } from "../src/block.js";
import { LocalDaemonProvider, UnixJsonRpcClient, defaultContinuitydSocketPath } from "../src/daemon-provider.js";

const ref = {
  projectId: "rp-arielrodriguez/agent-continuity",
  taskId: "agent-continuity-decentralized-runtime",
  laneId: "main",
};

test("local daemon provider calls health and lane status over a Unix socket", async () => {
  await withRpcServer(async (request) => {
    if (request.method === "provider.health") {
      return { ok: true, provider: "continuityd", version: 1 };
    }
    if (request.method === "lane.status") {
      return {
        lane: { ...ref, leaseEpoch: 0 },
        action: "continue",
      };
    }
    throw new Error(`unexpected method ${request.method}`);
  }, async (socketPath) => {
    const provider = new LocalDaemonProvider({ socketPath });

    assert.deepEqual(await provider.health(), { ok: true, provider: "continuityd", version: 1 });
    const status = await provider.status(ref);

    assert.equal(status.action, "continue");
    assert.equal(status.lane.taskId, ref.taskId);
    assert.equal(status.lane.leaseEpoch, 0);
  });
});

test("local daemon provider builds signed blocks and submits them through JSON-RPC", async () => {
  const signer = createEd25519Signer({ nodeId: "macbook-ariel", actorId: "codex-session-1" });
  let submitted: TaskBlock | undefined;

  await withRpcServer(async (request) => {
    if (request.method === "lane.status") {
      return {
        lane: { ...ref, leaseEpoch: 0 },
        action: "continue",
      };
    }
    if (request.method === "block.submit") {
      submitted = (request.params as { block: TaskBlock }).block;
      return {
        accepted: true,
        action: "continue",
        lane: { ...ref, tip: submitted.blockId, leaseEpoch: 0 },
        block: submitted,
      };
    }
    throw new Error(`unexpected method ${request.method}`);
  }, async (socketPath) => {
    const provider = new LocalDaemonProvider({ socketPath });
    const result = await provider.bootstrap({
      ...ref,
      signer,
      createdAt: "2026-07-03T21:00:00.000Z",
      payload: {
        summary: "Bootstrap through daemon provider.",
      },
    });

    assert.equal(result.accepted, true);
    assert.equal(submitted?.kind, "bootstrap");
    assert.equal(submitted?.leaseEpoch, 0);
    assert.deepEqual(submitted?.parentTips, []);
    assert.match(submitted?.signature.value ?? "", /^[A-Za-z0-9_-]+$/);
  });
});

test("local daemon provider calls static peer sync over JSON-RPC", async () => {
  let params: unknown;
  await withRpcServer(async (request) => {
    if (request.method !== "peer.sync") throw new Error(`unexpected method ${request.method}`);
    params = request.params;
    return {
      ...ref,
      peers: [{ endpoint: "unix:///tmp/peer.sock", fetched: 3, accepted: 3, inserted: 3 }],
      fetchedBlocks: 3,
      acceptedBlocks: 3,
      insertedBlocks: 3,
      rejectedBlocks: 0,
      finalTip: "blk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
  }, async (socketPath) => {
    const provider = new LocalDaemonProvider({ socketPath });
    const result = await provider.syncPeers({
      ...ref,
      peers: ["unix:///tmp/peer.sock"],
    });

    assert.deepEqual(params, { ...ref, peers: ["unix:///tmp/peer.sock"] });
    assert.equal(result.insertedBlocks, 3);
    assert.equal(result.peers[0].endpoint, "unix:///tmp/peer.sock");
  });
});

test("local daemon provider calls trusted peer sync over JSON-RPC", async () => {
  let params: unknown;
  await withRpcServer(async (request) => {
    if (request.method !== "peer.syncTrusted") throw new Error(`unexpected method ${request.method}`);
    params = request.params;
    return {
      ...ref,
      peers: [{ endpoint: "tcp://100.64.0.2:9987", fetched: 3, accepted: 3, inserted: 1 }],
      fetchedBlocks: 3,
      acceptedBlocks: 3,
      insertedBlocks: 1,
      rejectedBlocks: 0,
      finalTip: "blk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };
  }, async (socketPath) => {
    const provider = new LocalDaemonProvider({ socketPath });
    const result = await provider.syncTrustedPeers(ref);

    assert.deepEqual(params, ref);
    assert.equal(result.insertedBlocks, 1);
    assert.equal(result.peers[0].endpoint, "tcp://100.64.0.2:9987");
  });
});

test("local daemon provider calls inventory, retention, and blob RPC methods", async () => {
  const calls: string[] = [];
  await withRpcServer(async (request) => {
    calls.push(request.method);
    if (request.method === "lane.inventory") {
      assert.deepEqual(request.params, ref);
      return {
        ...ref,
        tip: "blk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        heads: ["blk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
        blockCount: 1,
        archivedCount: 2,
        blocks: [
          {
            sequence: 3,
            blockId: "blk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            kind: "lane_snapshot",
            parentTips: ["blk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
            payloadHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            createdAt: "2026-07-06T10:00:00.000Z",
            sizeBytes: 512,
            blobDigests: ["sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"],
          },
        ],
      };
    }
    if (request.method === "project.inventory") {
      assert.deepEqual(request.params, { projectId: ref.projectId, taskId: ref.taskId });
      return {
        projectId: ref.projectId,
        taskId: ref.taskId,
        lanes: [{ ...ref, leaseEpoch: 1, blockCount: 1, archivedCount: 2 }],
      };
    }
    if (request.method === "retention.apply") {
      assert.deepEqual(request.params, { ...ref, keepRecent: 10, requireSnapshot: true, reason: "cold lane" });
      return { ...ref, archivedBlocks: 2, activeBlocks: 1, latestSnapshot: "blk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", requireSnapshot: true };
    }
    if (request.method === "blob.get") {
      assert.deepEqual(request.params, { digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" });
      return {
        digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        sizeBytes: 5,
        contentBase64: "aGVsbG8=",
      };
    }
    throw new Error(`unexpected method ${request.method}`);
  }, async (socketPath) => {
    const provider = new LocalDaemonProvider({ socketPath });
    const lane = await provider.laneInventory(ref);
    const project = await provider.projectInventory({ projectId: ref.projectId, taskId: ref.taskId });
    const retention = await provider.applyRetention({ ...ref, keepRecent: 10, requireSnapshot: true, reason: "cold lane" });
    const blob = await provider.blob("sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd");

    assert.equal(lane.archivedCount, 2);
    assert.equal(lane.blocks[0].kind, "lane_snapshot");
    assert.equal(project.lanes[0].blockCount, 1);
    assert.equal(retention.archivedBlocks, 2);
    assert.equal(blob.contentBase64, "aGVsbG8=");
    assert.deepEqual(calls, ["lane.inventory", "project.inventory", "retention.apply", "blob.get"]);
  });
});

test("local daemon provider manages trusted peer address book over JSON-RPC", async () => {
  const calls: string[] = [];
  await withRpcServer(async (request) => {
    calls.push(request.method);
    if (request.method === "peer.trustAdd") {
      return {
        endpoint: "tcp://100.64.0.2:9987",
        nodeId: "node-trusted",
        name: "workstation",
        provider: "tailscale",
        enabled: true,
      };
    }
    if (request.method === "peer.trustList") {
      return {
        peers: [
          {
            endpoint: "tcp://100.64.0.2:9987",
            nodeId: "node-trusted",
            name: "workstation",
            provider: "tailscale",
            enabled: true,
          },
        ],
      };
    }
    if (request.method === "peer.trustRemove") {
      return { endpoint: "tcp://100.64.0.2:9987", removed: true };
    }
    throw new Error(`unexpected method ${request.method}`);
  }, async (socketPath) => {
    const provider = new LocalDaemonProvider({ socketPath });
    const peer = await provider.trustPeer({
      endpoint: "tcp://100.64.0.2:9987",
      nodeId: "node-trusted",
      name: "workstation",
      provider: "tailscale",
    });
    const listed = await provider.listTrustedPeers();
    const removed = await provider.removeTrustedPeer({ endpoint: peer.endpoint });

    assert.equal(peer.enabled, true);
    assert.equal(listed.peers[0].endpoint, peer.endpoint);
    assert.equal(removed.removed, true);
    assert.deepEqual(calls, ["peer.trustAdd", "peer.trustList", "peer.trustRemove"]);
  });
});

test("local daemon provider normalizes null lane blocks to an empty list", async () => {
  await withRpcServer(async (request) => {
    if (request.method !== "lane.blocks") throw new Error(`unexpected method ${request.method}`);
    return null;
  }, async (socketPath) => {
    const provider = new LocalDaemonProvider({ socketPath });
    assert.deepEqual(await provider.blocks(ref), []);
  });
});

test("local daemon provider calls overlay peer discovery over JSON-RPC", async () => {
  let params: unknown;
  await withRpcServer(async (request) => {
    if (request.method !== "peer.discover") throw new Error(`unexpected method ${request.method}`);
    params = request.params;
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
  }, async (socketPath) => {
    const provider = new LocalDaemonProvider({ socketPath });
    const result = await provider.discoverPeers({
      providers: ["tailscale", "zerotier"],
      port: 9987,
      trustedNames: ["workstation"],
    });

    assert.deepEqual(params, {
      providers: ["tailscale", "zerotier"],
      port: 9987,
      trustedNames: ["workstation"],
    });
    assert.equal(result.peers[0].endpoint, "tcp://100.64.0.2:9987");
    assert.equal(result.warnings?.length, 1);
  });
});

test("local daemon provider manages daemon mDNS advertiser over JSON-RPC", async () => {
  const calls: string[] = [];
  await withRpcServer(async (request) => {
    calls.push(request.method);
    if (request.method === "mdns.advertiseStart") {
      assert.deepEqual(request.params, {
        name: "a0263",
        port: 9987,
        txt: ["txtvers=1"],
        endpoint: "tcp://A0263.local:9987",
        nodeId: "A0263.local",
      });
      return {
        running: true,
        name: "a0263",
        endpoint: "tcp://A0263.local:9987",
      };
    }
    if (request.method === "mdns.advertiseStatus") {
      return {
        running: true,
        name: "a0263",
        endpoint: "tcp://A0263.local:9987",
      };
    }
    if (request.method === "mdns.advertiseStop") {
      return { stopped: true };
    }
    throw new Error(`unexpected method ${request.method}`);
  }, async (socketPath) => {
    const provider = new LocalDaemonProvider({ socketPath });
    const started = await provider.startMdnsAdvertiser({
      name: "a0263",
      port: 9987,
      txt: ["txtvers=1"],
      endpoint: "tcp://A0263.local:9987",
      nodeId: "A0263.local",
    });
    const status = await provider.mdnsAdvertiserStatus();
    const stopped = await provider.stopMdnsAdvertiser();

    assert.equal(started.running, true);
    assert.equal(status.endpoint, "tcp://A0263.local:9987");
    assert.equal(stopped.stopped, true);
    assert.deepEqual(calls, ["mdns.advertiseStart", "mdns.advertiseStatus", "mdns.advertiseStop"]);
  });
});

test("unix json-rpc client waits for a complete newline-delimited response", async () => {
  const socketPath = path.join(os.tmpdir(), `continuityd-${randomUUID()}.sock`);
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.setEncoding("utf8");
    let body = "";
    socket.on("data", (chunk) => {
      body += chunk;
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      const line = body.slice(0, newline).trim();
      const request = JSON.parse(line) as RpcRequest;
      const response = `${JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: { ok: true, provider: "continuityd", version: 1 },
      })}\n`;
      socket.write(response.slice(0, 12));
      setTimeout(() => {
        socket.write(response.slice(12));
        setTimeout(() => socket.end(), 5);
      }, 5);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  try {
    const client = new UnixJsonRpcClient({ socketPath });
    assert.deepEqual(await client.call("provider.health", {}), { ok: true, provider: "continuityd", version: 1 });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(socketPath, { force: true });
  }
});

test("default continuityd socket path follows the daemon state directory", () => {
  const previous = process.env.CONTINUITYD_SOCKET;
  delete process.env.CONTINUITYD_SOCKET;
  try {
    assert.equal(
      defaultContinuitydSocketPath("/tmp/home"),
      path.join("/tmp/home", ".local", "state", "agent-continuity", "continuityd.sock"),
    );
  } finally {
    if (previous === undefined) delete process.env.CONTINUITYD_SOCKET;
    else process.env.CONTINUITYD_SOCKET = previous;
  }
});

interface RpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: unknown;
}

async function withRpcServer(handler: (request: RpcRequest) => Promise<unknown>, run: (socketPath: string) => Promise<void>): Promise<void> {
  const socketPath = path.join(os.tmpdir(), `continuityd-${randomUUID()}.sock`);
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let body = "";
    let handled = false;
    socket.on("data", async (chunk) => {
      if (handled) return;
      body += chunk;
      const line = body.split("\n").find((entry) => entry.trim() !== "");
      if (!line) return;
      handled = true;
      const request = JSON.parse(line) as RpcRequest;
      try {
        const result = await handler(request);
        socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
      } catch (error) {
        socket.end(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32603, message: (error as Error).message },
          })}\n`,
        );
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  try {
    await run(socketPath);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(socketPath, { force: true });
  }
}
