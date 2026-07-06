package continuityd

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"
	"time"
)

func TestPeerSyncPullsBlocksFromStaticUnixPeer(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ref := LaneRef{ProjectID: "rp-arielrodriguez/agent-continuity", TaskID: "agent-continuity-decentralized-runtime", LaneID: "main"}
	signer := newTestSigner(t, "peer-node", "peer-agent")

	remoteStore := openTestStore(t, ctx)
	defer remoteStore.Close()
	_, checkpoint := appendTestLane(t, ctx, remoteStore, signer, ref, "Peer checkpoint.")
	remoteSocket, stopRemote := serveTestServer(t, ctx, remoteStore)
	defer stopRemote()

	localStore := openTestStore(t, ctx)
	defer localStore.Close()
	localSocket, stopLocal := serveTestServer(t, ctx, localStore)
	defer stopLocal()

	var syncResult PeerSyncResult
	callTestRPC(t, localSocket, "peer.sync", PeerSyncInput{ProjectID: ref.ProjectID, TaskID: ref.TaskID, LaneID: ref.LaneID, Peers: []string{"unix://" + remoteSocket}}, &syncResult)

	if syncResult.FetchedBlocks != 3 || syncResult.AcceptedBlocks != 3 || syncResult.InsertedBlocks != 3 || syncResult.RejectedBlocks != 0 {
		t.Fatalf("unexpected sync result: %+v", syncResult)
	}
	if syncResult.FinalTip != checkpoint.BlockID {
		t.Fatalf("final tip = %s, want %s", syncResult.FinalTip, checkpoint.BlockID)
	}
	blocks, err := localStore.Blocks(ctx, ref)
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 3 {
		t.Fatalf("local block count = %d, want 3", len(blocks))
	}

	var second PeerSyncResult
	callTestRPC(t, localSocket, "peer.sync", PeerSyncInput{ProjectID: ref.ProjectID, TaskID: ref.TaskID, LaneID: ref.LaneID, Peers: []string{"unix://" + remoteSocket}}, &second)
	if second.AdvertisedBlocks != 3 || second.MissingBlocks != 0 || second.FetchedBlocks != 0 || second.AcceptedBlocks != 0 || second.InsertedBlocks != 0 || second.RejectedBlocks != 0 {
		t.Fatalf("unexpected idempotent sync result: %+v", second)
	}
}

func TestPeerTCPDialNetworksPreferAddressFamiliesForNamedHosts(t *testing.T) {
	tests := []struct {
		name    string
		address string
		want    []string
	}{
		{
			name:    "hostname",
			address: "A0263.local:9987",
			want:    []string{"tcp4", "tcp6", "tcp"},
		},
		{
			name:    "ipv4 literal",
			address: "10.44.110.222:9987",
			want:    []string{"tcp"},
		},
		{
			name:    "ipv6 literal",
			address: "[fd7a:115c:a1e0::2]:9987",
			want:    []string{"tcp"},
		},
		{
			name:    "ipv6 link local literal with zone",
			address: "[fe80::1067:719e:9d1b:a5b0%en1]:9987",
			want:    []string{"tcp"},
		},
		{
			name:    "invalid address falls back to default tcp",
			address: "missing-port",
			want:    []string{"tcp"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := peerTCPDialNetworks(test.address)
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("peerTCPDialNetworks(%q) = %v, want %v", test.address, got, test.want)
			}
		})
	}
}

func TestDialPeerAddressFallsBackAcrossNamedHostAddressFamilies(t *testing.T) {
	dialer := &recordingPeerDialer{
		successNetwork: "tcp6",
	}
	conn, err := dialPeerAddress(context.Background(), "tcp", "A0263.local:9987", dialer)
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()

	want := []string{"tcp4", "tcp6"}
	if !reflect.DeepEqual(dialer.networks, want) {
		t.Fatalf("dial attempts = %v, want %v", dialer.networks, want)
	}
}

func TestDialPeerAddressUsesSingleDialForLiterals(t *testing.T) {
	dialer := &recordingPeerDialer{
		successNetwork: "tcp",
	}
	conn, err := dialPeerAddress(context.Background(), "tcp", "10.44.110.222:9987", dialer)
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()

	want := []string{"tcp"}
	if !reflect.DeepEqual(dialer.networks, want) {
		t.Fatalf("dial attempts = %v, want %v", dialer.networks, want)
	}
}

