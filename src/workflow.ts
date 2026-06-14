import pg from "pg";
import { Absurd, type TaskContext } from "absurd-sdk";
import type { CheckpointInput, ContinuityConfig, ReconcileResult } from "./types.js";
import { ensureContinuitySchema } from "./schema.js";
import { lastReconciledFromCanon, parseJournalEntries } from "./markdown.js";
import { appendJournalEntry, exportTaskFiles, getCanon, getLatestJournalTimestamp, insertJournalEntries, upsertCanon, upsertCanonMarkdown } from "./store.js";

const TASK_RECONCILE = "checkpoint.reconcile";
const TASK_RECONCILE_CANON = "canon.reconcile";
const TASK_IMPORT = "checkpoint.import";

export async function runCheckpoint(input: CheckpointInput, config: ContinuityConfig): Promise<ReconcileResult> {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const app = new Absurd({ db: pool, queueName: config.queueName });

  try {
    await ensureContinuitySchema(pool);
    registerContinuityTasks(app, pool, config);
    await app.createQueue(config.queueName);

    const worker = await app.startWorker({
      workerId: `agent-continuity:${process.pid}`,
      concurrency: 1,
      claimTimeout: Math.max(config.workerTimeoutSeconds, 10),
      fatalOnLeaseTimeout: false,
    });

    try {
      const spawn = await app.spawn(TASK_RECONCILE, input, {
        queue: config.queueName,
        idempotencyKey: `checkpoint:${input.taskId}:${input.timestamp}:${input.sessionId}`,
        maxAttempts: 3,
      });
      const snapshot = await app.awaitTaskResult(spawn.taskID, {
        queue: config.queueName,
        timeout: config.workerTimeoutSeconds,
      });

      if (snapshot.state !== "completed") {
        throw new Error(`checkpoint task ${spawn.taskID} ended in state ${snapshot.state}`);
      }

      return snapshot.result as unknown as ReconcileResult;
    } finally {
      await worker.close();
    }
  } finally {
    await app.close();
  }
}

export async function readCanon(taskId: string, config: ContinuityConfig): Promise<string | null> {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  try {
    await ensureContinuitySchema(pool);
    return (await getCanon(pool, taskId))?.canonMarkdown ?? null;
  } finally {
    await pool.end();
  }
}

export async function reconcileCanon(
  taskId: string,
  canonMarkdown: string,
  config: ContinuityConfig,
  checkpointDir?: string,
): Promise<{ taskId: string; lastReconciled: string; journalPath: string; canonPath: string }> {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const app = new Absurd({ db: pool, queueName: config.queueName });

  try {
    await ensureContinuitySchema(pool);
    registerContinuityTasks(app, pool, config);
    await app.createQueue(config.queueName);

    const worker = await app.startWorker({
      workerId: `agent-continuity:${process.pid}`,
      concurrency: 1,
      claimTimeout: Math.max(config.workerTimeoutSeconds, 10),
      fatalOnLeaseTimeout: false,
    });

    try {
      const spawn = await app.spawn(
        TASK_RECONCILE_CANON,
        { taskId, canonMarkdown, checkpointDir },
        {
          queue: config.queueName,
          idempotencyKey: `canon:${taskId}:${Buffer.from(canonMarkdown).toString("base64url").slice(0, 32)}`,
          maxAttempts: 3,
        },
      );
      const snapshot = await app.awaitTaskResult(spawn.taskID, {
        queue: config.queueName,
        timeout: config.workerTimeoutSeconds,
      });

      if (snapshot.state !== "completed") {
        throw new Error(`canon reconcile task ${spawn.taskID} ended in state ${snapshot.state}`);
      }

      return snapshot.result as unknown as { taskId: string; lastReconciled: string; journalPath: string; canonPath: string };
    } finally {
      await worker.close();
    }
  } finally {
    await app.close();
  }
}

