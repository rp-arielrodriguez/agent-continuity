import type { CanonReport, CheckpointInput, CheckpointStatus, JournalEntry, OpenCanonItem } from "./types.js";

export function idempotencyKeyFor(input: CheckpointInput): string {
  return `${input.taskId}:${input.timestamp}:${input.sessionId}`;
}

export function renderJournalEntry(input: CheckpointInput): string {
  const lines = [
    `## ${input.timestamp} — ${input.modelId} (session ${input.sessionId})`,
    "",
    `**Status**: ${input.status}`,
    `**Progress**: ${input.progress}`,
  ];

  if (input.files) lines.push(`**Files**: ${input.files}`);
  lines.push(`**Blocking**: ${input.blocking ?? "None"}`);
  lines.push(`**Next**: ${input.next ?? "None"}`);

  return `${lines.join("\n")}\n`;
}

export function renderJournal(entries: JournalEntry[]): string {
  return entries.map((entry) => entry.entryMarkdown.trimEnd()).join("\n\n") + "\n";
}

export function renderDefaultCanon(input: CheckpointInput): string {
  const daemonSource = isDaemonSource(input.source);
  const sourceLine = daemonSource
    ? `- Daemon continuity via \`continuity resume --daemon --project-id <PROJECT-ID> --task-id ${input.taskId}\`.`
    : `- PostgreSQL continuity tables via \`continuity resume --task-id ${input.taskId}\`.`;
  const staleFix = daemonSource
    ? `Run \`continuity checkpoint --daemon --project-id <PROJECT-ID> --task-id ${input.taskId}\` with reconciled canon before acting.`
    : `Run \`continuity reconcile --task-id ${input.taskId}\` before acting.`;
  const artifactsSection = input.files
    ? `
## ARTIFACTS
\`\`\`text
${truncateForCanon(input.files)}
\`\`\`
`
    : "";
  return `# Canon: ${input.taskId}

last-reconciled: ${input.timestamp}
<!-- STALENESS GUARD: if last-reconciled != the journal's newest entry timestamp,
     this canon is STALE. ${staleFix} -->

## SOURCE-OF-TRUTH
${sourceLine}

## CURRENT-TRUTH / INVARIANTS
- ${input.progress}

## DECISIONS
- Current checkpoint status: ${input.status}.
${artifactsSection}

## REJECTED (do not re-derive)
- Directly editing markdown checkpoint files as the authority; markdown is an exported projection.

## NEXT-ACTION
- ${input.next ?? "None"}
`;
}

/**
 * Build the canon for a checkpoint that carries no explicit canon.
 * With a previous canon, every section is preserved; only last-reconciled,
 * the status line, LATEST-PROGRESS and (when given) NEXT-ACTION change.
 */
export function renderCarriedCanon(input: CheckpointInput, previousCanon: string | null | undefined): string {
  if (!previousCanon || !previousCanon.trim()) return renderDefaultCanon(input);

  // A CRLF canon file would otherwise hide every heading behind a trailing `\r`.
  let canon = withLastReconciled(previousCanon.replace(/\r\n?/g, "\n"), input.timestamp);
  canon = setStatusLine(canon, input.status);
  canon = setSectionBody(canon, "LATEST-PROGRESS", `- ${input.progress}`, "NEXT-ACTION");
  if (input.next !== undefined) canon = setSectionBody(canon, "NEXT-ACTION", `- ${input.next}`);
  return canon;
}

/**
 * Build the canon a checkpoint writes: close the `resolve` items in the explicit or the
 * previous canon, carry it forward, then append the checkpoint's new lines. Resolving
 * before the carry lets `--resolve` close a line that `--next` replaces. Throws, before
 * anything is written, when a `resolve` entry does not match exactly one open item.
 */