type recordingPeerDialer struct {
	networks       []string
	successNetwork string
}

func (d *recordingPeerDialer) DialContext(_ context.Context, network string, _ string) (net.Conn, error) {
	d.networks = append(d.networks, network)
	if network != d.successNetwork {
		return nil, errors.New("dial failed")
	}
	left, right := net.Pipe()
	right.Close()
	return left, nil
}

func TestPeerSyncFetchesOnlyMissingBlocks(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ref := LaneRef{ProjectID: "rp-arielrodriguez/agent-continuity", TaskID: "agent-continuity-decentralized-runtime", LaneID: "main"}
	signer := newTestSigner(t, "delta-peer-node", "delta-peer-agent")

	remoteStore := openTestStore(t, ctx)
	defer remoteStore.Close()
	_, checkpoint := appendTestLane(t, ctx, remoteStore, signer, ref, "Delta checkpoint.")
	remoteBlocks, err := remoteStore.Blocks(ctx, ref)
	if err != nil {
		t.Fatal(err)
	}
	remoteSocket, stopRemote := serveTestServer(t, ctx, remoteStore)
	defer stopRemote()

	localStore := openTestStore(t, ctx)
	defer localStore.Close()
	for _, block := range remoteBlocks[:2] {
		if result, err := localStore.AppendBlock(ctx, block, ""); err != nil || !result.Accepted {
			t.Fatalf("seed local block failed: result=%+v err=%v", result, err)
		}
	}
	localSocket, stopLocal := serveTestServer(t, ctx, localStore)
	defer stopLocal()

	var syncResult PeerSyncResult
	callTestRPC(t, localSocket, "peer.sync", PeerSyncInput{ProjectID: ref.ProjectID, TaskID: ref.TaskID, LaneID: ref.LaneID, Peers: []string{"unix://" + remoteSocket}}, &syncResult)

	if syncResult.AdvertisedBlocks != 3 || syncResult.MissingBlocks != 1 || syncResult.FetchedBlocks != 1 || syncResult.AcceptedBlocks != 1 || syncResult.InsertedBlocks != 1 || syncResult.RejectedBlocks != 0 {
		t.Fatalf("unexpected delta sync result: %+v", syncResult)
	}
	if syncResult.FinalTip != checkpoint.BlockID {
		t.Fatalf("final tip = %s, want %s", syncResult.FinalTip, checkpoint.BlockID)
	}
}

