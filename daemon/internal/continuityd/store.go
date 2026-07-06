package continuityd

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

type SQLiteStore struct {
	db *sql.DB
}

func OpenSQLiteStore(ctx context.Context, path string) (*SQLiteStore, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite store: %w", err)
	}
	store := &SQLiteStore{db: db}
	if err := store.configure(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := store.Migrate(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *SQLiteStore) Close() error {
	return s.db.Close()
}

func (s *SQLiteStore) configure(ctx context.Context) error {
	for _, statement := range []string{
		`PRAGMA foreign_keys = ON`,
		`PRAGMA busy_timeout = 5000`,
		`PRAGMA journal_mode = WAL`,
	} {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("configure sqlite store: %w", err)
		}
	}
	return nil
}

func (s *SQLiteStore) Migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
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
        block_json text NOT NULL,
        archived_at text,
        archive_reason text
      );

      CREATE INDEX IF NOT EXISTS task_blocks_lane_sequence_idx
        ON task_blocks(project_id, task_id, lane_id, sequence);

      CREATE INDEX IF NOT EXISTS task_blocks_lane_tip_idx
        ON task_blocks(project_id, task_id, lane_id, block_id);

      CREATE INDEX IF NOT EXISTS task_blocks_lane_active_sequence_idx
        ON task_blocks(project_id, task_id, lane_id, archived_at, sequence);

      CREATE TABLE IF NOT EXISTS blob_objects (
        digest text PRIMARY KEY,
        size_bytes integer NOT NULL,
        content blob NOT NULL,
        created_at text NOT NULL,
        last_accessed_at text
      );

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
        heads_json text,
        updated_at text,
	        PRIMARY KEY (project_id, task_id, lane_id)
	      );

	      CREATE TABLE IF NOT EXISTS trusted_peers (
	        endpoint text PRIMARY KEY,
	        node_id text,
	        name text,
	        public_key text,
	        provider text,
	        enabled integer NOT NULL DEFAULT 1,
	        created_at text NOT NULL,
	        updated_at text NOT NULL,
	        last_seen_at text
	      );

	      CREATE INDEX IF NOT EXISTS trusted_peers_enabled_idx
	        ON trusted_peers(enabled, endpoint);

	      INSERT INTO store_meta(key, value)
	      VALUES ('schema_version', '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    `)
	if err != nil {
		return fmt.Errorf("migrate sqlite store: %w", err)
	}
	if err := ensureColumn(ctx, s.db, "lane_projections", "heads_json", "text"); err != nil {
		return err
	}
	if err := ensureColumn(ctx, s.db, "task_blocks", "archived_at", "text"); err != nil {
		return err
	}
	if err := ensureColumn(ctx, s.db, "task_blocks", "archive_reason", "text"); err != nil {
		return err
	}
	return nil
}

func (s *SQLiteStore) UpsertTrustedPeer(ctx context.Context, peer TrustedPeer, now string) (TrustedPeer, error) {
	if peer.Endpoint == "" {
		return TrustedPeer{}, fmt.Errorf("trusted peer endpoint is required")
	}
	timestamp := timestampOrNow(now)
	_, err := s.db.ExecContext(ctx, `
      INSERT INTO trusted_peers (
        endpoint, node_id, name, public_key, provider, enabled,
        created_at, updated_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET
        node_id = excluded.node_id,
        name = excluded.name,
        public_key = excluded.public_key,
        provider = excluded.provider,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at`,
		peer.Endpoint,
		nullIfEmpty(peer.NodeID),
		nullIfEmpty(peer.Name),
		nullIfEmpty(peer.PublicKey),
		nullIfEmpty(peer.Provider),
		boolInt(peer.Enabled),
		timestamp,
		timestamp,
		nullIfEmpty(peer.LastSeenAt),
	)
	if err != nil {
		return TrustedPeer{}, fmt.Errorf("upsert trusted peer %s: %w", peer.Endpoint, err)
	}
	saved, found, err := s.TrustedPeer(ctx, peer.Endpoint)
	if err != nil {
		return TrustedPeer{}, err
	}
	if !found {
		return TrustedPeer{}, fmt.Errorf("trusted peer %s was not saved", peer.Endpoint)
	}
	return saved, nil
}

