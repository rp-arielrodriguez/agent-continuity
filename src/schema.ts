export interface Queryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

export async function ensureContinuitySchema(db: Queryable): Promise<void> {
  await db.query(`CREATE SCHEMA IF NOT EXISTS continuity`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS continuity.journal_entries (
      task_id text NOT NULL,
      entry_timestamp timestamptz NOT NULL,
      session_id text NOT NULL,
      model_id text NOT NULL,
      status text NOT NULL,
      progress text NOT NULL,
      files text,
      blocking text,
      next text,
      source text,
      idempotency_key text NOT NULL UNIQUE,
      entry_markdown text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (task_id, entry_timestamp, session_id)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS continuity.canons (
      task_id text PRIMARY KEY,
      last_reconciled timestamptz NOT NULL,
      canon_markdown text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}