func TestPeerSyncAcceptsCompactedSnapshotWithoutHistoricalParents(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ref := LaneRef{ProjectID: "rp-arielrodriguez/agent-continuity", TaskID: "compacted-runtime", LaneID: "main"}
	signer := newTestSigner(t, "snapshot-peer-node", "snapshot-peer-agent")

	remoteStore := openTestStore(t, ctx)
	defer remoteStore.Close()
	appendTestLane(t, ctx, remoteStore, signer, ref, "Before snapshot.")
	lane, found, err := remoteStore.LaneProjection(ctx, ref)
	if err != nil {
		t.Fatal(err)
	}
	if !found {
		t.Fatal("remote lane not found")
	}
	blocks, err := remoteStore.Blocks(ctx, ref)
	if err != nil {
		t.Fatal(err)
	}
	baseBlockIDs := make([]any, 0, len(blocks))
	for _, block := range blocks {
		baseBlockIDs = append(baseBlockIDs, block.BlockID)
	}
	snapshot := signer.signBlock(t, TaskBlock{
		Version:    TaskBlockVersion,
		ProjectID:  ref.ProjectID,
		TaskID:     ref.TaskID,
		LaneID:     ref.LaneID,
		Kind:       "lane_snapshot",
		ParentTips: []string{lane.Tip},
		NodeID:     signer.nodeID,
		ActorID:    signer.actorID,
		LeaseEpoch: lane.LeaseEpoch,
		CreatedAt:  "2026-07-03T22:03:00.000Z",
		Payload: map[string]any{
			"summary":             "Compacted lane history.",
			"baseBlockIds":        baseBlockIDs,
			"compactedBlockCount": len(blocks),
			"checkpoint": map[string]any{
				"status":   "in_progress",
				"progress": "Before snapshot.",
			},
			"owner": map[string]any{
				"nodeId":     signer.nodeID,
				"actorId":    signer.actorID,
				"leaseEpoch": lane.LeaseEpoch,
				"leaseUntil": lane.Owner.LeaseUntil,
			},
		},
	})
	if result, err := remoteStore.AppendBlock(ctx, snapshot, ""); err != nil || !result.Accepted {
		t.Fatalf("snapshot append failed: result=%+v err=%v", result, err)
	}
	retention, err := remoteStore.ApplyRetention(ctx, RetentionApplyInput{
		ProjectID:       ref.ProjectID,
		TaskID:          ref.TaskID,
		LaneID:          ref.LaneID,
		KeepRecent:      1,
		RequireSnapshot: true,
		Reason:          "test compaction",
	})
	if err != nil {
		t.Fatal(err)
	}
	if retention.ArchivedBlocks != 3 || retention.ActiveBlocks != 1 || retention.LatestSnapshot != snapshot.BlockID {
		t.Fatalf("unexpected retention result: %+v", retention)
	}
	if replayed, err := remoteStore.RebuildProjections(ctx); err != nil || replayed != 1 {
		t.Fatalf("rebuild after retention replayed=%d err=%v", replayed, err)
	}

	remoteSocket, stopRemote := serveTestServer(t, ctx, remoteStore)
	defer stopRemote()
	localStore := openTestStore(t, ctx)
	defer localStore.Close()
	localSocket, stopLocal := serveTestServer(t, ctx, localStore)
	defer stopLocal()

	var syncResult PeerSyncResult
	callTestRPC(t, localSocket, "peer.sync", PeerSyncInput{ProjectID: ref.ProjectID, TaskID: ref.TaskID, LaneID: ref.LaneID, Peers: []string{"unix://" + remoteSocket}}, &syncResult)

	if syncResult.AdvertisedBlocks != 1 || syncResult.MissingBlocks != 1 || syncResult.FetchedBlocks != 1 || syncResult.InsertedBlocks != 1 || syncResult.RejectedBlocks != 0 {
		t.Fatalf("unexpected compacted sync result: %+v", syncResult)
	}
	if syncResult.FinalTip != snapshot.BlockID {
		t.Fatalf("final tip = %s, want snapshot %s", syncResult.FinalTip, snapshot.BlockID)
	}
}

func TestPeerSyncPullsBlocksFromReadOnlyTCPPeer(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ref := LaneRef{ProjectID: "rp-arielrodriguez/agent-continuity", TaskID: "agent-continuity-decentralized-runtime", LaneID: "main"}
	signer := newTestSigner(t, "tcp-peer-node", "tcp-peer-agent")

	remoteStore := openTestStore(t, ctx)
	defer remoteStore.Close()
	_, checkpoint := appendTestLane(t, ctx, remoteStore, signer, ref, "TCP peer checkpoint.")
	remoteAddress, stopRemote := serveTestReadOnlyTCPPeer(t, ctx, remoteStore)
	defer stopRemote()

	localStore := openTestStore(t, ctx)
	defer localStore.Close()
	localSocket, stopLocal := serveTestServer(t, ctx, localStore)
	defer stopLocal()

	var syncResult PeerSyncResult
	callTestRPC(t, localSocket, "peer.sync", PeerSyncInput{ProjectID: ref.ProjectID, TaskID: ref.TaskID, LaneID: ref.LaneID, Peers: []string{"tcp://" + remoteAddress}}, &syncResult)

	if syncResult.FetchedBlocks != 3 || syncResult.AcceptedBlocks != 3 || syncResult.InsertedBlocks != 3 || syncResult.RejectedBlocks != 0 {
		t.Fatalf("unexpected sync result: %+v", syncResult)
	}
	if syncResult.FinalTip != checkpoint.BlockID {
		t.Fatalf("final tip = %s, want %s", syncResult.FinalTip, checkpoint.BlockID)
	}
}

