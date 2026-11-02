import test from "node:test";
import assert from "node:assert/strict";
import { assertCanonTaskId, checkpointCanonReport, idempotencyKeyFor, lastReconciledFromCanon, openCanonItems, parseJournalEntries, renderCarriedCanon, renderCheckpointCanon, renderDefaultCanon, renderJournalEntry, withLastReconciled } from "../src/markdown.js";
import type { CheckpointInput } from "../src/types.js";

const input: CheckpointInput = {
  taskId: "demo-task",
  timestamp: "2026-06-14T00:00:00.000Z",
  modelId: "test-model",
  sessionId: "session-1",
  status: "completed",
  progress: "Validated durable checkpoint writes.",
  next: "Install integrations.",
};

test("renders journal entry in checkpoint format", () => {
  const entry = renderJournalEntry(input);
  assert.match(entry, /^## 2026-06-14T00:00:00\.000Z — test-model \(session session-1\)/);
  assert.match(entry, /\*\*Status\*\*: completed/);
  assert.match(entry, /\*\*Progress\*\*: Validated durable checkpoint writes\./);
});

test("uses stable idempotency key", () => {
  assert.equal(idempotencyKeyFor(input), "demo-task:2026-06-14T00:00:00.000Z:session-1");
});

test("default canon marks database as source of truth", () => {
  const canon = renderDefaultCanon(input);
  assert.match(canon, /PostgreSQL continuity tables/);
  assert.match(canon, /last-reconciled: 2026-06-14T00:00:00\.000Z/);
  assert.match(canon, /markdown is an exported projection/);
});

test("default canon marks daemon as source of truth for daemon checkpoints", () => {
  const canon = renderDefaultCanon({ ...input, source: "daemon-cli" });
  assert.match(canon, /Daemon continuity/);
  assert.match(canon, /continuity resume --daemon --project-id <PROJECT-ID> --task-id demo-task/);
});

test("default canon marks agent daemon checkpoints and bounded artifacts", () => {
  const canon = renderDefaultCanon({ ...input, source: "agent-run", files: `stdout:\n${"agent-output ".repeat(200)}` });
  assert.match(canon, /Daemon continuity/);
  assert.match(canon, /## ARTIFACTS/);
  assert.match(canon, /stdout:/);
  assert.match(canon, /\[truncated \d+ chars\]/);
});

test("normalizes canon last-reconciled header", () => {
  const canon = withLastReconciled("# Canon: demo\n\nlast-reconciled: old\n", "2026-06-14T01:00:00.000Z");
  assert.match(canon, /last-reconciled: 2026-06-14T01:00:00\.000Z/);
  assert.doesNotMatch(canon, /last-reconciled: old/);
});

test("rejects mismatched canon task id", () => {
  assert.throws(() => assertCanonTaskId("# Canon: other-task\n", "demo-task"), /canon task id mismatch/);
});

test("parses markdown journal entries for import", () => {
  const entries = parseJournalEntries("demo-task", renderJournalEntry(input));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].taskId, "demo-task");
  assert.equal(entries[0].progress, input.progress);
  assert.equal(entries[0].idempotencyKey, idempotencyKeyFor(input));
});

test("parses legacy journal headers with a title suffix", () => {
  const journal = renderJournalEntry(input).replace(
    "(session session-1)",
    "(session session-1) — STEP-1 DEPLOYED",
  );

  const entries = parseJournalEntries("demo-task", journal);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].sessionId, "session-1");
  assert.equal(entries[0].entryMarkdown, journal);
});

test("extracts canon last-reconciled header", () => {
  assert.equal(lastReconciledFromCanon("# Canon: demo\n\nlast-reconciled: 2026-06-14T00:00:00Z\n"), "2026-06-14T00:00:00Z");
});

