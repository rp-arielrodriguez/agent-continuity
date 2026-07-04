import pg from "pg";
import type { ContinuitySigner } from "./block.js";
import { ensureContinuitySchema } from "./schema.js";
import { getCanon, getJournalEntries } from "./store.js";
import type { CanonRecord, ContinuityConfig, JournalEntry } from "./types.js";
import type { ContinuityProvider, ProviderSubmitResult } from "./provider.js";

export interface MigrationLaneRef {
  projectId: string;
  taskId: string;
  laneId?: string;
}

export interface TaskHistoryMigrationInput extends MigrationLaneRef {
  provider: ContinuityProvider;
  signer: ContinuitySigner;
  entries: JournalEntry[];
  canon?: CanonRecord | null;
  importedFrom?: string;
}

export interface PostgresTaskMigrationInput extends MigrationLaneRef {
  provider: ContinuityProvider;
  signer: ContinuitySigner;
  config: ContinuityConfig;
}

export interface TaskHistoryMigrationResult extends Required<MigrationLaneRef> {
  migrated: boolean;
  reason?: string;
  journalEntries: number;
  acceptedBlocks: number;
  blockIds: string[];
  finalTip?: string;
}

export async function migratePostgresTaskToProvider(input: PostgresTaskMigrationInput): Promise<TaskHistoryMigrationResult> {
  const pool = new pg.Pool({ connectionString: input.config.databaseUrl });
  try {
    await ensureContinuitySchema(pool);
    const entries = await getJournalEntries(pool, input.taskId);
    const canon = await getCanon(pool, input.taskId);
    return migrateTaskHistoryToProvider({
      projectId: input.projectId,
      taskId: input.taskId,
      laneId: input.laneId,
      provider: input.provider,
      signer: input.signer,
      entries,
      canon,
      importedFrom: "postgres-continuity",
    });
  } finally {
    await pool.end();
  }
}

export async function migrateTaskHistoryToProvider(input: TaskHistoryMigrationInput): Promise<TaskHistoryMigrationResult> {
  const lane = {
    projectId: input.projectId,
    taskId: input.taskId,
    laneId: input.laneId ?? "main",
  };
  const existing = await input.provider.status(lane);
  if (existing.lane.tip) {
    return {
      ...lane,
      migrated: false,
      reason: `target lane already has tip ${existing.lane.tip}`,
      journalEntries: input.entries.length,
      acceptedBlocks: 0,
      blockIds: [],
      finalTip: existing.lane.tip,
    };
  }

  const sortedEntries = [...input.entries].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const blockIds: string[] = [];
  let expectedTip: string | undefined;

  const bootstrap = await submitRequired(
    await input.provider.bootstrap({
      ...lane,
      signer: input.signer,
      createdAt: sortedEntries[0]?.timestamp ?? input.canon?.updatedAt,
      payload: {
        summary: migrationSummary(input.taskId, sortedEntries.length, input.canon),
        canonMarkdown: input.canon?.canonMarkdown,
        importedFrom: input.importedFrom ?? "continuity-migration",
      },
    }),
    "bootstrap",
  );
  blockIds.push(bootstrap.block!.blockId);
  expectedTip = bootstrap.block!.blockId;

  const claim = await submitRequired(
    await input.provider.claimLane({
      ...lane,
      signer: input.signer,
      expectedTip,
      createdAt: sortedEntries[0]?.timestamp ?? input.canon?.updatedAt,
      reason: "migration import",
    }),
    "claim_lane",
  );
  blockIds.push(claim.block!.blockId);
  expectedTip = claim.block!.blockId;

  for (const entry of sortedEntries) {
    const checkpoint = await submitRequired(
      await input.provider.checkpoint({
        ...lane,
        signer: input.signer,
        expectedTip,
        createdAt: entry.timestamp,
        payload: {
          status: entry.status,
          progress: entry.progress,
          files: entry.files,
          blocking: entry.blocking,
          next: entry.next,
          modelId: entry.modelId,
          sessionId: entry.sessionId,
          source: entry.source,
          idempotencyKey: entry.idempotencyKey,
        },
      }),
      `checkpoint ${entry.timestamp}`,
    );
    blockIds.push(checkpoint.block!.blockId);
    expectedTip = checkpoint.block!.blockId;
  }

  if (input.canon?.canonMarkdown) {
    const canonUpdate = await submitRequired(
      await input.provider.updateCanon({
        ...lane,
        signer: input.signer,
        expectedTip,
        createdAt: input.canon.lastReconciled,
        payload: {
          canonMarkdown: input.canon.canonMarkdown,
          summary: "migrated current canon",
        },
      }),
      "canon_update",
    );
    blockIds.push(canonUpdate.block!.blockId);
    expectedTip = canonUpdate.block!.blockId;
  }

  return {
    ...lane,
    migrated: true,
    journalEntries: sortedEntries.length,
    acceptedBlocks: blockIds.length,
    blockIds,
    finalTip: expectedTip,
  };
}

function migrationSummary(taskId: string, entries: number, canon: CanonRecord | null | undefined): string {
  const canonPart = canon ? "with current canon" : "without canon";
  return `Migrated ${taskId} from existing continuity state: ${entries} journal entries ${canonPart}.`;
}

async function submitRequired(result: ProviderSubmitResult, label: string): Promise<ProviderSubmitResult> {
  if (!result.accepted || !result.block) {
    const reason = result.rejection ? `${result.rejection.code}: ${result.rejection.message}` : "missing accepted block";
    throw new Error(`migration ${label} was rejected: ${reason}`);
  }
  return result;
}