func TestPeerSyncTrustedPullsFromPersistedAddressBook(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ref := LaneRef{ProjectID: "rp-arielrodriguez/agent-continuity", TaskID: "agent-continuity-decentralized-runtime", LaneID: "main"}
	signer := newTestSigner(t, "trusted-peer-node", "trusted-peer-agent")

	remoteStore := openTestStore(t, ctx)
	defer remoteStore.Close()
	_, checkpoint := appendTestLane(t, ctx, remoteStore, signer, ref, "Trusted peer checkpoint.")
	remoteSocket, stopRemote := serveTestServer(t, ctx, remoteStore)
	defer stopRemote()

	localStore := openTestStore(t, ctx)
	defer localStore.Close()
	localSocket, stopLocal := serveTestServer(t, ctx, localStore)
	defer stopLocal()

	var empty PeerSyncResult
	callTestRPC(t, localSocket, "peer.syncTrusted", PeerSyncTrustedInput{ProjectID: ref.ProjectID, TaskID: ref.TaskID, LaneID: ref.LaneID}, &empty)
	if len(empty.Peers) != 0 || empty.InsertedBlocks != 0 {
		t.Fatalf("empty trusted sync = %+v, want no-op", empty)
	}

	trustedEndpoint := "unix://" + remoteSocket
	if _, err := localStore.UpsertTrustedPeer(ctx, TrustedPeer{
		Endpoint: trustedEndpoint,
		Name:     "desktop",
		Enabled:  true,
	}, "2026-07-04T11:00:00.000Z"); err != nil {
		t.Fatal(err)
	}

	var syncResult PeerSyncResult
	callTestRPC(t, localSocket, "peer.syncTrusted", PeerSyncTrustedInput{ProjectID: ref.ProjectID, TaskID: ref.TaskID, LaneID: ref.LaneID}, &syncResult)

	if syncResult.FetchedBlocks != 3 || syncResult.AcceptedBlocks != 3 || syncResult.InsertedBlocks != 3 || syncResult.RejectedBlocks != 0 {
		t.Fatalf("unexpected trusted sync result: %+v", syncResult)
	}
	if syncResult.FinalTip != checkpoint.BlockID {
		t.Fatalf("final tip = %s, want %s", syncResult.FinalTip, checkpoint.BlockID)
	}
	peer, found, err := localStore.TrustedPeer(ctx, trustedEndpoint)
	if err != nil {
		t.Fatal(err)
	}
	if !found || peer.LastSeenAt == "" {
		t.Fatalf("trusted peer last seen was not updated: found=%t peer=%+v", found, peer)
	}
}

func TestPeerSyncRoutesThroughCandidateEndpointAndRecordsLastGood(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ref := LaneRef{ProjectID: "rp-arielrodriguez/agent-continuity", TaskID: "candidate-routing", LaneID: "main"}
	signer := newTestSigner(t, "candidate-peer-node", "candidate-peer-agent")

	remoteStore := openTestStore(t, ctx)
	defer remoteStore.Close()
	_, checkpoint := appendTestLane(t, ctx, remoteStore, signer, ref, "Candidate-routed checkpoint.")
	remoteAddress, stopRemote := serveTestReadOnlyTCPPeer(t, ctx, remoteStore)
	defer stopRemote()

	_, port, err := net.SplitHostPort(remoteAddress)
	if err != nil {
		t.Fatal(err)
	}
	trustedEndpoint := "tcp://candidate-peer.test:" + port
	selectedEndpoint := "tcp://" + net.JoinHostPort("127.0.0.1", port)

	originalLookup := lookupPeerIPAddrs
	lookupPeerIPAddrs = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
	}
	t.Cleanup(func() { lookupPeerIPAddrs = originalLookup })

	localStore := openTestStore(t, ctx)
	defer localStore.Close()
	if _, err := localStore.UpsertTrustedPeer(ctx, TrustedPeer{
		Endpoint: trustedEndpoint,
		Name:     "candidate-peer",
		Enabled:  true,
	}, "2026-07-04T11:30:00.000Z"); err != nil {
		t.Fatal(err)
	}

	server := NewServer(localStore)
	syncResult, err := server.peerSync(ctx, ref, []peerSyncTarget{{Endpoint: trustedEndpoint}}, false)
	if err != nil {
		t.Fatal(err)
	}
	if syncResult.FinalTip != checkpoint.BlockID || syncResult.InsertedBlocks != 3 {
		t.Fatalf("unexpected candidate sync result: %+v", syncResult)
	}
	if len(syncResult.Peers) != 1 || syncResult.Peers[0].SelectedEndpoint != selectedEndpoint {
		t.Fatalf("unexpected selected endpoint: %+v", syncResult.Peers)
	}
	if len(syncResult.Peers[0].CandidateEndpoints) != 1 || syncResult.Peers[0].CandidateEndpoints[0].Endpoint != selectedEndpoint {
		t.Fatalf("candidate endpoint attempts = %+v, want resolved candidate only", syncResult.Peers[0].CandidateEndpoints)
	}
	peer, found, err := localStore.TrustedPeer(ctx, trustedEndpoint)
	if err != nil {
		t.Fatal(err)
	}
	if !found || peer.LastGoodEndpoint != selectedEndpoint || peer.LastError != "" {
		t.Fatalf("trusted peer routing metadata was not updated: found=%t peer=%+v", found, peer)
	}
}