const previousCanon = `# Canon: demo-task

last-reconciled: 2026-06-13T00:00:00.000Z

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

test("carried canon keeps invariants, decisions and rejections after a progress-only checkpoint", () => {
  const canon = renderCarriedCanon(input, previousCanon);
  assert.match(canon, /INVARIANT-X: the review gate is required\./);
  assert.match(canon, /DECISION-Y: use the loop design\./);
  assert.match(canon, /REJECTED-Z: skipping the gate\./);
  assert.match(canon, /last-reconciled: 2026-06-14T00:00:00\.000Z/);
  assert.match(canon, /- Current checkpoint status: completed\./);
  assert.doesNotMatch(canon, /## CURRENT-TRUTH \/ INVARIANTS\n- Validated/);
});

test("carried canon updates NEXT-ACTION and LATEST-PROGRESS, replacing old bodies", () => {
  const first = renderCarriedCanon(input, previousCanon);
  assert.match(first, /## LATEST-PROGRESS\n- Validated durable checkpoint writes\.\n/);
  assert.match(first, /## NEXT-ACTION\n- Install integrations\.\n/);
  assert.doesNotMatch(first, /Old next action/);
  assert.ok(first.indexOf("## LATEST-PROGRESS") < first.indexOf("## NEXT-ACTION"));

  const second = renderCarriedCanon({ ...input, progress: "Second.", next: undefined }, first);
  assert.equal(second.match(/## LATEST-PROGRESS/g)?.length, 1);
  assert.match(second, /## LATEST-PROGRESS\n- Second\.\n/);
  assert.match(second, /## NEXT-ACTION\n- Install integrations\.\n/);
  assert.match(second, /INVARIANT-X/);
});

test("carried canon falls back to the default template without a previous canon", () => {
  assert.equal(renderCarriedCanon(input, null), renderDefaultCanon(input));
  assert.equal(renderCarriedCanon(input, undefined), renderDefaultCanon(input));
});

test("carried canon ignores section headings inside fenced code blocks", () => {
  const fenced = previousCanon.replace(
    "- INVARIANT-X: the review gate is required.\n",
    "- INVARIANT-X: the review gate is required.\n\n```markdown\n## NEXT-ACTION\n- Example next action.\n\n## LATEST-PROGRESS\n- Example progress.\n- Current checkpoint status: example.\n```\n- After the example.\n",
  );
  const canon = renderCarriedCanon(input, fenced);
  assert.match(canon, /```markdown\n## NEXT-ACTION\n- Example next action\.\n\n## LATEST-PROGRESS\n- Example progress\.\n- Current checkpoint status: example\.\n```\n- After the example\./);
  assert.match(canon, /- Current checkpoint status: completed\./);
  assert.match(canon, /\n## LATEST-PROGRESS\n- Validated durable checkpoint writes\.\n\n## NEXT-ACTION\n- Install integrations\.\n$/);
  assert.doesNotMatch(canon, /Old next action/);
});

