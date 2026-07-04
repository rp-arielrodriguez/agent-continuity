package continuityd

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
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