func TestPeerSyncTrustedSkipsLikelySelfPeer(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ref := LaneRef{ProjectID: "rp-arielrodriguez/agent-continuity", TaskID: "self-peer-skip", LaneID: "main"}
	localStore := openTestStore(t, ctx)
	defer localStore.Close()
	localSocket, stopLocal := serveTestServer(t, ctx, localStore)
	defer stopLocal()

	if _, err := localStore.UpsertTrustedPeer(ctx, TrustedPeer{
		Endpoint: "tcp://localhost:9987",
		Name:     "self",
		Enabled:  true,
	}, "2026-07-04T11:40:00.000Z"); err != nil {
		t.Fatal(err)
	}

	var syncResult PeerSyncResult
	callTestRPC(t, localSocket, "peer.syncTrusted", PeerSyncTrustedInput{ProjectID: ref.ProjectID, TaskID: ref.TaskID, LaneID: ref.LaneID}, &syncResult)

	if len(syncResult.Peers) != 1 || !syncResult.Peers[0].Skipped || syncResult.Peers[0].SkipReason == "" {
		t.Fatalf("expected self peer to be skipped, got %+v", syncResult.Peers)
	}
	if syncResult.FetchedBlocks != 0 || syncResult.InsertedBlocks != 0 {
		t.Fatalf("self peer skip should be a no-op sync: %+v", syncResult)
	}
}

func TestReadOnlyTCPPeerRejectsMutatingMethods(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	store := openTestStore(t, ctx)
	defer store.Close()
	address, stop := serveTestReadOnlyTCPPeer(t, ctx, store)
	defer stop()

	conn, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	if err := json.NewEncoder(conn).Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      "mutate-1",
		"method":  "block.submit",
		"params":  map[string]any{},
	}); err != nil {
		t.Fatal(err)
	}
	var response peerRPCResponse
	if err := json.NewDecoder(conn).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.Error == nil || response.Error.Code != -32601 {
		t.Fatalf("response = %+v, want method unavailable error", response)
	}
}

func TestPeerSyncReportsDivergentLaneBlocks(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ref := LaneRef{ProjectID: "rp-arielrodriguez/agent-continuity", TaskID: "agent-continuity-decentralized-runtime", LaneID: "main"}
	remoteSigner := newTestSigner(t, "peer-node", "peer-agent")
	localSigner := newTestSigner(t, "local-node", "local-agent")

	remoteStore := openTestStore(t, ctx)
	defer remoteStore.Close()
	appendTestLane(t, ctx, remoteStore, remoteSigner, ref, "Remote divergent checkpoint.")
	remoteSocket, stopRemote := serveTestServer(t, ctx, remoteStore)
	defer stopRemote()

	localStore := openTestStore(t, ctx)
	defer localStore.Close()
	localBootstrap := localSigner.signBlock(t, TaskBlock{
		Version:    TaskBlockVersion,
		ProjectID:  ref.ProjectID,
		TaskID:     ref.TaskID,
		LaneID:     ref.LaneID,
		Kind:       "bootstrap",
		ParentTips: []string{},
		NodeID:     localSigner.nodeID,
		ActorID:    localSigner.actorID,
		LeaseEpoch: 0,
		CreatedAt:  "2026-07-03T22:10:00.000Z",
		Payload: map[string]any{
			"summary": "Local divergent bootstrap.",
		},
	})
	if result, err := localStore.AppendBlock(ctx, localBootstrap, ""); err != nil || !result.Accepted {
		t.Fatalf("local bootstrap append failed: result=%+v err=%v", result, err)
	}
	localSocket, stopLocal := serveTestServer(t, ctx, localStore)
	defer stopLocal()

	var syncResult PeerSyncResult
	callTestRPC(t, localSocket, "peer.sync", PeerSyncInput{ProjectID: ref.ProjectID, TaskID: ref.TaskID, LaneID: ref.LaneID, Peers: []string{"unix://" + remoteSocket}}, &syncResult)

	if syncResult.FetchedBlocks != 3 || syncResult.InsertedBlocks != 0 || syncResult.RejectedBlocks != 3 {
		t.Fatalf("unexpected divergent sync result: %+v", syncResult)
	}
	if syncResult.FinalTip != localBootstrap.BlockID {
		t.Fatalf("final tip = %s, want local tip %s", syncResult.FinalTip, localBootstrap.BlockID)
	}
	if len(syncResult.Peers) != 1 || len(syncResult.Peers[0].Rejected) != 3 {
		t.Fatalf("expected per-block rejections, got %+v", syncResult.Peers)
	}
}