func (s *SQLiteStore) TrustedPeer(ctx context.Context, endpoint string) (TrustedPeer, bool, error) {
	var row trustedPeerRow
	err := s.db.QueryRowContext(ctx, `
      SELECT endpoint, node_id, name, public_key, provider, enabled,
             created_at, updated_at, last_seen_at
      FROM trusted_peers
      WHERE endpoint = ?`, endpoint).Scan(
		&row.Endpoint,
		&row.NodeID,
		&row.Name,
		&row.PublicKey,
		&row.Provider,
		&row.Enabled,
		&row.CreatedAt,
		&row.UpdatedAt,
		&row.LastSeenAt,
	)
	if err == sql.ErrNoRows {
		return TrustedPeer{}, false, nil
	}
	if err != nil {
		return TrustedPeer{}, false, fmt.Errorf("load trusted peer %s: %w", endpoint, err)
	}
	return row.toPeer(), true, nil
}

func (s *SQLiteStore) TrustedPeers(ctx context.Context, enabledOnly bool) ([]TrustedPeer, error) {
	query := `
      SELECT endpoint, node_id, name, public_key, provider, enabled,
             created_at, updated_at, last_seen_at
      FROM trusted_peers`
	if enabledOnly {
		query += ` WHERE enabled = 1`
	}
	query += ` ORDER BY endpoint ASC`

	rows, err := s.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("query trusted peers: %w", err)
	}
	defer rows.Close()

	peers := make([]TrustedPeer, 0)
	for rows.Next() {
		var row trustedPeerRow
		if err := rows.Scan(
			&row.Endpoint,
			&row.NodeID,
			&row.Name,
			&row.PublicKey,
			&row.Provider,
			&row.Enabled,
			&row.CreatedAt,
			&row.UpdatedAt,
			&row.LastSeenAt,
		); err != nil {
			return nil, fmt.Errorf("scan trusted peer: %w", err)
		}
		peers = append(peers, row.toPeer())
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate trusted peers: %w", err)
	}
	return peers, nil
}

