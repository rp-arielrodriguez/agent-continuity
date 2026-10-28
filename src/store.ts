import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CanonRecord, CheckpointInput, JournalEntry } from "./types.js";
import { assertCanonTaskId, idempotencyKeyFor, renderCarriedCanon, renderJournal, renderJournalEntry, withLastReconciled } from "./markdown.js";
import type { Queryable } from "./schema.js";

interface JournalRow {
  task_id: string;
  entry_timestamp: Date;
  session_id: string;
  model_id: string;
  status: string;
  progress: string;
  files: string | null;
  blocking: string | null;
  next: string | null;
  source: string | null;
  idempotency_key: string;
  entry_markdown: string;
}

interface CanonRow {
  task_id: string;
  last_reconciled: Date;
  canon_markdown: string;
  updated_at: Date;
}

export async function appendJournalEntry(db: Queryable, input: CheckpointInput): Promise<boolean> {
  const entryMarkdown = renderJournalEntry(input);
  return insertJournalEntry(db, {
    ...input,
    idempotencyKey: idempotencyKeyFor(input),
    entryMarkdown,
  });
}

export async function insertJournalEntry(db: Queryable, entry: JournalEntry): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO continuity.journal_entries (
       task_id, entry_timestamp, session_id, model_id, status, progress, files,
      blocking, next, source, idempotency_key, entry_markdown
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      entry.taskId,
      entry.timestamp,
      entry.sessionId,
      entry.modelId,
      entry.status,
      entry.progress,
      entry.files ?? null,
      entry.blocking ?? null,
      entry.next ?? null,
      entry.source ?? null,
      entry.idempotencyKey,
      entry.entryMarkdown,
    ],
  );

  return result.rowCount === 1;
}

export async function insertJournalEntries(db: Queryable, entries: JournalEntry[]): Promise<number> {
  let inserted = 0;
  for (const entry of entries) {
    if (await insertJournalEntry(db, entry)) inserted += 1;
  }
  return inserted;
}

const CANON_CARRY_ATTEMPTS = 5;

export async function upsertCanon(db: Queryable, input: CheckpointInput): Promise<void> {
  if (input.canonMarkdown !== undefined) {
    await upsertCanonMarkdown(db, input.taskId, input.timestamp, input.canonMarkdown);
    return;
  }

  // Carry-forward is read-merge-write: write only if the canon is still the one that was read.
  for (let attempt = 0; attempt < CANON_CARRY_ATTEMPTS; attempt += 1) {
    const previous = (await getCanon(db, input.taskId))?.canonMarkdown;
    const canonMarkdown = normalizeCanon(input.taskId, input.timestamp, renderCarriedCanon(input, previous));
    if (await writeCanonIfUnchanged(db, input.taskId, input.timestamp, canonMarkdown, previous)) return;
  }
  throw new Error(`canon for ${input.taskId} changed during ${CANON_CARRY_ATTEMPTS} carry-forward attempts; retry the checkpoint`);
}

async function writeCanonIfUnchanged(db: Queryable, taskId: string, lastReconciled: string, canonMarkdown: string, previous: string | undefined): Promise<boolean> {
  const result = previous === undefined
    ? await db.query(
        `INSERT INTO continuity.canons (task_id, last_reconciled, canon_markdown, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (task_id) DO NOTHING`,
        [taskId, lastReconciled, canonMarkdown],
      )
    : await db.query(
        `UPDATE continuity.canons
         SET last_reconciled = $2, canon_markdown = $3, updated_at = now()
         WHERE task_id = $1 AND canon_markdown = $4`,
        [taskId, lastReconciled, canonMarkdown, previous],
      );
  return result.rowCount === 1;
}

function normalizeCanon(taskId: string, lastReconciled: string, canonMarkdown: string): string {
  assertCanonTaskId(canonMarkdown, taskId);
  return withLastReconciled(canonMarkdown, lastReconciled);
}

export async function upsertCanonMarkdown(db: Queryable, taskId: string, lastReconciled: string, canonMarkdown: string): Promise<void> {
  const normalizedCanon = normalizeCanon(taskId, lastReconciled, canonMarkdown);
  await db.query(
    `INSERT INTO continuity.canons (task_id, last_reconciled, canon_markdown, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (task_id) DO UPDATE SET
       last_reconciled = EXCLUDED.last_reconciled,
       canon_markdown = EXCLUDED.canon_markdown,
       updated_at = now()`,
    [taskId, lastReconciled, normalizedCanon],
  );
}

export async function getLatestJournalTimestamp(db: Queryable, taskId: string): Promise<string | null> {
  const result = await db.query<{ latest: Date | null }>(
    `SELECT max(entry_timestamp) AS latest
     FROM continuity.journal_entries
     WHERE task_id = $1`,
    [taskId],
  );
  return result.rows[0]?.latest?.toISOString() ?? null;
}

export async function getJournalEntries(db: Queryable, taskId: string): Promise<JournalEntry[]> {
  const result = await db.query<JournalRow>(
    `SELECT *
     FROM continuity.journal_entries
     WHERE task_id = $1
     ORDER BY entry_timestamp ASC, created_at ASC`,
    [taskId],
  );

  return result.rows.map((row) => ({
    taskId: row.task_id,
    timestamp: row.entry_timestamp.toISOString(),
    sessionId: row.session_id,
    modelId: row.model_id,
    status: row.status as JournalEntry["status"],
    progress: row.progress,
    files: row.files ?? undefined,
    blocking: row.blocking ?? undefined,
    next: row.next ?? undefined,
    source: row.source ?? undefined,
    idempotencyKey: row.idempotency_key,
    entryMarkdown: row.entry_markdown,
  }));
}

export async function getCanon(db: Queryable, taskId: string): Promise<CanonRecord | null> {
  const result = await db.query<CanonRow>(
    `SELECT task_id, last_reconciled, canon_markdown, updated_at
     FROM continuity.canons
     WHERE task_id = $1`,
    [taskId],
  );

  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    taskId: row.task_id,
    lastReconciled: row.last_reconciled.toISOString(),
    canonMarkdown: row.canon_markdown,
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function exportTaskFiles(db: Queryable, taskId: string, checkpointDir: string): Promise<{ journalPath: string; canonPath: string }> {
  const entries = await getJournalEntries(db, taskId);
  const canon = await getCanon(db, taskId);
  if (!canon) throw new Error(`canon not found for task ${taskId}`);

  await mkdir(checkpointDir, { recursive: true });
  const journalPath = path.join(checkpointDir, `${taskId}.md`);
  const canonPath = path.join(checkpointDir, `${taskId}.canon.md`);

  await atomicWrite(journalPath, renderJournal(entries));
  await atomicWrite(canonPath, canon.canonMarkdown.endsWith("\n") ? canon.canonMarkdown : `${canon.canonMarkdown}\n`);
  return { journalPath, canonPath };
}

async function atomicWrite(target: string, content: string): Promise<void> {
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, content, "utf8");
  await rename(temp, target);
}