export function renderCheckpointCanon(input: CheckpointInput, previousCanon: string | null | undefined): string {
  const resolve = editLines("resolve", input.resolve);
  const resolved = (canon: string) => (resolve.length > 0 ? resolveOpenItems(canon.replace(/\r\n?/g, "\n"), resolve) : canon);
  const canon = input.canonMarkdown !== undefined
    ? resolved(input.canonMarkdown)
    : renderCarriedCanon(input, resolve.length > 0 ? resolved(previousCanon ?? "") : previousCanon);
  return appendCanonLines(canon, input);
}

/**
 * Open items: the lines of `## OPEN...` sections, plus lines that say "awaiting" in any
 * section except DECISIONS, REJECTED and LATEST-PROGRESS. Fenced lines never count.
 */
export function openCanonItems(canonMarkdown: string): OpenCanonItem[] {
  return openItemLines(canonMarkdown.replace(/\r\n?/g, "\n").split("\n")).map(({ section, text }) => ({ section, text }));
}

// Surfaces open items after every checkpoint; the warnings are hints and never block a write.
export function checkpointCanonReport(input: CheckpointInput, canonMarkdown: string | null | undefined): CanonReport {
  const openItems = canonMarkdown ? openCanonItems(canonMarkdown) : [];
  const warnings: string[] = [];
  const remaining = `${plural(openItems.length, "open item")} remain${openItems.length === 1 ? "s" : ""}`;
  const decisions = input.decisions?.length ?? 0;
  if (openItems.length > 0 && decisions > 0 && !input.resolve?.length) {
    warnings.push(`recorded ${plural(decisions, "decision")} but ${remaining}; close each decided item with --resolve <text>`);
  } else if (openItems.length > 0 && decisions === 0 && DECISION_WORDS.test(input.progress)) {
    warnings.push(`progress reads like a decision but ${remaining}; record it with --decision <text> and close the item with --resolve <text>`);
  }
  return { openItems, warnings };
}

const OPEN_SECTION = /^OPEN\b/i;
const NO_OPEN_ITEMS_SECTION = /^(DECISIONS|REJECTED|LATEST-PROGRESS)\b/i;
const AWAITING = /\bawaiting\b/i;
const NONE_ITEM = /^(?:[-*]\s+)?none\.?$/i;
const DECISION_WORDS = /\b(decided|decision|chose|chosen|approved|agreed|settled)\b/i;

function appendCanonLines(canon: string, input: Pick<CheckpointInput, "decisions" | "rejected" | "open">): string {
  const decisions = editLines("decision", input.decisions);
  const rejected = editLines("rejected", input.rejected);
  const open = editLines("open", input.open);
  if (decisions.length + rejected.length + open.length === 0) return canon;

  let next = appendSectionLines(canon.replace(/\r\n?/g, "\n"), "DECISIONS", decisions, ["REJECTED", "OPEN", "LATEST-PROGRESS", "NEXT-ACTION"]);
  next = appendSectionLines(next, "REJECTED", rejected, ["OPEN", "LATEST-PROGRESS", "NEXT-ACTION"]);
  return appendSectionLines(next, "OPEN", open, ["LATEST-PROGRESS", "NEXT-ACTION"]);
}

function editLines(flag: string, values: string[] | undefined): string[] {
  return (values ?? []).map((value) => {
    const line = value.replace(/\s*\n\s*/g, " ").trim();
    if (!line) throw new Error(`--${flag} must not be empty`);
    return line;
  });
}

// Remove the open item each query matches; an OPEN section left without content goes too.
function resolveOpenItems(canon: string, queries: string[]): string {
  if (queries.length === 0) return canon;
  const lines = canon.split("\n");
  const items = openItemLines(lines);
  const drop = new Set<number>();
  for (const query of queries) {
    const needle = itemKey(query);
    const matches = items.filter((item) => itemKey(item.text).includes(needle));
    if (matches.length === 0) throw new Error(`no open item matches --resolve "${query}"; open items: ${describeItems(items)}`);
    if (matches.length > 1) throw new Error(`--resolve "${query}" matches ${matches.length} open items; use more specific text: ${describeItems(matches)}`);
    drop.add(matches[0].index);
  }
  for (const section of canonSections(lines)) {
    const body = lines.slice(section.start + 1, section.end);
    if (!OPEN_SECTION.test(section.name) || !body.every((line, k) => !line.trim() || drop.has(section.start + 1 + k))) continue;
    for (let i = section.start; i < section.end; i += 1) drop.add(i);
  }
  const result = lines.filter((_, i) => !drop.has(i)).join("\n");
  return canon.endsWith("\n") && !result.endsWith("\n") ? `${result}\n` : result;
}