func (s *SQLiteStore) RemoveTrustedPeer(ctx context.Context, endpoint string) (bool, error) {
	if endpoint == "" {
		return false, fmt.Errorf("trusted peer endpoint is required")
	}
	result, err := s.db.ExecContext(ctx, `DELETE FROM trusted_peers WHERE endpoint = ?`, endpoint)
	if err != nil {
		return false, fmt.Errorf("remove trusted peer %s: %w", endpoint, err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("read trusted peer remove result: %w", err)
	}
	return affected > 0, nil
}

func (s *SQLiteStore) TouchTrustedPeer(ctx context.Context, endpoint string, now string) error {
	if endpoint == "" {
		return nil
	}
	timestamp := timestampOrNow(now)
	_, err := s.db.ExecContext(ctx, `
      UPDATE trusted_peers
      SET last_seen_at = ?, updated_at = ?
      WHERE endpoint = ?`, timestamp, timestamp, endpoint)
	if err != nil {
		return fmt.Errorf("touch trusted peer %s: %w", endpoint, err)
	}
	return nil
}

func (s *SQLiteStore) HasBlock(ctx context.Context, blockID string) (bool, error) {
	return hasBlock(ctx, s.db, blockID)
}

func (s *SQLiteStore) LaneProjection(ctx context.Context, ref LaneRef) (LaneProjection, bool, error) {
	return laneProjection(ctx, s.db, ref)
}

func (s *SQLiteStore) Blocks(ctx context.Context, ref LaneRef) ([]TaskBlock, error) {
	rows, err := s.db.QueryContext(ctx, `
      SELECT block_json
      FROM task_blocks
      WHERE project_id = ? AND task_id = ? AND lane_id = ?
        AND archived_at IS NULL
      ORDER BY sequence ASC`, ref.ProjectID, ref.TaskID, ref.LaneID)
	if err != nil {
		return nil, fmt.Errorf("query lane blocks: %w", err)
	}
	defer rows.Close()

	blocks := make([]TaskBlock, 0)
	for rows.Next() {
		var blockJSON string
		if err := rows.Scan(&blockJSON); err != nil {
			return nil, fmt.Errorf("scan lane block: %w", err)
		}
		block, err := decodeStoredBlock(ctx, s.db, blockJSON)
		if err != nil {
			return nil, err
		}
		blocks = append(blocks, block)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate lane blocks: %w", err)
	}
	return blocks, nil
}

func (s *SQLiteStore) BlocksByID(ctx context.Context, ref LaneRef, blockIDs []string) ([]TaskBlock, error) {
	if len(blockIDs) == 0 {
		return []TaskBlock{}, nil
	}
	blocks := make([]TaskBlock, 0, len(blockIDs))
	for _, blockID := range blockIDs {
		var blockJSON string
		err := s.db.QueryRowContext(ctx, `
	      SELECT block_json
	      FROM task_blocks
	      WHERE project_id = ? AND task_id = ? AND lane_id = ? AND block_id = ?
	        AND archived_at IS NULL`, ref.ProjectID, ref.TaskID, ref.LaneID, blockID).Scan(&blockJSON)
		if err == sql.ErrNoRows {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("query block %s: %w", blockID, err)
		}
		block, err := decodeStoredBlock(ctx, s.db, blockJSON)
		if err != nil {
			return nil, err
		}
		blocks = append(blocks, block)
	}
	return blocks, nil
}

func (s *SQLiteStore) LaneInventory(ctx context.Context, ref LaneRef) (LaneInventory, error) {
	lane, found, err := s.LaneProjection(ctx, ref)
	if err != nil {
		return LaneInventory{}, err
	}
	if !found {
		lane = EmptyLaneProjection(ref)
	}
	rows, err := s.db.QueryContext(ctx, `
      SELECT sequence, block_id, kind, parent_tips_json, payload_hash, created_at,
             length(block_json), block_json
      FROM task_blocks
      WHERE project_id = ? AND task_id = ? AND lane_id = ?
        AND archived_at IS NULL
      ORDER BY sequence ASC`, ref.ProjectID, ref.TaskID, ref.LaneID)
	if err != nil {
		return LaneInventory{}, fmt.Errorf("query lane inventory: %w", err)
	}
	defer rows.Close()

	blocks := []BlockInventoryEntry{}
	for rows.Next() {
		var entry BlockInventoryEntry
		var parentTipsJSON string
		var blockJSON string
		if err := rows.Scan(&entry.Sequence, &entry.BlockID, &entry.Kind, &parentTipsJSON, &entry.PayloadHash, &entry.CreatedAt, &entry.SizeBytes, &blockJSON); err != nil {
			return LaneInventory{}, fmt.Errorf("scan lane inventory: %w", err)
		}
		_ = json.Unmarshal([]byte(parentTipsJSON), &entry.ParentTips)
		entry.BlobDigests = storedBlockBlobDigests(blockJSON)
		blocks = append(blocks, entry)
	}
	if err := rows.Err(); err != nil {
		return LaneInventory{}, fmt.Errorf("iterate lane inventory: %w", err)
	}
	archived, err := s.archivedCount(ctx, ref)
	if err != nil {
		return LaneInventory{}, err
	}
	return LaneInventory{
		ProjectID:     ref.ProjectID,
		TaskID:        ref.TaskID,
		LaneID:        ref.LaneID,
		Tip:           lane.Tip,
		Heads:         lane.Heads,
		BlockCount:    len(blocks),
		ArchivedCount: archived,
		Blocks:        blocks,
	}, nil
}

func (s *SQLiteStore) ProjectInventory(ctx context.Context, input ProjectLaneInventoryInput) (ProjectLaneInventory, error) {
	if input.ProjectID == "" {
		return ProjectLaneInventory{}, fmt.Errorf("projectId is required")
	}
	query := `
      SELECT p.project_id, p.task_id, p.lane_id, p.tip, p.heads_json, p.lease_epoch,
             p.updated_at,
             COALESCE(SUM(CASE WHEN b.archived_at IS NULL THEN 1 ELSE 0 END), 0) AS active_count,
             COALESCE(SUM(CASE WHEN b.archived_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS archived_count
      FROM lane_projections p
      LEFT JOIN task_blocks b
        ON b.project_id = p.project_id AND b.task_id = p.task_id AND b.lane_id = p.lane_id
      WHERE p.project_id = ?`
	args := []any{input.ProjectID}
	if input.TaskID != "" {
		query += ` AND p.task_id = ?`
		args = append(args, input.TaskID)
	}
	if input.LaneID != "" {
		query += ` AND p.lane_id = ?`
		args = append(args, input.LaneID)
	}
	query += `
      GROUP BY p.project_id, p.task_id, p.lane_id, p.tip, p.heads_json, p.lease_epoch, p.updated_at
      ORDER BY p.project_id, p.task_id, p.lane_id`

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return ProjectLaneInventory{}, fmt.Errorf("query project inventory: %w", err)
	}
	defer rows.Close()
	lanes := []ProjectLaneInventoryEntry{}
	for rows.Next() {
		var row struct {
			projectID string
			taskID    string
			laneID    string
			tip       sql.NullString
			headsJSON sql.NullString
			epoch     int64
			updatedAt sql.NullString
			active    int
			archived  int
		}
		if err := rows.Scan(&row.projectID, &row.taskID, &row.laneID, &row.tip, &row.headsJSON, &row.epoch, &row.updatedAt, &row.active, &row.archived); err != nil {
			return ProjectLaneInventory{}, fmt.Errorf("scan project inventory: %w", err)
		}
		lanes = append(lanes, ProjectLaneInventoryEntry{
			ProjectID:     row.projectID,
			TaskID:        row.taskID,
			LaneID:        row.laneID,
			Tip:           nullStringValue(row.tip),
			Heads:         projectionHeads(row.headsJSON, row.tip),
			LeaseEpoch:    row.epoch,
			BlockCount:    row.active,
			ArchivedCount: row.archived,
			UpdatedAt:     nullStringValue(row.updatedAt),
		})
	}
	if err := rows.Err(); err != nil {
		return ProjectLaneInventory{}, fmt.Errorf("iterate project inventory: %w", err)
	}
	return ProjectLaneInventory{ProjectID: input.ProjectID, TaskID: input.TaskID, LaneID: input.LaneID, Lanes: lanes}, nil
}

