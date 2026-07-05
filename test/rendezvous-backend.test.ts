import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createEd25519Signer } from "../src/block.js";
import { createPeerPresence } from "../src/peer-onboarding.js";
import {
  discoverRendezvousPeersFromTarget,
  publishRendezvousPresenceToTarget,
} from "../src/rendezvous-backend.js";

const execFile = promisify(execFileCallback);

test("git rendezvous backend publishes and discovers signed presence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "continuity-rendezvous-git-"));
  const oldAuthor = process.env.GIT_AUTHOR_NAME;
  const oldAuthorEmail = process.env.GIT_AUTHOR_EMAIL;
  const oldCommitter = process.env.GIT_COMMITTER_NAME;
  const oldCommitterEmail = process.env.GIT_COMMITTER_EMAIL;
  process.env.GIT_AUTHOR_NAME = "Ariel Rodriguez";
  process.env.GIT_AUTHOR_EMAIL = "ariel@example.local";
  process.env.GIT_COMMITTER_NAME = "Ariel Rodriguez";
  process.env.GIT_COMMITTER_EMAIL = "ariel@example.local";
  try {
    const remote = path.join(dir, "remote.git");
    await execFile("git", ["init", "--bare", remote]);
    const presence = await samplePresence();
    const publish = await publishRendezvousPresenceToTarget({
      target: {
        backend: "git",
        repo: remote,
        branch: "continuity-rendezvous",
        dir: "rendezvous",
        worktree: path.join(dir, "publisher"),
      },
      presence,
    });

    assert.equal(publish.backend, "git");
    assert.equal(publish.committed, true);
    assert.equal(publish.pushed, true);

    const discovered = await discoverRendezvousPeersFromTarget({
      target: {
        backend: "git",
        repo: remote,
        branch: "continuity-rendezvous",
        dir: "rendezvous",
        worktree: path.join(dir, "reader"),
      },
      filter: { trustedNames: ["source-node"] },
    });

    assert.equal(discovered.backend, "git");
    assert.equal(discovered.peers.length, 1);
    assert.equal(discovered.peers[0].endpoint, "tcp://source-node.local:9987");
  } finally {
    restoreEnv("GIT_AUTHOR_NAME", oldAuthor);
    restoreEnv("GIT_AUTHOR_EMAIL", oldAuthorEmail);
    restoreEnv("GIT_COMMITTER_NAME", oldCommitter);
    restoreEnv("GIT_COMMITTER_EMAIL", oldCommitterEmail);
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTPS rendezvous backend publishes with PUT and discovers from index", async () => {
  const store = new Map<string, string>();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("connection", "close");
    if (request.method === "PUT") {
      let body = "";
      request.setEncoding("utf8");
      for await (const chunk of request) body += chunk;
      store.set(url.pathname, body);
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/rendezvous/index.json") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ files: [...store.keys()].map((entry) => path.basename(entry)) }));
      return;
    }
    if (request.method === "GET" && store.has(url.pathname)) {
      response.setHeader("content-type", "application/json");
      response.end(store.get(url.pathname));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const target = { backend: "https" as const, url: `http://127.0.0.1:${port}/rendezvous` };
    const publish = await publishRendezvousPresenceToTarget({ target, presence: await samplePresence() });
    const discovered = await discoverRendezvousPeersFromTarget({ target, filter: { trustedNames: ["source-node"] } });

    assert.equal(publish.backend, "https");
    assert.match(publish.url ?? "", /source-node\.presence\.json$/);
    assert.equal(discovered.peers.length, 1);
    assert.equal(discovered.peers[0].provider, "rendezvous");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("S3-compatible rendezvous backend uses aws cp and sync", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "continuity-rendezvous-s3-"));
  try {
    const fakeAws = path.join(dir, "fake-aws.mjs");
    const bucketRoot = path.join(dir, "bucket");
    await mkdir(bucketRoot, { recursive: true });
    await writeFile(fakeAws, fakeAwsScript(), "utf8");
    await chmod(fakeAws, 0o755);
    const target = {
      backend: "s3" as const,
      url: "s3://bucket/prefix",
      awsBin: fakeAws,
      s3EndpointUrl: "https://r2.example.local",
    };

    const publish = await publishRendezvousPresenceToTarget({ target, presence: await samplePresence() });
    const discovered = await discoverRendezvousPeersFromTarget({ target, filter: { trustedNames: ["source-node"] } });

    assert.equal(publish.backend, "s3");
    assert.match(publish.url ?? "", /^s3:\/\/bucket\/prefix\/source-node\.presence\.json$/);
    assert.equal(discovered.peers.length, 1);
    assert.equal(discovered.peers[0].endpoint, "tcp://source-node.local:9987");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function samplePresence() {
  const signer = createEd25519Signer({ nodeId: "source-node", actorId: "test" });
  return createPeerPresence(
    {
      endpoints: [{ endpoint: "tcp://source-node.local:9987" }],
      name: "source-node",
      projects: ["rp-arielrodriguez/agent-continuity"],
      updatedAt: "2026-07-05T14:30:00.000Z",
    },
    signer,
  );
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function fakeAwsScript(): string {
  return `#!/usr/bin/env node
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "bucket");
const args = process.argv.slice(2);
while (args[0]?.startsWith("--")) args.splice(0, args[0] === "--endpoint-url" || args[0] === "--profile" ? 2 : 1);
const [namespace, command, first, second] = args;
if (namespace !== "s3") throw new Error("expected s3 namespace");

function s3Path(value) {
  const url = new URL(value);
  return path.join(root, url.hostname, decodeURIComponent(url.pathname));
}

if (command === "cp") {
  const target = s3Path(second);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(first, target);
} else if (command === "sync") {
  await mkdir(second, { recursive: true });
  await cp(s3Path(first), second, { recursive: true });
} else {
  throw new Error("unsupported command " + command);
}
`;
}