func serveTestReadOnlyTCPPeer(t *testing.T, parent context.Context, store *SQLiteStore) (string, func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(parent)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(store)
	errCh := make(chan error, 1)
	go func() {
		errCh <- server.serveListener(ctx, listener, true)
	}()
	return listener.Addr().String(), func() {
		cancel()
		select {
		case err := <-errCh:
			if err != nil {
				t.Fatalf("tcp peer stopped with error: %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("tcp peer did not stop after context cancellation")
		}
	}
}

func appendTestLane(t *testing.T, ctx context.Context, store *SQLiteStore, signer testSigner, ref LaneRef, progress string) (TaskBlock, TaskBlock) {
	t.Helper()
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
		CreatedAt:  "2026-07-03T22:00:00.000Z",
		Payload: map[string]any{
			"summary": "Peer bootstrap.",
		},
	})
	if result, err := store.AppendBlock(ctx, bootstrap, ""); err != nil || !result.Accepted {
		t.Fatalf("bootstrap append failed: result=%+v err=%v", result, err)
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
		CreatedAt:  "2026-07-03T22:01:00.000Z",
		Payload: map[string]any{
			"leaseUntil": "2026-07-03T22:20:00.000Z",
		},
	})
	if result, err := store.AppendBlock(ctx, claim, ""); err != nil || !result.Accepted {
		t.Fatalf("claim append failed: result=%+v err=%v", result, err)
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
		CreatedAt:  "2026-07-03T22:02:00.000Z",
		Payload: map[string]any{
			"status":   "in_progress",
			"progress": progress,
		},
	})
	if result, err := store.AppendBlock(ctx, checkpoint, ""); err != nil || !result.Accepted {
		t.Fatalf("checkpoint append failed: result=%+v err=%v", result, err)
	}
	return bootstrap, checkpoint
}

func openTestStore(t *testing.T, ctx context.Context) *SQLiteStore {
	t.Helper()
	store, err := OpenSQLiteStore(ctx, filepath.Join(t.TempDir(), "continuity.db"))
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func serveTestServer(t *testing.T, parent context.Context, store *SQLiteStore) (string, func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(parent)
	socketPath := filepath.Join(os.TempDir(), "continuityd-"+strconv.FormatInt(time.Now().UnixNano(), 10)+".sock")
	server := NewServer(store)
	errCh := make(chan error, 1)
	go func() {
		errCh <- server.ServeUnix(ctx, socketPath)
	}()
	waitForSocket(t, socketPath)
	return socketPath, func() {
		cancel()
		select {
		case err := <-errCh:
			if err != nil {
				t.Fatalf("server stopped with error: %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("server did not stop after context cancellation")
		}
		_ = os.Remove(socketPath)
	}
}

func callTestRPC(t *testing.T, socketPath string, method string, params any, target any) {
	t.Helper()
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	if err := json.NewEncoder(conn).Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      "test-call",
		"method":  method,
		"params":  params,
	}); err != nil {
		t.Fatal(err)
	}
	var response peerRPCResponse
	if err := json.NewDecoder(conn).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.Error != nil {
		t.Fatalf("rpc %s returned error: %+v", method, response.Error)
	}
	if err := json.Unmarshal(response.Result, target); err != nil {
		t.Fatal(err)
	}
}