func (s *SQLiteStore) ApplyRetention(ctx context.Context, input RetentionApplyInput) (RetentionApplyResult, error) {
	ref := LaneRef{ProjectID: input.ProjectID, TaskID: input.TaskID, LaneID: input.LaneID}
	if input.ProjectID == "" || input.TaskID == "" || input.LaneID == "" {
		return RetentionApplyResult{}, fmt.Errorf("projectId, taskId, and laneId are required")
	}
	keepRecent := input.KeepRecent
	if keepRecent <= 0 {
		keepRecent = 1
	}
	requireSnapshot := !input.AllowWithoutSnapshot
	timestamp := timestampOrNow(input.Now)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RetentionApplyResult{}, fmt.Errorf("begin retention: %w", err)
	}
	defer tx.Rollback()

	rows, err := tx.QueryContext(ctx, `
      SELECT sequence, block_id, kind
      FROM task_blocks
      WHERE project_id = ? AND task_id = ? AND lane_id = ?
        AND archived_at IS NULL
      ORDER BY sequence ASC`, ref.ProjectID, ref.TaskID, ref.LaneID)
	if err != nil {
		return RetentionApplyResult{}, fmt.Errorf("query retention lane: %w", err)
	}
	type activeBlock struct {
		sequence int64
		blockID  string
		kind     string
	}
	active := []activeBlock{}
	for rows.Next() {
		var block activeBlock
		if err := rows.Scan(&block.sequence, &block.blockID, &block.kind); err != nil {
			rows.Close()
			return RetentionApplyResult{}, fmt.Errorf("scan retention lane: %w", err)
		}
		active = append(active, block)
	}
	if err := rows.Close(); err != nil {
		return RetentionApplyResult{}, fmt.Errorf("close retention rows: %w", err)
	}
	if len(active) == 0 {
		return RetentionApplyResult{ProjectID: ref.ProjectID, TaskID: ref.TaskID, LaneID: ref.LaneID, ActiveBlocks: 0, RequireSnapshot: requireSnapshot}, nil
	}
	latestSnapshot := ""
	latestSnapshotIndex := -1
	for i := len(active) - 1; i >= 0; i-- {
		if active[i].kind == "lane_snapshot" {
			latestSnapshot = active[i].blockID
			latestSnapshotIndex = i
			break
		}
	}
	if requireSnapshot && latestSnapshot == "" {
		return RetentionApplyResult{}, fmt.Errorf("retention requires an active lane_snapshot; pass allowWithoutSnapshot only for non-compacting archival")
	}

	protect := map[string]bool{}
	start := len(active) - keepRecent
	if start < 0 {
		start = 0
	}
	for _, block := range active[start:] {
		protect[block.blockID] = true
	}
	if latestSnapshotIndex >= 0 {
		for _, block := range active[latestSnapshotIndex:] {
			protect[block.blockID] = true
		}
	}
	archived := 0
	for _, block := range active {
		if protect[block.blockID] {
			continue
		}
		result, err := tx.ExecContext(ctx, `
          UPDATE task_blocks
          SET archived_at = ?, archive_reason = ?
          WHERE block_id = ? AND archived_at IS NULL`, timestamp, nullIfEmpty(input.Reason), block.blockID)
		if err != nil {
			return RetentionApplyResult{}, fmt.Errorf("archive block %s: %w", block.blockID, err)
		}
		count, _ := result.RowsAffected()
		archived += int(count)
	}
	if err := tx.Commit(); err != nil {
		return RetentionApplyResult{}, fmt.Errorf("commit retention: %w", err)
	}
	activeCount := len(active) - archived
	return RetentionApplyResult{
		ProjectID:       ref.ProjectID,
		TaskID:          ref.TaskID,
		LaneID:          ref.LaneID,
		ArchivedBlocks:  archived,
		ActiveBlocks:    activeCount,
		ArchivedAt:      timestamp,
		LatestSnapshot:  latestSnapshot,
		RequireSnapshot: requireSnapshot,
	}, nil
}

