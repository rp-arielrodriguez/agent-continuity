import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runDaemonCheckpoint, readDaemonCanon } from "../src/daemon-workflow.js";
import { loadOrCreateNodeSigner } from "../src/signer-store.js";
import { MemoryProvider } from "../src/provider.js";

const ref = {
  projectId: "rp-arielrodriguez/agent-continuity",
  taskId: "agent-continuity-decentralized-runtime",
  laneId: "main",
};

test("daemon checkpoint initializes lane, claims ownership, and updates canon", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "continuity-daemon-workflow-"));
  const provider = new MemoryProvider();
  try {
    const result = await runDaemonCheckpoint({
      ...ref,
      provider,
      stateDir,
      timestamp: "2026-07-04T00:20:00.000Z",
      modelId: "test-model",
      sessionId: "session-1",
      status: "in_progress",
      progress: "Daemon checkpoint accepted.",
      next: "Read daemon canon.",
    });

    assert.equal(result.appended, true);
    assert.equal(result.actor.actorId, "agent-cli");
    assert.ok(result.blockId?.startsWith("blk_"));
    assert.deepEqual((await provider.blocks(ref)).map((block) => block.kind), ["bootstrap", "claim_lane", "checkpoint"]);

    const resumed = await readDaemonCanon({ ...ref, provider });
    assert.match(resumed.canonMarkdown ?? "", /Daemon checkpoint accepted\./);
    assert.match(resumed.canonMarkdown ?? "", /last-reconciled: 2026-07-04T00:20:00.000Z/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("daemon checkpoint is idempotent by task timestamp and session", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "continuity-daemon-workflow-"));
  const provider = new MemoryProvider();
  const input = {
    ...ref,
    provider,
    stateDir,
    timestamp: "2026-07-04T00:21:00.000Z",
    modelId: "test-model",
    sessionId: "session-1",
    status: "in_progress" as const,
    progress: "Idempotent daemon checkpoint.",
    next: "Retry safely.",
  };
  try {
    const first = await runDaemonCheckpoint(input);
    const second = await runDaemonCheckpoint(input);

    assert.equal(first.appended, true);
    assert.equal(second.appended, false);
    assert.equal(second.blockId, first.blockId);
    assert.equal((await provider.blocks(ref)).length, 3);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("daemon checkpoint reuses current local owner when actor is omitted", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "continuity-daemon-workflow-"));
  const provider = new MemoryProvider();
  try {
    const migratedOwner = await loadOrCreateNodeSigner({
      stateDir,
      nodeId: "macbook-ariel",
      actorId: "migration-cli",
    });
    await provider.bootstrap({
      ...ref,
      signer: migratedOwner.signer,
      createdAt: "2026-07-04T00:22:00.000Z",
      payload: { summary: "Migrated lane." },
    });
    await provider.claimLane({
      ...ref,
      signer: migratedOwner.signer,
      createdAt: "2026-07-04T00:22:01.000Z",
      reason: "migration import",
    });

    const result = await runDaemonCheckpoint({
      ...ref,
      provider,
      stateDir,
      timestamp: "2026-07-04T00:23:00.000Z",
      modelId: "test-model",
      sessionId: "session-owner",
      status: "in_progress",
      progress: "Continued as migrated owner.",
    });

    assert.equal(result.appended, true);
    assert.equal(result.actor.actorId, "migration-cli");
    assert.equal((await provider.status({ ...ref })).lane.checkpoint?.progress, "Continued as migrated owner.");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("daemon progress-only checkpoint carries the previous canon forward", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "continuity-daemon-workflow-"));
  const provider = new MemoryProvider();
  const base = { ...ref, provider, stateDir, modelId: "test-model", sessionId: "session-1", status: "in_progress" as const };
  const customCanon = `# Canon: ${ref.taskId}

last-reconciled: 2026-07-04T00:30:00.000Z

## SOURCE-OF-TRUTH
- Daemon continuity.

## CURRENT-TRUTH / INVARIANTS
- INVARIANT-X: the review gate is required.

## DECISIONS
- Current checkpoint status: in_progress.
- DECISION-Y: use the loop design.

## REJECTED (do not re-derive)
- REJECTED-Z: skipping the gate.

## NEXT-ACTION
- Old next action.
`;
  try {
    // (d) first checkpoint without canon uses the template
    await runDaemonCheckpoint({ ...base, timestamp: "2026-07-04T00:29:00.000Z", progress: "First.", next: "Second." });
    const first = (await readDaemonCanon({ ...ref, provider })).canonMarkdown ?? "";
    assert.match(first, /## CURRENT-TRUTH \/ INVARIANTS\n- First\./);
    assert.doesNotMatch(first, /LATEST-PROGRESS/);

    // (c) explicit canon still replaces
    await runDaemonCheckpoint({ ...base, timestamp: "2026-07-04T00:30:00.000Z", progress: "Explicit.", canonMarkdown: customCanon });
    const explicit = (await readDaemonCanon({ ...ref, provider })).canonMarkdown ?? "";
    assert.match(explicit, /INVARIANT-X/);
    assert.doesNotMatch(explicit, /## CURRENT-TRUTH \/ INVARIANTS\n- First\./);

    // (a)+(b) progress-only checkpoint carries forward
    await runDaemonCheckpoint({ ...base, timestamp: "2026-07-04T00:31:00.000Z", progress: "Progress only.", next: "New next." });
    const carried = (await readDaemonCanon({ ...ref, provider })).canonMarkdown ?? "";
    assert.match(carried, /INVARIANT-X: the review gate is required\./);
    assert.match(carried, /DECISION-Y: use the loop design\./);
    assert.match(carried, /REJECTED-Z: skipping the gate\./);
    assert.match(carried, /last-reconciled: 2026-07-04T00:31:00\.000Z/);
    assert.match(carried, /## LATEST-PROGRESS\n- Progress only\.\n/);
    assert.match(carried, /## NEXT-ACTION\n- New next\.\n/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("daemon carried canon comes from the snapshot that guards the write", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "continuity-daemon-workflow-"));
  const provider = new MemoryProvider();
  const base = { ...ref, provider, stateDir, modelId: "test-model", sessionId: "session-1", status: "in_progress" as const };
  try {
    await runDaemonCheckpoint({ ...base, timestamp: "2026-07-04T00:40:00.000Z", progress: "Old.", canonMarkdown: `# Canon: ${ref.taskId}\n\n## DECISIONS\n- OLD-DECISION.\n` });
    const staleStatus = await provider.status(ref);
    await runDaemonCheckpoint({ ...base, timestamp: "2026-07-04T00:41:00.000Z", progress: "Newer.", canonMarkdown: `# Canon: ${ref.taskId}\n\n## DECISIONS\n- INTERVENING-DECISION.\n` });

    // The first status read returns the snapshot from before the intervening canon update.
    let statusReads = 0;
    const racingProvider = Object.create(provider) as MemoryProvider;
    racingProvider.status = async (input) => (statusReads++ === 0 ? staleStatus : provider.status(input));
    await runDaemonCheckpoint({ ...base, provider: racingProvider, timestamp: "2026-07-04T00:42:00.000Z", progress: "Progress only." });

    const carried = (await readDaemonCanon({ ...ref, provider })).canonMarkdown ?? "";
    assert.match(carried, /INTERVENING-DECISION/);
    assert.doesNotMatch(carried, /OLD-DECISION/);
    assert.match(carried, /## LATEST-PROGRESS\n- Progress only\.\n/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

const incidentCanon = `# Canon: ${ref.taskId}

## DECISIONS
Option B (DR idleTimeout 20s) + narrowed VS retries.

## OPEN DESIGN
Liga CLI has no setter for compute.profile. Awaiting Ariel's choice.
Ariel concern: file state under concurrency.

## NEXT-ACTION
- Decide compute.profile CLI shape with Ariel.
`;

test("daemon checkpoint keeps a recorded decision and closes its open item across later checkpoints", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "continuity-daemon-workflow-"));
  const provider = new MemoryProvider();
  const base = { ...ref, provider, stateDir, modelId: "test-model", sessionId: "session-1", status: "in_progress" as const };
  try {
    await runDaemonCheckpoint({ ...base, timestamp: "2026-11-01T04:00:00.000Z", progress: "Seed.", canonMarkdown: incidentCanon });
    const open = await runDaemonCheckpoint({ ...base, timestamp: "2026-11-01T04:01:00.000Z", progress: "Ariel decided the compute CLI shape." });
    assert.equal(open.openItems.length, 2);
    assert.match(open.warnings[0] ?? "", /--decision/);

    const decided = await runDaemonCheckpoint({
      ...base,
      timestamp: "2026-11-01T04:02:00.000Z",
      progress: "Recorded the compute decision.",
      decisions: ["Compute CLI shape: persisted apply flag."],
      resolve: ["Awaiting Ariel's choice"],
    });
    assert.deepEqual(decided.openItems, [{ section: "OPEN DESIGN", text: "Ariel concern: file state under concurrency." }]);
    assert.deepEqual(decided.warnings, []);

    await runDaemonCheckpoint({ ...base, timestamp: "2026-11-01T04:03:00.000Z", progress: "Unrelated progress." });
    const canon = (await readDaemonCanon({ ...ref, provider })).canonMarkdown ?? "";
    assert.match(canon, /## DECISIONS\nOption B \(DR idleTimeout 20s\) \+ narrowed VS retries\.\n- Compute CLI shape: persisted apply flag\.\n/);
    assert.doesNotMatch(canon, /Awaiting Ariel's choice/);
    assert.match(canon, /## LATEST-PROGRESS\n- Unrelated progress\.\n/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("daemon checkpoint with an unknown --resolve writes no block, not even a bootstrap or claim", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "continuity-daemon-workflow-"));
  const provider = new MemoryProvider();
  const base = { ...ref, provider, stateDir, modelId: "test-model", sessionId: "session-1", status: "in_progress" as const };
  try {
    await assert.rejects(
      runDaemonCheckpoint({ ...base, timestamp: "2026-11-01T05:00:00.000Z", progress: "New lane.", resolve: ["anything"] }),
      /no open item matches --resolve "anything"; open items: none/,
    );
    assert.equal((await provider.blocks(ref)).length, 0);

    await runDaemonCheckpoint({ ...base, timestamp: "2026-11-01T05:01:00.000Z", progress: "Seed.", canonMarkdown: incidentCanon });
    const before = await provider.blocks(ref);
    await assert.rejects(
      runDaemonCheckpoint({ ...base, actorId: "other-actor", timestamp: "2026-11-01T05:02:00.000Z", progress: "Decided.", decisions: ["X."], resolve: ["no such item"] }),
      /no open item matches --resolve "no such item"/,
    );
    assert.equal((await provider.blocks(ref)).length, before.length);
    assert.match((await readDaemonCanon({ ...ref, provider })).canonMarkdown ?? "", /Awaiting Ariel's choice/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("daemon checkpoint retry with the same idempotency key returns the existing block after its --resolve applied", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "continuity-daemon-workflow-"));
  const provider = new MemoryProvider();
  const base = { ...ref, provider, stateDir, modelId: "test-model", sessionId: "session-1", status: "in_progress" as const };
  try {
    await runDaemonCheckpoint({ ...base, timestamp: "2026-11-01T06:00:00.000Z", progress: "Seed.", canonMarkdown: incidentCanon });
    const decided = { ...base, timestamp: "2026-11-01T06:01:00.000Z", progress: "Decided.", decisions: ["X."], resolve: ["Awaiting Ariel's choice"] };
    const first = await runDaemonCheckpoint(decided);
    const retry = await runDaemonCheckpoint(decided);
    assert.equal(retry.appended, false);
    assert.equal(retry.blockId, first.blockId);
    assert.deepEqual(retry.openItems, first.openItems);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
