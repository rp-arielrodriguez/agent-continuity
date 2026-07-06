import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJson, createEd25519Signer } from "../src/block.js";
import {
  createPeerInvite,
  createPeerPresence,
  defaultMdnsEndpoint,
  defaultMdnsHost,
  decodePeerInvite,
  discoverRendezvousPeers,
  encodePeerInvite,
  mdnsTxtForPresence,
  parseDnsSdBrowseOutput,
  parseDnsSdResolveTxt,
  peerTrustInputFromDiscovery,
  peerTrustInputFromInvite,
  presenceFromMdnsTxt,
  publishRendezvousPresence,
  requireTrustedFilterForAdd,
} from "../src/peer-onboarding.js";

test("peer invite encodes a signed trust payload", async () => {
  const signer = createEd25519Signer({ nodeId: "source-node", actorId: "invite-cli" });
  const invite = await createPeerInvite(
    {
      endpoint: "tcp://10.44.110.222:9987",
      provider: "zerotier",
      name: "ariel-main",
      projects: ["rp-arielrodriguez/agent-continuity"],
      createdAt: "2026-07-04T13:00:00.000Z",
      expiresAt: "2026-07-05T13:00:00.000Z",
    },
    signer,
  );

  const decoded = decodePeerInvite(encodePeerInvite(invite), new Date("2026-07-04T13:05:00.000Z"));
  const trust = peerTrustInputFromInvite(decoded);

  assert.equal(decoded.nodeId, "source-node");
  assert.equal(decoded.endpoint, "tcp://10.44.110.222:9987");
  assert.equal(trust.provider, "zerotier");
  assert.equal(trust.publicKey, signer.publicKey);
});

test("peer invite rejects tampered signed payloads", async () => {
  const signer = createEd25519Signer({ nodeId: "source-node", actorId: "invite-cli" });
  const invite = await createPeerInvite(
    {
      endpoint: "tcp://10.44.110.222:9987",
      createdAt: "2026-07-04T13:00:00.000Z",
    },
    signer,
  );
  const tampered = { ...invite, endpoint: "tcp://10.44.110.223:9987" };

  assert.throws(() => decodePeerInvite(encodePeerInvite(tampered), new Date("2026-07-04T13:05:00.000Z")), /signature does not verify/);
});