test("carried canon reads CRLF canon files without duplicating sections", () => {
  const canon = renderCarriedCanon(input, previousCanon.replace(/\n/g, "\r\n"));
  assert.doesNotMatch(canon, /\r/);
  assert.equal(canon.match(/## NEXT-ACTION/g)?.length, 1);
  assert.equal(canon.match(/## LATEST-PROGRESS/g)?.length, 1);
  assert.match(canon, /## NEXT-ACTION\n- Install integrations\.\n/);
  assert.doesNotMatch(canon, /Old next action/);
});

// Shape of the 2026-11-01 incident canon: prose lines, an OPEN section with an "Awaiting" line.
const incidentCanon = `last-reconciled: 2026-11-01T04:00:06.218Z
## SOURCE-OF-TRUTH
Review lane e2e-failure-review.

## DECISIONS
Option B (DR idleTimeout 20s) + narrowed VS retries.

## OPEN DESIGN (side topic, not started)
Liga CLI has no setter for compute.profile. Ariel rejected 'liga preview compute set stable'. Awaiting Ariel's choice.
Ariel concern: file state under concurrency (2 agents, same repo/branch).

## LATEST-PROGRESS
- NEXT-ACTION 1 DONE.

## NEXT-ACTION
- NEXT-ACTION 2: decide compute.profile CLI shape with Ariel.
`;

const decision = "compute.profile CLI shape: apply flag that persists to .liga/preview.yaml.";

test("a decision recorded with --decision survives the next progress-only checkpoint and closes its open item", () => {
  const decided = renderCheckpointCanon(
    { ...input, progress: "Ariel decided the compute CLI shape.", next: "Parent lane.", decisions: [decision], resolve: ["awaiting ariel's choice"] },
    incidentCanon,
  );
  const later = renderCheckpointCanon({ ...input, progress: "Unrelated progress.", next: undefined }, decided);

  assert.match(later, new RegExp(`## DECISIONS\\nOption B \\(DR idleTimeout 20s\\) \\+ narrowed VS retries\\.\\n- ${decision.replace(/[.()]/g, "\\$&")}\\n`));
  assert.doesNotMatch(later, /Awaiting Ariel's choice/);
  assert.match(later, /## OPEN DESIGN \(side topic, not started\)\nAriel concern: file state under concurrency/);
  assert.match(later, /## LATEST-PROGRESS\n- Unrelated progress\.\n/);
  assert.deepEqual(openCanonItems(later).map((item) => item.text), ["Ariel concern: file state under concurrency (2 agents, same repo/branch)."]);
});

test("a progress-only checkpoint reports carried open items and warns when progress reads like a decision", () => {
  const canon = renderCheckpointCanon({ ...input, progress: "Ariel decided the compute CLI shape." }, incidentCanon);
  const report = checkpointCanonReport({ ...input, progress: "Ariel decided the compute CLI shape." }, canon);

  assert.deepEqual(report.openItems.map((item) => item.section), ["OPEN DESIGN (side topic, not started)", "OPEN DESIGN (side topic, not started)"]);
  assert.match(report.openItems[0].text, /Awaiting Ariel's choice\.$/);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /--decision/);
  assert.match(report.warnings[0], /--resolve/);

  const quiet = checkpointCanonReport({ ...input, progress: "Ran the tests." }, canon);
  assert.equal(quiet.openItems.length, 2);
  assert.deepEqual(quiet.warnings, []);

  const unresolved = checkpointCanonReport({ ...input, decisions: [decision] }, canon);
  assert.match(unresolved.warnings[0], /2 open items remain/);
});

test("--decision is idempotent across checkpoints and inside one call", () => {
  const once = renderCheckpointCanon({ ...input, decisions: [decision, ` ${decision} `] }, incidentCanon);
  const twice = renderCheckpointCanon({ ...input, decisions: [`- ${decision}`] }, once);
  assert.equal(twice.split(decision).length - 1, 1);
  assert.equal(renderCheckpointCanon({ ...input, decisions: ["Option B (DR idleTimeout 20s) + narrowed VS retries."] }, incidentCanon).match(/Option B/g)?.length, 1);
});

test("--resolve that matches no open item or several open items fails without a canon", () => {
  assert.throws(
    () => renderCheckpointCanon({ ...input, decisions: [decision], resolve: ["no such item"] }, incidentCanon),
    /no open item matches --resolve "no such item"; open items: \[OPEN DESIGN \(side topic, not started\)\] Liga CLI/,
  );
  assert.throws(() => renderCheckpointCanon({ ...input, resolve: ["Ariel"] }, incidentCanon), /--resolve "Ariel" matches 2 open items/);
  assert.throws(() => renderCheckpointCanon({ ...input, resolve: ["x"] }, null), /no open item matches --resolve "x"; open items: none/);
  assert.throws(() => renderCheckpointCanon({ ...input, decisions: ["  "] }, incidentCanon), /--decision must not be empty/);
});

test("canon edits create missing sections in canonical order and drop an emptied open section", () => {
  const canon = renderCheckpointCanon(
    { ...input, open: ["Pick a name. Awaiting review."], rejected: ["Global edits."] },
    previousCanon,
  );
  assert.match(canon, /## REJECTED \(do not re-derive\)\n- REJECTED-Z: skipping the gate\.\n- Global edits\.\n\n## OPEN\n- Pick a name\. Awaiting review\.\n\n## LATEST-PROGRESS/);

  const decided = renderCheckpointCanon({ ...input, decisions: ["Name is X."], resolve: ["pick a name"] }, canon);
  assert.doesNotMatch(decided, /## OPEN\b/);
  assert.match(decided, /- DECISION-Y: use the loop design\.\n- Name is X\.\n/);

  const bare = renderCheckpointCanon({ ...input, decisions: ["First decision."] }, "# Canon: demo-task\n\n## NEXT-ACTION\n- Go.\n");
  assert.match(bare, /## DECISIONS\n- First decision\.\n\n## LATEST-PROGRESS/);
});

test("open items come from OPEN sections and awaiting lines, never from fenced, decided or rejected text", () => {
  const canon = `# Canon: demo-task

## CURRENT-TRUTH
- Awaiting SRE on the mesh fix.
\`\`\`text
## OPEN
- Fenced example. Awaiting nothing.
\`\`\`

## DECISIONS
- Stopped awaiting the old vendor.

## OPEN QUESTIONS
- None.
- Which pool?
`;
  assert.deepEqual(openCanonItems(canon), [
    { section: "CURRENT-TRUTH", text: "- Awaiting SRE on the mesh fix." },
    { section: "OPEN QUESTIONS", text: "- Which pool?" },
  ]);
});

test("canon edits also apply on top of an explicit canon, and no edits keep the PR #1 behavior", () => {
  assert.equal(renderCheckpointCanon(input, previousCanon), renderCarriedCanon(input, previousCanon));
  const explicit = renderCheckpointCanon({ ...input, canonMarkdown: previousCanon, decisions: ["Explicit plus decision."] }, "ignored");
  assert.match(explicit, /- DECISION-Y: use the loop design\.\n- Explicit plus decision\.\n/);
  assert.match(explicit, /## NEXT-ACTION\n- Old next action\.\n/);
});

test("--resolve matches the previous canon, so it can close an awaiting NEXT-ACTION line that --next replaces", () => {
  const canon = "# Canon: demo-task\n\n## NEXT-ACTION\n- Awaiting Ariel's pick of the flag name.\n";
  const decided = renderCheckpointCanon({ ...input, next: "Implement --profile.", decisions: ["Flag name is --profile."], resolve: ["awaiting ariel"] }, canon);
  assert.match(decided, /## DECISIONS\n- Flag name is --profile\.\n/);
  assert.match(decided, /## NEXT-ACTION\n- Implement --profile\.\n$/);
  assert.deepEqual(openCanonItems(decided), []);
});
