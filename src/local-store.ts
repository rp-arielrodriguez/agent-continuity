import DatabaseConstructor from "better-sqlite3";
import type Database from "better-sqlite3";
import type { LaneRef, TaskBlock } from "./block.js";
import { applyBlockToProjection, emptyLaneProjection, laneActionForActor, validateBlockTransition, type LaneProjection, type TransitionAction } from "./contract.js";
import { BaseContinuityProvider, laneKey, type LaneStatus, type LaneStatusInput, type ProviderHealth, type ProviderSubmitResult } from "./provider.js";

const STORE_SCHEMA_VERSION = 1;

export interface SQLiteTaskStoreOptions {
  file: string;
  readonly?: boolean;
  timeoutMs?: number;
}

export interface SQLiteAppendBlockResult {
  accepted: boolean;
  inserted: boolean;
  action: TransitionAction;
  lane: LaneProjection;
  block?: TaskBlock;
  rejection?: {
    code: string;
    message: string;
  };
}

interface BlockRow {
  sequence: number;
  block_id: string;
  block_json: string;
}

interface ProjectionRow {
  project_id: string;
  task_id: string;
  lane_id: string;
  tip: string | null;
  heads_json: string | null;
  lease_epoch: number;
  owner_node_id: string | null;
  owner_actor_id: string | null;
  owner_lease_epoch: number | null;
  owner_lease_until: string | null;
  canon_markdown: string | null;
  inventory_markdown: string | null;
  checkpoint_json: string | null;
  session_envelope_json: string | null;
  run_events_json: string | null;
  updated_at: string | null;
}

export class SQLiteTaskStore {
  private readonly db: Database.Database;