test("rendezvous presence publishes signed peers and filters by project and trusted node", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "continuity-rendezvous-"));
  const signer = createEd25519Signer({ nodeId: "source-node", actorId: "presence-cli" });
  try {
    const presence = await createPeerPresence(
      {
        endpoints: [{ endpoint: "tcp://10.44.110.222:9987", provider: "zerotier" }],
        name: "ariel-main",
        projects: ["rp-arielrodriguez/agent-continuity"],
        updatedAt: "2026-07-04T13:10:00.000Z",
      },
      signer,
    );

    const file = await publishRendezvousPresence({ rendezvous: dir, presence });
    assert.match(file, /source-node\.presence\.json$/);

    const result = await discoverRendezvousPeers({
      rendezvous: dir,
      filter: {
        projectId: "rp-arielrodriguez/agent-continuity",
        trustedNodeIds: ["source-node"],
      },
      now: new Date("2026-07-04T13:11:00.000Z"),
    });

    assert.deepEqual(result.warnings, []);
    assert.equal(result.peers.length, 1);
    assert.equal(result.peers[0].endpoint, "tcp://10.44.110.222:9987");
    assert.equal(peerTrustInputFromDiscovery(result.peers[0]).publicKey, signer.publicKey);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rendezvous discovery reports invalid signed presence files as warnings", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "continuity-rendezvous-"));
  const signer = createEd25519Signer({ nodeId: "source-node", actorId: "presence-cli" });
  try {
    const presence = await createPeerPresence(
      {
        endpoints: [{ endpoint: "tcp://10.44.110.222:9987", provider: "zerotier" }],
        updatedAt: "2026-07-04T13:10:00.000Z",
      },
      signer,
    );
    const file = await publishRendezvousPresence({ rendezvous: dir, presence });
    await writeFile(file, `${canonicalJson({ ...presence, nodeId: "tampered-node" })}\n`, "utf8");

    const result = await discoverRendezvousPeers({ rendezvous: dir });

    assert.equal(result.peers.length, 0);
    assert.match(result.warnings[0], /signature does not verify/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mDNS TXT records carry signed peer presence", async () => {
  const signer = createEd25519Signer({ nodeId: "source-node", actorId: "mdns-cli" });
  const presence = await createPeerPresence(
    {
      endpoints: [{ endpoint: "tcp://10.44.110.222:9987", provider: "mdns" }],
      name: "ariel-main",
      projects: ["rp-arielrodriguez/agent-continuity"],
      updatedAt: "2026-07-04T13:15:00.000Z",
    },
    signer,
  );

  const decoded = presenceFromMdnsTxt(mdnsTxtForPresence(presence));

  assert.equal(decoded.nodeId, "source-node");
  assert.equal(decoded.endpoints[0].endpoint, "tcp://10.44.110.222:9987");
  assert.deepEqual(decoded.projects, ["rp-arielrodriguez/agent-continuity"]);
});

test("mDNS TXT records can carry signed multi-endpoint peer presence", async () => {
  const signer = createEd25519Signer({ nodeId: "source-node", actorId: "mdns-cli" });
  const presence = await createPeerPresence(
    {
      endpoints: [
        { endpoint: "tcp://A0263.local:9987", provider: "mdns" },
        { endpoint: "tcp://10.44.110.206:9987", provider: "zerotier" },
      ],
      name: "a0263",
      updatedAt: "2026-07-04T13:16:00.000Z",
    },
    signer,
  );

  const txt = mdnsTxtForPresence(presence);
  const decoded = presenceFromMdnsTxt(txt);

  assert.equal(txt.some((entry) => entry.startsWith("endpoints=")), true);
  assert.deepEqual(decoded.endpoints, presence.endpoints);
});

test("mDNS endpoint defaults to hostname.local without a fixed IP", () => {
  assert.equal(defaultMdnsHost("A0263"), "A0263.local");
  assert.equal(defaultMdnsHost("A0263.local"), "A0263.local");
  assert.equal(defaultMdnsEndpoint(9987, "A0263"), "tcp://A0263.local:9987");
  assert.throws(() => defaultMdnsEndpoint(70000, "A0263"), /--port must be an integer/);
});

test("dns-sd output parsers extract service instances and TXT values", () => {
  const browse = `
Browsing for _continuity._tcp.local
DATE: ---Sat 04 Jul 2026---
13:15:01.000  Add        3   4 local.               _continuity._tcp.     ariel-main
`;
  const resolve = `
ariel-main._continuity._tcp.local. can be reached at A0263.local.:9987
 txtvers=1 node=source-node pub=pubkey endpoint=tcp://10.44.110.222:9987 provider=mdns updated=2026-07-04T13:15:00.000Z sig=sig name=ariel-main projects=rp-arielrodriguez/agent-continuity
`;

  assert.deepEqual(parseDnsSdBrowseOutput(browse), ["ariel-main"]);
  assert.deepEqual(parseDnsSdResolveTxt(resolve), [
    "txtvers=1",
    "node=source-node",
    "pub=pubkey",
    "endpoint=tcp://10.44.110.222:9987",
    "provider=mdns",
    "updated=2026-07-04T13:15:00.000Z",
    "sig=sig",
    "name=ariel-main",
    "projects=rp-arielrodriguez/agent-continuity",
  ]);
});

test("bulk discovery add requires an explicit trust filter", () => {
  assert.throws(() => requireTrustedFilterForAdd({}), /--add requires --trusted-names or --trusted-node-ids/);
  assert.doesNotThrow(() => requireTrustedFilterForAdd({ trustedNodeIds: ["source-node"] }));
});