func (s *SQLiteStore) AppendBlock(ctx context.Context, block TaskBlock, now string) (AppendBlockResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return AppendBlockResult{}, fmt.Errorf("begin append block: %w", err)
	}
	defer tx.Rollback()

	exists, err := hasBlock(ctx, tx, block.BlockID)
	if err != nil {
		return AppendBlockResult{}, err
	}
	if exists {
		lane, found, err := laneProjection(ctx, tx, block.LaneRef())
		if err != nil {
			return AppendBlockResult{}, err
		}
		if !found {
			lane = EmptyLaneProjection(block.LaneRef())
		}
		return AppendBlockResult{Accepted: true, Inserted: false, Action: ActionContinue, Lane: lane, Block: &block}, nil
	}

	current, found, err := laneProjection(ctx, tx, block.LaneRef())
	if err != nil {
		return AppendBlockResult{}, err
	}
	var currentPtr *LaneProjection
	if found {
		currentPtr = &current
	}
	validation := ValidateBlockTransition(block, TransitionContext{
		Current: currentPtr,
		HasBlock: func(blockID string) bool {
			ok, err := hasBlock(ctx, tx, blockID)
			return err == nil && ok
		},
		Now: now,
	})
	if !validation.OK {
		lane := EmptyLaneProjection(block.LaneRef())
		if found {
			lane = current
		}
		return AppendBlockResult{
			Accepted:  false,
			Inserted:  false,
			Action:    validation.Action,
			Lane:      lane,
			Rejection: validation.Rejection,
		}, nil
	}

	lane := ApplyBlockToProjection(currentPtr, block)
	if err := insertBlock(ctx, tx, block, now); err != nil {
		return AppendBlockResult{}, err
	}
	if err := upsertProjection(ctx, tx, lane); err != nil {
		return AppendBlockResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return AppendBlockResult{}, fmt.Errorf("commit append block: %w", err)
	}
	return AppendBlockResult{Accepted: true, Inserted: true, Action: ActionContinue, Lane: lane, Block: &block}, nil
}

