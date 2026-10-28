import type { CheckpointInput, CheckpointStatus, JournalEntry } from "./types.js";

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