// Append `- <line>` items to `## <name>`, skipping lines it already holds; create the
// section before the first existing `beforeNames` section (or at the end) when missing.
function appendSectionLines(canon: string, name: string, additions: string[], beforeNames: string[]): string {
  if (additions.length === 0) return canon;
  const lines = canon.split("\n");
  const sections = canonSections(lines);
  const section = sections.find((s) => s.name === name || s.name.startsWith(`${name} (`));
  const seen = new Set(section ? lines.slice(section.start + 1, section.end).map(itemKey) : []);
  const fresh: string[] = [];
  for (const line of additions) {
    if (seen.has(itemKey(line))) continue;
    seen.add(itemKey(line));
    fresh.push(`- ${line.replace(/^[-*]\s+/, "")}`);
  }
  if (fresh.length === 0) return canon;

  if (section) {
    let last = section.end - 1;
    while (last > section.start && !lines[last].trim()) last -= 1;
    return [...lines.slice(0, last + 1), ...fresh, ...lines.slice(last + 1)].join("\n");
  }
  const block = [`## ${name}`, ...fresh, ""];
  const before = sections.find((s) => beforeNames.some((n) => s.name === n || s.name.startsWith(`${n} `)));
  if (before) return [...lines.slice(0, before.start), ...block, ...lines.slice(before.start)].join("\n");
  return [canon.trimEnd(), "", ...block].join("\n");
}

interface CanonSection {
  name: string;
  start: number;
  end: number;
}

function canonSections(lines: string[]): CanonSection[] {
  const prose = proseLines(lines);
  const starts = lines.flatMap((line, i) => (prose[i] && line.startsWith("## ") ? [i] : []));
  return starts.map((start, n) => ({ name: lines[start].slice(3).trim(), start, end: starts[n + 1] ?? lines.length }));
}

function openItemLines(lines: string[]): Array<OpenCanonItem & { index: number }> {
  const prose = proseLines(lines);
  return canonSections(lines).flatMap((section) => {
    const open = OPEN_SECTION.test(section.name);
    if (!open && NO_OPEN_ITEMS_SECTION.test(section.name)) return [];
    const items: Array<OpenCanonItem & { index: number }> = [];
    for (let i = section.start + 1; i < section.end; i += 1) {
      const text = lines[i].trim();
      if (!prose[i] || !text || NONE_ITEM.test(text)) continue;
      if (open || AWAITING.test(text)) items.push({ index: i, section: section.name, text });
    }
    return items;
  });
}

function itemKey(line: string): string {
  return line.trim().replace(/^[-*]\s+/, "").replace(/\s+/g, " ").toLowerCase();
}

function describeItems(items: OpenCanonItem[]): string {
  if (items.length === 0) return "none";
  return items.map((item) => `[${item.section}] ${truncateLine(item.text, 80)}`).join("; ");
}