func (s *SQLiteStore) RebuildProjections(ctx context.Context) (int, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin projection rebuild: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `DELETE FROM lane_projections`); err != nil {
		return 0, fmt.Errorf("clear projections: %w", err)
	}
	rows, err := tx.QueryContext(ctx, `SELECT sequence, block_json FROM task_blocks WHERE archived_at IS NULL ORDER BY sequence ASC`)
	if err != nil {
		return 0, fmt.Errorf("query blocks for projection rebuild: %w", err)
	}
	defer rows.Close()

	projections := map[string]LaneProjection{}
	seen := map[string]bool{}
	count := 0
	for rows.Next() {
		var sequence int64
		var blockJSON string
		if err := rows.Scan(&sequence, &blockJSON); err != nil {
			return 0, fmt.Errorf("scan block for projection rebuild: %w", err)
		}
		block, err := decodeStoredBlock(ctx, tx, blockJSON)
		if err != nil {
			return 0, err
		}
		key := laneKey(block.LaneRef())
		current, ok := projections[key]
		var currentPtr *LaneProjection
		if ok {
			currentPtr = &current
		}
		validation := ValidateBlockTransition(block, TransitionContext{
			Current: currentPtr,
			HasBlock: func(blockID string) bool {
				return seen[blockID]
			},
		})
		if !validation.OK {
			return 0, fmt.Errorf("cannot replay block %s at sequence %d: %s: %s", block.BlockID, sequence, validation.Rejection.Code, validation.Rejection.Message)
		}
		lane := ApplyBlockToProjection(currentPtr, block)
		if err := upsertProjection(ctx, tx, lane); err != nil {
			return 0, err
		}
		projections[key] = lane
		seen[block.BlockID] = true
		count++
	}
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("iterate blocks for projection rebuild: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit projection rebuild: %w", err)
	}
	return count, nil
}

type queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type execer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func hasBlock(ctx context.Context, db queryer, blockID string) (bool, error) {
	var found int
	err := db.QueryRowContext(ctx, `SELECT 1 FROM task_blocks WHERE block_id = ?`, blockID).Scan(&found)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("lookup block %s: %w", blockID, err)
	}
	return true, nil
}

func (s *SQLiteStore) archivedCount(ctx context.Context, ref LaneRef) (int, error) {
	var count int
	err := s.db.QueryRowContext(ctx, `
      SELECT COUNT(*)
      FROM task_blocks
      WHERE project_id = ? AND task_id = ? AND lane_id = ?
        AND archived_at IS NOT NULL`, ref.ProjectID, ref.TaskID, ref.LaneID).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count archived blocks: %w", err)
	}
	return count, nil
}

func laneProjection(ctx context.Context, db queryer, ref LaneRef) (LaneProjection, bool, error) {
	var row projectionRow
	err := db.QueryRowContext(ctx, `
      SELECT project_id, task_id, lane_id, tip, heads_json, lease_epoch, owner_node_id,
             owner_actor_id, owner_lease_epoch, owner_lease_until, canon_markdown,
             inventory_markdown, checkpoint_json, updated_at
      FROM lane_projections
      WHERE project_id = ? AND task_id = ? AND lane_id = ?`, ref.ProjectID, ref.TaskID, ref.LaneID).Scan(
		&row.ProjectID,
		&row.TaskID,
		&row.LaneID,
		&row.Tip,
		&row.HeadsJSON,
		&row.LeaseEpoch,
		&row.OwnerNodeID,
		&row.OwnerActorID,
		&row.OwnerLeaseEpoch,
		&row.OwnerLeaseUntil,
		&row.CanonMarkdown,
		&row.InventoryMarkdown,
		&row.CheckpointJSON,
		&row.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return LaneProjection{}, false, nil
	}
	if err != nil {
		return LaneProjection{}, false, fmt.Errorf("load lane projection: %w", err)
	}
	return row.toProjection(), true, nil
}