  constructor(options: SQLiteTaskStoreOptions | Database.Database) {
    this.db = isDatabase(options) ? options : new DatabaseConstructor(options.file, sqliteOptions(options));

    this.configureConnection();
    if (!this.db.readonly) this.migrate();
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  hasBlock(blockId: string): boolean {
    const row = this.db.prepare<[string], { found: number }>("SELECT 1 AS found FROM task_blocks WHERE block_id = ?").get(blockId);
    return Boolean(row);
  }

  getBlock(blockId: string): TaskBlock | undefined {
    const row = this.db.prepare<[string], BlockRow>("SELECT sequence, block_id, block_json FROM task_blocks WHERE block_id = ?").get(blockId);
    return row ? rowToBlock(row) : undefined;
  }

  getBlocks(ref: LaneRef): TaskBlock[] {
    return this.db
      .prepare<[string, string, string], BlockRow>(
        `SELECT sequence, block_id, block_json
         FROM task_blocks
         WHERE project_id = ? AND task_id = ? AND lane_id = ?
         ORDER BY sequence ASC`,
      )
      .all(ref.projectId, ref.taskId, ref.laneId)
      .map(rowToBlock);
  }

  getLaneProjection(ref: LaneRef): LaneProjection | undefined {
    const row = this.db
      .prepare<[string, string, string], ProjectionRow>(
        `SELECT *
         FROM lane_projections
         WHERE project_id = ? AND task_id = ? AND lane_id = ?`,
      )
      .get(ref.projectId, ref.taskId, ref.laneId);
    return row ? rowToProjection(row) : undefined;
  }

  appendBlock(block: TaskBlock, options: { now?: string } = {}): SQLiteAppendBlockResult {
    return this.db.transaction((candidate: TaskBlock, transactionOptions: { now?: string }): SQLiteAppendBlockResult => {
      if (this.hasBlock(candidate.blockId)) {
        return {
          accepted: true,
          inserted: false,
          action: "continue",
          lane: this.getLaneProjection(candidate) ?? emptyLaneProjection(candidate),
          block: cloneBlock(candidate),
        };
      }

      const current = this.getLaneProjection(candidate);
      const validation = validateBlockTransition(candidate, {
        current,
        hasBlock: (blockId) => this.hasBlock(blockId),
        now: transactionOptions.now,
      });
      if (!validation.ok) {
        return {
          accepted: false,
          inserted: false,
          action: validation.action,
          lane: current ?? emptyLaneProjection(candidate),
          rejection: {
            code: validation.code,
            message: validation.message,
          },
        };
      }

      const lane = applyBlockToProjection(current, candidate);
      this.insertBlock(candidate);
      this.upsertProjection(lane);
      return {
        accepted: true,
        inserted: true,
        action: "continue",
        lane,
        block: cloneBlock(candidate),
      };
    })(block, options);
  }

  rebuildProjections(): number {
    return this.db.transaction((): number => {
      this.db.prepare("DELETE FROM lane_projections").run();
      const rows = this.db.prepare<[], BlockRow>("SELECT sequence, block_id, block_json FROM task_blocks ORDER BY sequence ASC").all();
      const projections = new Map<string, LaneProjection>();
      const seenBlockIds = new Set<string>();

      for (const row of rows) {
        const block = rowToBlock(row);
        const current = projections.get(laneKey(block));
        const validation = validateBlockTransition(block, {
          current,
          hasBlock: (blockId) => seenBlockIds.has(blockId),
        });
        if (!validation.ok) {
          throw new Error(`cannot replay block ${block.blockId} at sequence ${row.sequence}: ${validation.code}: ${validation.message}`);
        }

        const lane = applyBlockToProjection(current, block);
        this.upsertProjection(lane);
        projections.set(laneKey(block), lane);
        seenBlockIds.add(block.blockId);
      }

      return rows.length;
    })();
  }

  private configureConnection(): void {
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    if (!this.db.memory && !this.db.readonly) this.db.pragma("journal_mode = WAL");
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS store_meta (
        key text PRIMARY KEY,
        value text NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_blocks (
        sequence integer PRIMARY KEY AUTOINCREMENT,
        block_id text NOT NULL UNIQUE,
        version integer NOT NULL,
        project_id text NOT NULL,
        task_id text NOT NULL,
        lane_id text NOT NULL,
        kind text NOT NULL,
        parent_tips_json text NOT NULL,
        node_id text NOT NULL,
        actor_id text NOT NULL,
        lease_epoch integer NOT NULL,
        created_at text NOT NULL,
        payload_hash text NOT NULL,
        payload_json text NOT NULL,
        signature_json text NOT NULL,
        block_json text NOT NULL
      );

      CREATE INDEX IF NOT EXISTS task_blocks_lane_sequence_idx
        ON task_blocks(project_id, task_id, lane_id, sequence);

      CREATE INDEX IF NOT EXISTS task_blocks_lane_tip_idx
        ON task_blocks(project_id, task_id, lane_id, block_id);

      CREATE TABLE IF NOT EXISTS lane_projections (
        project_id text NOT NULL,
        task_id text NOT NULL,
        lane_id text NOT NULL,
        tip text,
        lease_epoch integer NOT NULL,
        owner_node_id text,
        owner_actor_id text,
        owner_lease_epoch integer,
        owner_lease_until text,
        canon_markdown text,
        inventory_markdown text,
        checkpoint_json text,
        session_envelope_json text,
        run_events_json text,
        heads_json text,
        updated_at text,
        PRIMARY KEY (project_id, task_id, lane_id)
      );
    `);
    this.ensureColumn("lane_projections", "heads_json", "text");
    this.ensureColumn("lane_projections", "session_envelope_json", "text");
    this.ensureColumn("lane_projections", "run_events_json", "text");

    this.db
      .prepare<[string]>(
        `INSERT INTO store_meta(key, value)
         VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(String(STORE_SCHEMA_VERSION));
  }

  private insertBlock(block: TaskBlock): void {
    this.db
      .prepare(
        `INSERT INTO task_blocks (
           block_id, version, project_id, task_id, lane_id, kind, parent_tips_json,
           node_id, actor_id, lease_epoch, created_at, payload_hash, payload_json,
           signature_json, block_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        block.blockId,
        block.version,
        block.projectId,
        block.taskId,
        block.laneId,
        block.kind,
        JSON.stringify(block.parentTips),
        block.nodeId,
        block.actorId,
        block.leaseEpoch,
        block.createdAt,
        block.payloadHash,
        JSON.stringify(block.payload),
        JSON.stringify(block.signature),
        JSON.stringify(block),
      );
  }

  private upsertProjection(lane: LaneProjection): void {
    this.db
      .prepare(
        `INSERT INTO lane_projections (
           project_id, task_id, lane_id, tip, lease_epoch, owner_node_id,
           owner_actor_id, owner_lease_epoch, owner_lease_until, canon_markdown,
           inventory_markdown, checkpoint_json, session_envelope_json, run_events_json,
           heads_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, task_id, lane_id) DO UPDATE SET
           tip = excluded.tip,
           heads_json = excluded.heads_json,
           lease_epoch = excluded.lease_epoch,
           owner_node_id = excluded.owner_node_id,
           owner_actor_id = excluded.owner_actor_id,
           owner_lease_epoch = excluded.owner_lease_epoch,
           owner_lease_until = excluded.owner_lease_until,
           canon_markdown = excluded.canon_markdown,
           inventory_markdown = excluded.inventory_markdown,
           checkpoint_json = excluded.checkpoint_json,
           session_envelope_json = excluded.session_envelope_json,
           run_events_json = excluded.run_events_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        lane.projectId,
        lane.taskId,
        lane.laneId,
        lane.tip ?? null,
        lane.leaseEpoch,
        lane.owner?.nodeId ?? null,
        lane.owner?.actorId ?? null,
        lane.owner?.leaseEpoch ?? null,
        lane.owner?.leaseUntil ?? null,
        lane.canonMarkdown ?? null,
        lane.inventoryMarkdown ?? null,
        lane.checkpoint ? JSON.stringify(lane.checkpoint) : null,
        lane.sessionEnvelope ? JSON.stringify(lane.sessionEnvelope) : null,
        lane.runEvents?.length ? JSON.stringify(lane.runEvents) : null,
        lane.heads?.length ? JSON.stringify(lane.heads) : null,
        lane.updatedAt ?? null,
      );
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (rows.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export class SQLiteProvider extends BaseContinuityProvider {
  constructor(private readonly store: SQLiteTaskStore) {
    super();
  }

  static open(options: SQLiteTaskStoreOptions): SQLiteProvider {
    return new SQLiteProvider(new SQLiteTaskStore(options));
  }

  close(): void {
    this.store.close();
  }

  async health(): Promise<ProviderHealth> {
    return { ok: true, provider: "sqlite", version: 1 };
  }

  async status(input: LaneStatusInput): Promise<LaneStatus> {
    const lane = this.store.getLaneProjection(input) ?? emptyLaneProjection(input);
    const action = input.actor ? laneActionForActor(lane, input.actor, input.now) : "continue";
    const reason = action === "pause" && lane.owner ? `lane is owned by ${lane.owner.nodeId}/${lane.owner.actorId}` : undefined;
    return { lane, action, reason };
  }

  async blocks(ref: LaneRef): Promise<TaskBlock[]> {
    return this.store.getBlocks(ref);
  }

  async submitBlock(block: TaskBlock, options?: { now?: string }): Promise<ProviderSubmitResult> {
    const result = this.store.appendBlock(block, options);
    return {
      accepted: result.accepted,
      action: result.action,
      lane: result.lane,
      block: result.block,
      rejection: result.rejection,
    };
  }

  rebuildProjections(): number {
    return this.store.rebuildProjections();
  }
}

function rowToBlock(row: BlockRow): TaskBlock {
  return parseJson<TaskBlock>(row.block_json, `block ${row.block_id}`);
}

function rowToProjection(row: ProjectionRow): LaneProjection {
  return {
    projectId: row.project_id,
    taskId: row.task_id,
    laneId: row.lane_id,
    tip: row.tip ?? undefined,
    heads: row.heads_json ? parseJson<string[]>(row.heads_json, `heads projection for ${row.project_id}/${row.task_id}/${row.lane_id}`) : row.tip ? [row.tip] : undefined,
    leaseEpoch: row.lease_epoch,
    owner:
      row.owner_node_id && row.owner_actor_id && row.owner_lease_epoch !== null
        ? {
            nodeId: row.owner_node_id,
            actorId: row.owner_actor_id,
            leaseEpoch: row.owner_lease_epoch,
            leaseUntil: row.owner_lease_until ?? undefined,
          }
        : undefined,
    canonMarkdown: row.canon_markdown ?? undefined,
    inventoryMarkdown: row.inventory_markdown ?? undefined,
    checkpoint: row.checkpoint_json ? parseJson<LaneProjection["checkpoint"]>(row.checkpoint_json, `checkpoint projection for ${row.project_id}/${row.task_id}/${row.lane_id}`) : undefined,
    sessionEnvelope: row.session_envelope_json ? parseJson<LaneProjection["sessionEnvelope"]>(row.session_envelope_json, `session envelope projection for ${row.project_id}/${row.task_id}/${row.lane_id}`) : undefined,
    runEvents: row.run_events_json ? parseJson<NonNullable<LaneProjection["runEvents"]>>(row.run_events_json, `run event projection for ${row.project_id}/${row.task_id}/${row.lane_id}`) : undefined,
    updatedAt: row.updated_at ?? undefined,
  };
}

function parseJson<T>(json: string, label: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    throw new Error(`invalid stored JSON for ${label}: ${(error as Error).message}`);
  }
}

function cloneBlock(block: TaskBlock): TaskBlock {
  return structuredClone(block);
}

function isDatabase(value: SQLiteTaskStoreOptions | Database.Database): value is Database.Database {
  return typeof value === "object" && value !== null && "prepare" in value && "transaction" in value;
}

function sqliteOptions(options: SQLiteTaskStoreOptions): Database.Options {
  return {
    ...(options.readonly === undefined ? {} : { readonly: options.readonly }),
    timeout: options.timeoutMs ?? 5000,
  };
}