export function truncateLine(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function setStatusLine(canon: string, status: string): string {
  const lines = canon.split("\n");
  const prose = proseLines(lines);
  const index = lines.findIndex((line, i) => prose[i] && /^- Current checkpoint status: .*\.$/.test(line));
  if (index >= 0) lines[index] = `- Current checkpoint status: ${status}.`;
  return lines.join("\n");
}

// Replace the body of `## <name>` (or the heading line starting with it); create it
// before `beforeName` (or at the end) when missing.
function setSectionBody(canon: string, name: string, body: string, beforeName?: string): string {
  const lines = canon.split("\n");
  const prose = proseLines(lines);
  const isSection = (i: number) => prose[i] && lines[i].startsWith("## ");
  const isHeading = (i: number, n: string) => isSection(i) && (lines[i].trimEnd() === `## ${n}` || lines[i].startsWith(`## ${n} `));
  const start = lines.findIndex((_, i) => isHeading(i, name));
  if (start >= 0) {
    let end = lines.findIndex((_, i) => i > start && isSection(i));
    if (end < 0) end = lines.length;
    return [...lines.slice(0, start + 1), body, "", ...lines.slice(end)].join("\n");
  }
  const section = [`## ${name}`, body, ""];
  const before = beforeName ? lines.findIndex((_, i) => isHeading(i, beforeName)) : -1;
  if (before >= 0) return [...lines.slice(0, before), ...section, ...lines.slice(before)].join("\n");
  return [canon.trimEnd(), "", ...section].join("\n");
}

// Marks the lines outside fenced code blocks, so a fenced example never counts as canon structure.
function proseLines(lines: string[]): boolean[] {
  let fence: string | undefined;
  return lines.map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (!fence) {
      if (marker) fence = marker;
      return !marker;
    }
    if (marker?.[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
    return false;
  });
}

function isDaemonSource(source: string | undefined): boolean {
  return Boolean(source?.startsWith("daemon") || source?.startsWith("agent-") || source === "scheduler-worker");
}

function truncateForCanon(value: string, limit = 1200): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}

export function withLastReconciled(canonMarkdown: string, timestamp: string): string {
  if (/^last-reconciled:\s*.*$/m.test(canonMarkdown)) {
    return canonMarkdown.replace(/^last-reconciled:\s*.*$/m, `last-reconciled: ${timestamp}`);
  }

  const lines = canonMarkdown.split("\n");
  if (lines[0]?.startsWith("# Canon:")) {
    return [lines[0], "", `last-reconciled: ${timestamp}`, ...lines.slice(1)].join("\n");
  }

  return `last-reconciled: ${timestamp}\n${canonMarkdown}`;
}

export function assertCanonTaskId(canonMarkdown: string, taskId: string): void {
  const match = canonMarkdown.match(/^# Canon:\s*(\S+)\s*$/m);
  if (match && match[1] !== taskId) {
    throw new Error(`canon task id mismatch: expected ${taskId}, found ${match[1]}`);
  }
}

export function lastReconciledFromCanon(canonMarkdown: string): string | null {
  return canonMarkdown.match(/^last-reconciled:\s*(\S+)\s*$/m)?.[1] ?? null;
}

export function parseJournalEntries(taskId: string, journalMarkdown: string): JournalEntry[] {
  const blocks = journalMarkdown
    .split(/\n(?=## \d{4}-\d{2}-\d{2}T)/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.map((block) => parseJournalBlock(taskId, block));
}

function parseJournalBlock(taskId: string, block: string): JournalEntry {
  const header = block.match(/^##\s+(\S+)\s+—\s+(.+?)\s+\(session\s+(.+?)\)(?:\s+—.*)?\s*$/m);
  if (!header) throw new Error(`invalid journal entry header for ${taskId}`);

  const input: CheckpointInput = {
    taskId,
    timestamp: header[1],
    modelId: header[2],
    sessionId: header[3],
    status: field(block, "Status") as CheckpointStatus,
    progress: field(block, "Progress"),
    files: optionalField(block, "Files"),
    blocking: optionalField(block, "Blocking"),
    next: optionalField(block, "Next"),
    source: "import",
  };

  return {
    ...input,
    idempotencyKey: idempotencyKeyFor(input),
    entryMarkdown: `${block}\n`,
  };
}

function field(block: string, name: string): string {
  const value = optionalField(block, name);
  if (!value) throw new Error(`missing **${name}** field in journal entry`);
  return value;
}

function optionalField(block: string, name: string): string | undefined {
  return block.match(new RegExp(`^\\*\\*${name}\\*\\*:\\s*(.*)$`, "m"))?.[1];
}
