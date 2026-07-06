package continuityd

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"strings"
	"testing"
)

func TestSQLiteStoreAppendAndRebuildSignedBlocks(t *testing.T) {
	ctx := context.Background()
	store, err := OpenSQLiteStore(ctx, t.TempDir()+"/continuity.db")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	signer := newTestSigner(t, "macbook-ariel", "codex-session-1")
	ref := LaneRef{ProjectID: "rp-arielrodriguez/agent-continuity", TaskID: "agent-continuity-decentralized-runtime", LaneID: "main"}

	bootstrap := signer.signBlock(t, TaskBlock{
		Version:    TaskBlockVersion,
		ProjectID:  ref.ProjectID,
		TaskID:     ref.TaskID,
		LaneID:     ref.LaneID,
		Kind:       "bootstrap",
		ParentTips: []string{},
		NodeID:     signer.nodeID,
		ActorID:    signer.actorID,
		LeaseEpoch: 0,
		CreatedAt:  "2026-07-03T20:00:00.000Z",
		Payload: map[string]any{
			"summary":       "Start daemon-backed lane.",
			"canonMarkdown": "# Canon: agent-continuity-decentralized-runtime\n",
		},
	})
	result, err := store.AppendBlock(ctx, bootstrap, "")
	if err != nil {
		t.Fatal(err)
	}
	if !result.Accepted || !result.Inserted {
		t.Fatalf("bootstrap append rejected: %+v", result)
	}

	claim := signer.signBlock(t, TaskBlock{
		Version:    TaskBlockVersion,
		ProjectID:  ref.ProjectID,
		TaskID:     ref.TaskID,
		LaneID:     ref.LaneID,
		Kind:       "claim_lane",
		ParentTips: []string{bootstrap.BlockID},
		NodeID:     signer.nodeID,
		ActorID:    signer.actorID,
		LeaseEpoch: 1,
		CreatedAt:  "2026-07-03T20:01:00.000Z",
		Payload: map[string]any{
			"leaseUntil": "2026-07-03T20:10:00.000Z",
		},
	})
	result, err = store.AppendBlock(ctx, claim, "")
	if err != nil {
		t.Fatal(err)
	}
	if !result.Accepted || result.Lane.Owner == nil || result.Lane.Owner.ActorID != signer.actorID {
		t.Fatalf("claim append rejected: %+v", result)
	}

	checkpoint := signer.signBlock(t, TaskBlock{
		Version:    TaskBlockVersion,
		ProjectID:  ref.ProjectID,
		TaskID:     ref.TaskID,
		LaneID:     ref.LaneID,
		Kind:       "checkpoint",
		ParentTips: []string{claim.BlockID},
		NodeID:     signer.nodeID,
		ActorID:    signer.actorID,
		LeaseEpoch: 1,
		CreatedAt:  "2026-07-03T20:02:00.000Z",
		Payload: map[string]any{
			"status":   "in_progress",
			"progress": "Go daemon store accepted signed blocks.",
		},
	})
	result, err = store.AppendBlock(ctx, checkpoint, "")
	if err != nil {
		t.Fatal(err)
	}
	if !result.Accepted || result.Lane.Checkpoint == nil || result.Lane.Checkpoint.Progress != "Go daemon store accepted signed blocks." {
		t.Fatalf("checkpoint append rejected: %+v", result)
	}

	count, err := store.RebuildProjections(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if count != 3 {
		t.Fatalf("replayed %d blocks, want 3", count)
	}
	lane, found, err := store.LaneProjection(ctx, ref)
	if err != nil {
		t.Fatal(err)
	}
	if !found || lane.Tip != checkpoint.BlockID || lane.Checkpoint.Progress != "Go daemon store accepted signed blocks." {
		t.Fatalf("unexpected rebuilt lane: %+v", lane)
	}
}

func TestSQLiteStoreBlocksReturnsEmptySliceForEmptyLane(t *testing.T) {
	ctx := context.Background()
	store, err := OpenSQLiteStore(ctx, t.TempDir()+"/continuity.db")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	blocks, err := store.Blocks(ctx, LaneRef{ProjectID: "rp-arielrodriguez/agent-continuity", TaskID: "empty-task", LaneID: "main"})
	if err != nil {
		t.Fatal(err)
	}
	if blocks == nil {
		t.Fatal("blocks is nil, want empty slice")
	}
	if len(blocks) != 0 {
		t.Fatalf("len(blocks) = %d, want 0", len(blocks))
	}
}

func TestSQLiteStoreExternalizesAndHydratesLargeBlockPayloads(t *testing.T) {
	ctx := context.Background()
	store, err := OpenSQLiteStore(ctx, t.TempDir()+"/continuity.db")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	signer := newTestSigner(t, "macbook-ariel", "codex-session-1")
	ref := LaneRef{ProjectID: "rp-arielrodriguez/agent-continuity", TaskID: "blob-runtime", LaneID: "main"}
	largeCanon := "# Canon: blob-runtime\n\n" + strings.Repeat("large canonical state\n", 200)
	bootstrap := signer.signBlock(t, TaskBlock{
		Version:    TaskBlockVersion,
		ProjectID:  ref.ProjectID,
		TaskID:     ref.TaskID,
		LaneID:     ref.LaneID,
		Kind:       "bootstrap",
		ParentTips: []string{},
		NodeID:     signer.nodeID,
		ActorID:    signer.actorID,
		LeaseEpoch: 0,
		CreatedAt:  "2026-07-03T20:00:00.000Z",
		Payload: map[string]any{
			"summary":       "Start blob-backed lane.",
			"canonMarkdown": largeCanon,
		},
	})
	if result, err := store.AppendBlock(ctx, bootstrap, ""); err != nil || !result.Accepted {
		t.Fatalf("bootstrap append failed: result=%+v err=%v", result, err)
	}

	var storedBlockJSON string
	if err := store.db.QueryRowContext(ctx, `SELECT block_json FROM task_blocks WHERE block_id = ?`, bootstrap.BlockID).Scan(&storedBlockJSON); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(storedBlockJSON, largeCanon) {
		t.Fatal("stored block JSON contains inline large canon")
	}
	if !strings.Contains(storedBlockJSON, blobRefMarker) {
		t.Fatalf("stored block JSON does not contain blob marker: %s", storedBlockJSON)
	}

	blocks, err := store.Blocks(ctx, ref)
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 1 || payloadString(blocks[0].Payload, "canonMarkdown") != largeCanon {
		t.Fatalf("hydrated block mismatch: %+v", blocks)
	}
	if issues := ValidateTaskBlock(blocks[0]); len(issues) != 0 {
		t.Fatalf("hydrated block no longer validates: %+v", issues)
	}
	inventory, err := store.LaneInventory(ctx, ref)
	if err != nil {
		t.Fatal(err)
	}
	if len(inventory.Blocks) != 1 || len(inventory.Blocks[0].BlobDigests) != 1 {
		t.Fatalf("inventory blob refs not reported: %+v", inventory.Blocks)
	}
	blob, err := store.Blob(ctx, inventory.Blocks[0].BlobDigests[0])
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := base64.StdEncoding.DecodeString(blob.Content)
	if err != nil {
		t.Fatal(err)
	}
	if string(decoded) != largeCanon {
		t.Fatal("blob content did not match large canon")
	}
}

func TestSQLiteStoreAcceptsCollaborativeSchedulerBlocks(t *testing.T) {
	ctx := context.Background()
	store, err := OpenSQLiteStore(ctx, t.TempDir()+"/continuity.db")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	orchestrator := newTestSigner(t, "a0263", "scheduler")
	worker := newTestSigner(t, "mac-studio", "worker")
	ref := LaneRef{ProjectID: "rp-arielrodriguez/agent-continuity", TaskID: "scheduler-runtime", LaneID: "scheduler"}

	bootstrap := orchestrator.signBlock(t, TaskBlock{
		Version:    TaskBlockVersion,
		ProjectID:  ref.ProjectID,
		TaskID:     ref.TaskID,
		LaneID:     ref.LaneID,
		Kind:       "bootstrap",
		ParentTips: []string{},
		NodeID:     orchestrator.nodeID,
		ActorID:    orchestrator.actorID,
		LeaseEpoch: 0,
		CreatedAt:  "2026-07-05T22:00:00.000Z",
		Payload: map[string]any{
			"summary": "Start scheduler lane.",
		},
	})
	if result, err := store.AppendBlock(ctx, bootstrap, ""); err != nil || !result.Accepted {
		t.Fatalf("bootstrap append failed: result=%+v err=%v", result, err)
	}

	intent := orchestrator.signBlock(t, TaskBlock{
		Version:    TaskBlockVersion,
		ProjectID:  ref.ProjectID,
		TaskID:     ref.TaskID,
		LaneID:     ref.LaneID,
		Kind:       "task_intent",
		ParentTips: []string{bootstrap.BlockID},
		NodeID:     orchestrator.nodeID,
		ActorID:    orchestrator.actorID,
		LeaseEpoch: 0,
		CreatedAt:  "2026-07-05T22:01:00.000Z",
		Payload: map[string]any{
			"title":        "Run scheduler smoke",
			"instructions": "Run a deterministic smoke.",
			"requirements": map[string]any{
				"agents": []any{"codex"},
				"tools":  []any{"shell", "git"},
			},
		},
	})
	if result, err := store.AppendBlock(ctx, intent, ""); err != nil || !result.Accepted {
		t.Fatalf("intent append failed: result=%+v err=%v", result, err)
	}

	profile := worker.signBlock(t, TaskBlock{
		Version:    TaskBlockVersion,
		ProjectID:  ref.ProjectID,
		TaskID:     ref.TaskID,
		LaneID:     ref.LaneID,
		Kind:       "worker_profile",
		ParentTips: []string{intent.BlockID},
		NodeID:     worker.nodeID,
		ActorID:    worker.actorID,
		LeaseEpoch: 0,
		CreatedAt:  "2026-07-05T22:02:00.000Z",
		Payload: map[string]any{
			"workerId":      "mac-studio-codex",
			"agent":         "codex",
			"modelFamilies": []any{"gpt"},
			"tools":         []any{"shell", "git"},
		},
	})
	if result, err := store.AppendBlock(ctx, profile, ""); err != nil || !result.Accepted {
		t.Fatalf("profile append failed: result=%+v err=%v", result, err)
	}

	assignment := worker.signBlock(t, TaskBlock{
		Version:    TaskBlockVersion,
		ProjectID:  ref.ProjectID,
		TaskID:     ref.TaskID,
		LaneID:     ref.LaneID,
		Kind:       "task_assignment",
		ParentTips: []string{profile.BlockID},
		NodeID:     worker.nodeID,
		ActorID:    worker.actorID,
		LeaseEpoch: 0,
		CreatedAt:  "2026-07-05T22:03:00.000Z",
		Payload: map[string]any{
			"intentBlockId":  intent.BlockID,
			"workerId":       "mac-studio-codex",
			"assignedLaneId": "mac-studio-codex",
			"mode":           "automatic",
			"leaseUntil":     "2026-07-05T22:13:00.000Z",
		},
	})
	if result, err := store.AppendBlock(ctx, assignment, ""); err != nil || !result.Accepted {
		t.Fatalf("assignment append failed: result=%+v err=%v", result, err)
	}

	taskResult := worker.signBlock(t, TaskBlock{
		Version:    TaskBlockVersion,
		ProjectID:  ref.ProjectID,
		TaskID:     ref.TaskID,
		LaneID:     ref.LaneID,
		Kind:       "task_result",
		ParentTips: []string{assignment.BlockID},
		NodeID:     worker.nodeID,
		ActorID:    worker.actorID,
		LeaseEpoch: 0,
		CreatedAt:  "2026-07-05T22:04:00.000Z",
		Payload: map[string]any{
			"intentBlockId":     intent.BlockID,
			"assignmentBlockId": assignment.BlockID,
			"workerId":          "mac-studio-codex",
			"status":            "completed",
			"summary":           "Scheduler smoke completed.",
		},
	})
	result, err := store.AppendBlock(ctx, taskResult, "")
	if err != nil {
		t.Fatal(err)
	}
	if !result.Accepted || result.Lane.Tip != taskResult.BlockID {
		t.Fatalf("result append rejected: %+v", result)
	}
}

func TestSQLiteStoreAcceptsForkedSchedulerResultsAndAdjudication(t *testing.T) {
	ctx := context.Background()
	store, err := OpenSQLiteStore(ctx, t.TempDir()+"/continuity.db")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	orchestrator := newTestSigner(t, "a0263", "scheduler")
	workerA := newTestSigner(t, "worker-a", "codex")
	workerB := newTestSigner(t, "worker-b", "codex")
	ref := LaneRef{ProjectID: "rp-arielrodriguez/agent-continuity", TaskID: "forked-scheduler-runtime", LaneID: "scheduler"}

	bootstrap := orchestrator.signBlock(t, TaskBlock{
		Version:    TaskBlockVersion,
		ProjectID:  ref.ProjectID,
		TaskID:     ref.TaskID,
		LaneID:     ref.LaneID,
		Kind:       "bootstrap",
		ParentTips: []string{},
		NodeID:     orchestrator.nodeID,
		ActorID:    orchestrator.actorID,
		LeaseEpoch: 0,
		CreatedAt:  "2026-07-06T01:10:00.000Z",
		Payload: map[string]any{
			"summary": "Start scheduler lane.",
		},
	})
	if result, err := store.AppendBlock(ctx, bootstrap, ""); err != nil || !result.Accepted {
		t.Fatalf("bootstrap append failed: result=%+v err=%v", result, err)
	}

	intent := orchestrator.signBlock(t, TaskBlock{
		Version:    TaskBlockVersion,
		ProjectID:  ref.ProjectID,
		TaskID:     ref.TaskID,
		LaneID:     ref.LaneID,
		Kind:       "task_intent",
		ParentTips: []string{bootstrap.BlockID},
		NodeID:     orchestrator.nodeID,
		ActorID:    orchestrator.actorID,
		LeaseEpoch: 0,
		CreatedAt:  "2026-07-06T01:11:00.000Z",
		Payload: map[string]any{
			"title":        "Offline competition",
			"instructions": "Accept competing useful results.",
			"policy":       "speculative",
		},
	})
	if result, err := store.AppendBlock(ctx, intent, ""); err != nil || !result.Accepted {
		t.Fatalf("intent append failed: result=%+v err=%v", result, err)
	}

	resultA := workerA.signBlock(t, TaskBlock{
		Version:    TaskBlockVersion,
		ProjectID:  ref.ProjectID,
		TaskID:     ref.TaskID,
		LaneID:     ref.LaneID,
		Kind:       "task_result",
		ParentTips: []string{intent.BlockID},
		NodeID:     workerA.nodeID,
		ActorID:    workerA.actorID,
		LeaseEpoch: 0,
		CreatedAt:  "2026-07-06T01:12:00.000Z",
		Payload: map[string]any{
			"intentBlockId": intent.BlockID,
			"workerId":      "worker-a",
			"status":        "completed",
			"summary":       "Result A.",
		},
	})
	if result, err := store.AppendBlock(ctx, resultA, ""); err != nil || !result.Accepted {
		t.Fatalf("result A append failed: result=%+v err=%v", result, err)
	}

	resultB := workerB.signBlock(t, TaskBlock{
		Version:    TaskBlockVersion,
		ProjectID:  ref.ProjectID,
		TaskID:     ref.TaskID,
		LaneID:     ref.LaneID,
		Kind:       "task_result",
		ParentTips: []string{intent.BlockID},
		NodeID:     workerB.nodeID,
		ActorID:    workerB.actorID,
		LeaseEpoch: 0,
		CreatedAt:  "2026-07-06T01:13:00.000Z",
		Payload: map[string]any{
			"intentBlockId": intent.BlockID,
			"workerId":      "worker-b",
			"status":        "completed",
			"summary":       "Result B.",
		},
	})
	fork, err := store.AppendBlock(ctx, resultB, "")
	if err != nil {
		t.Fatal(err)
	}
	if !fork.Accepted || !sameStringSet(fork.Lane.Heads, []string{resultA.BlockID, resultB.BlockID}) {
		t.Fatalf("fork append did not preserve both heads: %+v", fork)
	}

	adjudication := orchestrator.signBlock(t, TaskBlock{
		Version:    TaskBlockVersion,
		ProjectID:  ref.ProjectID,
		TaskID:     ref.TaskID,
		LaneID:     ref.LaneID,
		Kind:       "task_adjudication",
		ParentTips: fork.Lane.Heads,
		NodeID:     orchestrator.nodeID,
		ActorID:    orchestrator.actorID,
		LeaseEpoch: 0,
		CreatedAt:  "2026-07-06T01:14:00.000Z",
		Payload: map[string]any{
			"intentBlockId":       intent.BlockID,
			"resultBlockIds":      []any{resultA.BlockID, resultB.BlockID},
			"winnerResultBlockId": resultB.BlockID,
			"summary":             "Selected result B.",
		},
	})
	merged, err := store.AppendBlock(ctx, adjudication, "")
	if err != nil {
		t.Fatal(err)
	}
	if !merged.Accepted || len(merged.Lane.Heads) != 1 || merged.Lane.Heads[0] != adjudication.BlockID {
		t.Fatalf("adjudication did not merge heads: %+v", merged)
	}
}

func TestSQLiteStoreTrustedPeersLifecycle(t *testing.T) {
	ctx := context.Background()
	store, err := OpenSQLiteStore(ctx, t.TempDir()+"/continuity.db")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	created, err := store.UpsertTrustedPeer(ctx, TrustedPeer{
		Endpoint: "tcp://100.64.0.2:9987",
		NodeID:   "node-1",
		Name:     "workstation",
		Provider: "tailscale",
		Enabled:  true,
	}, "2026-07-04T10:00:00.000Z")
	if err != nil {
		t.Fatal(err)
	}
	if created.Endpoint != "tcp://100.64.0.2:9987" || !created.Enabled || created.CreatedAt != "2026-07-04T10:00:00.000Z" {
		t.Fatalf("unexpected created trusted peer: %+v", created)
	}

	updated, err := store.UpsertTrustedPeer(ctx, TrustedPeer{
		Endpoint: "tcp://100.64.0.2:9987",
		NodeID:   "node-1",
		Name:     "workstation-renamed",
		Provider: "tailscale",
		Enabled:  true,
	}, "2026-07-04T10:05:00.000Z")
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != "workstation-renamed" || updated.CreatedAt != created.CreatedAt || updated.UpdatedAt != "2026-07-04T10:05:00.000Z" {
		t.Fatalf("unexpected updated trusted peer: %+v", updated)
	}

	if err := store.TouchTrustedPeer(ctx, updated.Endpoint, "2026-07-04T10:06:00.000Z"); err != nil {
		t.Fatal(err)
	}
	peers, err := store.TrustedPeers(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(peers) != 1 || peers[0].LastSeenAt != "2026-07-04T10:06:00.000Z" {
		t.Fatalf("unexpected trusted peers: %+v", peers)
	}

	removed, err := store.RemoveTrustedPeer(ctx, updated.Endpoint)
	if err != nil {
		t.Fatal(err)
	}
	if !removed {
		t.Fatal("trusted peer was not removed")
	}
	peers, err = store.TrustedPeers(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(peers) != 0 {
		t.Fatalf("trusted peers after remove = %+v, want empty", peers)
	}
}

type testSigner struct {
	nodeID    string
	actorID   string
	private   ed25519.PrivateKey
	publicDER string
}

func newTestSigner(t *testing.T, nodeID string, actorID string) testSigner {
	t.Helper()
	public, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	return testSigner{
		nodeID:    nodeID,
		actorID:   actorID,
		private:   private,
		publicDER: base64.RawURLEncoding.EncodeToString(der),
	}
}

func (s testSigner) signBlock(t *testing.T, block TaskBlock) TaskBlock {
	t.Helper()
	payloadHash, err := HashJSON(block.Payload)
	if err != nil {
		t.Fatal(err)
	}
	block.PayloadHash = payloadHash
	block.Signature = BlockSignature{Scheme: SignatureScheme, PublicKey: s.publicDER}
	unsigned, err := unsignedMap(block)
	if err != nil {
		t.Fatal(err)
	}
	bytes, err := CanonicalJSON(unsigned)
	if err != nil {
		t.Fatal(err)
	}
	block.Signature.Value = base64.RawURLEncoding.EncodeToString(ed25519.Sign(s.private, bytes))
	blockID, err := BlockIDFor(block)
	if err != nil {
		t.Fatal(err)
	}
	block.BlockID = blockID
	return block
}

func sameStringSet(left []string, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	seen := map[string]int{}
	for _, value := range left {
		seen[value]++
	}
	for _, value := range right {
		seen[value]--
		if seen[value] < 0 {
			return false
		}
	}
	return true
}