func insertBlock(ctx context.Context, db blobExecQuerier, block TaskBlock, now string) error {
	parentTipsJSON, err := json.Marshal(block.ParentTips)
	if err != nil {
		return err
	}
	storedPayload, err := externalizeJSONValue(ctx, db, block.Payload, now)
	if err != nil {
		return err
	}
	storedBlock := block
	if payload, ok := storedPayload.(map[string]any); ok {
		storedBlock.Payload = payload
	}
	payloadJSON, err := json.Marshal(storedPayload)
	if err != nil {
		return err
	}
	signatureJSON, err := json.Marshal(block.Signature)
	if err != nil {
		return err
	}
	blockJSONValue, err := externalizeJSONValue(ctx, db, blockToJSONValue(storedBlock), now)
	if err != nil {
		return err
	}
	blockJSON, err := json.Marshal(blockJSONValue)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, `
      INSERT INTO task_blocks (
        block_id, version, project_id, task_id, lane_id, kind, parent_tips_json,
        node_id, actor_id, lease_epoch, created_at, payload_hash, payload_json,
        signature_json, block_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		block.BlockID,
		block.Version,
		block.ProjectID,
		block.TaskID,
		block.LaneID,
		block.Kind,
		string(parentTipsJSON),
		block.NodeID,
		block.ActorID,
		block.LeaseEpoch,
		block.CreatedAt,
		block.PayloadHash,
		string(payloadJSON),
		string(signatureJSON),
		string(blockJSON),
	)
	if err != nil {
		return fmt.Errorf("insert block %s: %w", block.BlockID, err)
	}
	return nil
}

func blockToJSONValue(block TaskBlock) map[string]any {
	return map[string]any{
		"version":     block.Version,
		"blockId":     block.BlockID,
		"projectId":   block.ProjectID,
		"taskId":      block.TaskID,
		"laneId":      block.LaneID,
		"kind":        block.Kind,
		"parentTips":  block.ParentTips,
		"nodeId":      block.NodeID,
		"actorId":     block.ActorID,
		"leaseEpoch":  block.LeaseEpoch,
		"createdAt":   block.CreatedAt,
		"payloadHash": block.PayloadHash,
		"payload":     block.Payload,
		"signature": map[string]any{
			"scheme":    block.Signature.Scheme,
			"publicKey": block.Signature.PublicKey,
			"value":     block.Signature.Value,
		},
	}
}

func upsertProjection(ctx context.Context, db execer, lane LaneProjection) error {
	var checkpointJSON any
	if lane.Checkpoint != nil {
		bytes, err := json.Marshal(lane.Checkpoint)
		if err != nil {
			return err
		}
		checkpointJSON = string(bytes)
	}
	var ownerNodeID, ownerActorID, ownerLeaseUntil any
	var ownerLeaseEpoch any
	if lane.Owner != nil {
		ownerNodeID = lane.Owner.NodeID
		ownerActorID = lane.Owner.ActorID
		ownerLeaseEpoch = lane.Owner.LeaseEpoch
		if lane.Owner.LeaseUntil != "" {
			ownerLeaseUntil = lane.Owner.LeaseUntil
		}
	}
	_, err := db.ExecContext(ctx, `
      INSERT INTO lane_projections (
        project_id, task_id, lane_id, tip, heads_json, lease_epoch, owner_node_id,
        owner_actor_id, owner_lease_epoch, owner_lease_until, canon_markdown,
        inventory_markdown, checkpoint_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        updated_at = excluded.updated_at`,
		lane.ProjectID,
		lane.TaskID,
		lane.LaneID,
		nullIfEmpty(lane.Tip),
		headsJSON(lane.Heads),
		lane.LeaseEpoch,
		ownerNodeID,
		ownerActorID,
		ownerLeaseEpoch,
		ownerLeaseUntil,
		nullIfEmpty(lane.CanonMarkdown),
		nullIfEmpty(lane.InventoryMarkdown),
		checkpointJSON,
		nullIfEmpty(lane.UpdatedAt),
	)
	if err != nil {
		return fmt.Errorf("upsert lane projection: %w", err)
	}
	return nil
}

func laneKey(ref LaneRef) string {
	return ref.ProjectID + "\x00" + ref.TaskID + "\x00" + ref.LaneID
}

func nullIfEmpty(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func timestampOrNow(value string) string {
	if value != "" {
		return value
	}
	return time.Now().UTC().Format(time.RFC3339Nano)
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

type projectionRow struct {
	ProjectID         string
	TaskID            string
	LaneID            string
	Tip               sql.NullString
	HeadsJSON         sql.NullString
	LeaseEpoch        int64
	OwnerNodeID       sql.NullString
	OwnerActorID      sql.NullString
	OwnerLeaseEpoch   sql.NullInt64
	OwnerLeaseUntil   sql.NullString
	CanonMarkdown     sql.NullString
	InventoryMarkdown sql.NullString
	CheckpointJSON    sql.NullString
	UpdatedAt         sql.NullString
}

func (r projectionRow) toProjection() LaneProjection {
	lane := LaneProjection{
		ProjectID:         r.ProjectID,
		TaskID:            r.TaskID,
		LaneID:            r.LaneID,
		Tip:               nullStringValue(r.Tip),
		Heads:             projectionHeads(r.HeadsJSON, r.Tip),
		LeaseEpoch:        r.LeaseEpoch,
		CanonMarkdown:     nullStringValue(r.CanonMarkdown),
		InventoryMarkdown: nullStringValue(r.InventoryMarkdown),
		UpdatedAt:         nullStringValue(r.UpdatedAt),
	}
	if r.OwnerNodeID.Valid && r.OwnerActorID.Valid && r.OwnerLeaseEpoch.Valid {
		lane.Owner = &LaneOwner{
			NodeID:     r.OwnerNodeID.String,
			ActorID:    r.OwnerActorID.String,
			LeaseEpoch: r.OwnerLeaseEpoch.Int64,
			LeaseUntil: nullStringValue(r.OwnerLeaseUntil),
		}
	}
	if r.CheckpointJSON.Valid {
		var checkpoint CheckpointProjection
		if err := json.Unmarshal([]byte(r.CheckpointJSON.String), &checkpoint); err == nil {
			lane.Checkpoint = &checkpoint
		}
	}
	return lane
}

func ensureColumn(ctx context.Context, db *sql.DB, table string, column string, definition string) error {
	rows, err := db.QueryContext(ctx, `PRAGMA table_info(`+table+`)`)
	if err != nil {
		return fmt.Errorf("inspect %s columns: %w", table, err)
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name string
		var typ string
		var notNull int
		var defaultValue any
		var pk int
		if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &pk); err != nil {
			return fmt.Errorf("scan %s column metadata: %w", table, err)
		}
		if name == column {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate %s column metadata: %w", table, err)
	}
	if _, err := db.ExecContext(ctx, `ALTER TABLE `+table+` ADD COLUMN `+column+` `+definition); err != nil {
		return fmt.Errorf("add %s.%s column: %w", table, column, err)
	}
	return nil
}

func headsJSON(heads []string) any {
	if len(heads) == 0 {
		return nil
	}
	bytes, err := json.Marshal(heads)
	if err != nil {
		return nil
	}
	return string(bytes)
}

func projectionHeads(headsJSON sql.NullString, tip sql.NullString) []string {
	if headsJSON.Valid && headsJSON.String != "" {
		var heads []string
		if err := json.Unmarshal([]byte(headsJSON.String), &heads); err == nil && len(heads) > 0 {
			return heads
		}
	}
	if tip.Valid && tip.String != "" {
		return []string{tip.String}
	}
	return nil
}

func nullStringValue(value sql.NullString) string {
	if !value.Valid {
		return ""
	}
	return value.String
}

type trustedPeerRow struct {
	Endpoint   string
	NodeID     sql.NullString
	Name       sql.NullString
	PublicKey  sql.NullString
	Provider   sql.NullString
	Enabled    int
	CreatedAt  string
	UpdatedAt  string
	LastSeenAt sql.NullString
}

func (r trustedPeerRow) toPeer() TrustedPeer {
	return TrustedPeer{
		Endpoint:   r.Endpoint,
		NodeID:     nullStringValue(r.NodeID),
		Name:       nullStringValue(r.Name),
		PublicKey:  nullStringValue(r.PublicKey),
		Provider:   nullStringValue(r.Provider),
		Enabled:    r.Enabled != 0,
		CreatedAt:  r.CreatedAt,
		UpdatedAt:  r.UpdatedAt,
		LastSeenAt: nullStringValue(r.LastSeenAt),
	}
}