export async function importCheckpoint(
  taskId: string,
  journalMarkdown: string,
  canonMarkdown: string,
  config: ContinuityConfig,
  checkpointDir?: string,
): Promise<{ taskId: string; imported: number; lastReconciled: string; journalPath: string; canonPath: string }> {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const app = new Absurd({ db: pool, queueName: config.queueName });

  try {
    await ensureContinuitySchema(pool);
    registerContinuityTasks(app, pool, config);
    await app.createQueue(config.queueName);
    const worker = await app.startWorker({
      workerId: `agent-continuity:${process.pid}`,
      concurrency: 1,
      claimTimeout: Math.max(config.workerTimeoutSeconds, 10),
      fatalOnLeaseTimeout: false,
    });

    try {
      const spawn = await app.spawn(
        TASK_IMPORT,
        { taskId, journalMarkdown, canonMarkdown, checkpointDir },
        {
          queue: config.queueName,
          idempotencyKey: `import:${taskId}:${Buffer.from(canonMarkdown).toString("base64url").slice(0, 32)}`,
          maxAttempts: 3,
        },
      );
      const snapshot = await app.awaitTaskResult(spawn.taskID, {
        queue: config.queueName,
        timeout: config.workerTimeoutSeconds,
      });

      if (snapshot.state !== "completed") {
        throw new Error(`checkpoint import task ${spawn.taskID} ended in state ${snapshot.state}`);
      }

      return snapshot.result as unknown as { taskId: string; imported: number; lastReconciled: string; journalPath: string; canonPath: string };
    } finally {
      await worker.close();
    }
  } finally {
    await app.close();
  }
}

export async function continuityStatus(config: ContinuityConfig): Promise<{ tasks: number; journalEntries: number; canons: number }> {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  try {
    await ensureContinuitySchema(pool);
    const result = await pool.query<{ tasks: string; journal_entries: string; canons: string }>(
      `SELECT
         (SELECT count(DISTINCT task_id) FROM continuity.journal_entries)::text AS tasks,
         (SELECT count(*) FROM continuity.journal_entries)::text AS journal_entries,
         (SELECT count(*) FROM continuity.canons)::text AS canons`,
    );
    const row = result.rows[0];
    return {
      tasks: Number(row.tasks),
      journalEntries: Number(row.journal_entries),
      canons: Number(row.canons),
    };
  } finally {
    await pool.end();
  }
}

function registerContinuityTasks(app: Absurd, db: pg.Pool, config: ContinuityConfig): void {
  app.registerTask({ name: TASK_RECONCILE, queue: config.queueName }, async (params: CheckpointInput, ctx: TaskContext) => {
    const checkpointDir = params.checkpointDir ?? config.checkpointDir;
    const appended = await ctx.step("append-journal", async () => appendJournalEntry(db, params));
    await ctx.step("rewrite-canon", async () => upsertCanon(db, params));
    const paths = await ctx.step("export-markdown", async () => exportTaskFiles(db, params.taskId, checkpointDir));
    return {
      taskId: params.taskId,
      timestamp: params.timestamp,
      appended,
      journalPath: paths.journalPath,
      canonPath: paths.canonPath,
    } satisfies ReconcileResult;
  });

  app.registerTask({ name: TASK_RECONCILE_CANON, queue: config.queueName }, async (params: { taskId: string; canonMarkdown: string; checkpointDir?: string }, ctx: TaskContext) => {
    const checkpointDir = params.checkpointDir ?? config.checkpointDir;
    const lastReconciled = await ctx.step("load-latest-journal", async () => getLatestJournalTimestamp(db, params.taskId));
    if (!lastReconciled) throw new Error(`cannot reconcile canon for ${params.taskId}: no journal entries found`);
    await ctx.step("rewrite-canon", async () => upsertCanonMarkdown(db, params.taskId, lastReconciled, params.canonMarkdown));
    const paths = await ctx.step("export-markdown", async () => exportTaskFiles(db, params.taskId, checkpointDir));
    return {
      taskId: params.taskId,
      lastReconciled,
      journalPath: paths.journalPath,
      canonPath: paths.canonPath,
    };
  });

  app.registerTask({ name: TASK_IMPORT, queue: config.queueName }, async (params: { taskId: string; journalMarkdown: string; canonMarkdown: string; checkpointDir?: string }, ctx: TaskContext) => {
    const checkpointDir = params.checkpointDir ?? config.checkpointDir;
    const entries = await ctx.step("parse-journal", async () => parseJournalEntries(params.taskId, params.journalMarkdown));
    const imported = await ctx.step("import-journal", async () => insertJournalEntries(db, entries));
    const latest = await ctx.step("load-latest-journal", async () => getLatestJournalTimestamp(db, params.taskId));
    if (!latest) throw new Error(`cannot import ${params.taskId}: no journal entries found`);
    const lastReconciled = lastReconciledFromCanon(params.canonMarkdown) ?? latest;
    await ctx.step("import-canon", async () => upsertCanonMarkdown(db, params.taskId, lastReconciled, params.canonMarkdown));
    const paths = await ctx.step("export-markdown", async () => exportTaskFiles(db, params.taskId, checkpointDir));
    return {
      taskId: params.taskId,
      imported,
      lastReconciled,
      journalPath: paths.journalPath,
      canonPath: paths.canonPath,
    };
  });
}
