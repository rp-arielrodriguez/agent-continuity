package continuityd

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestServerJSONRPCHealthAndEmptyLaneStatus(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	dir := t.TempDir()
	store, err := OpenSQLiteStore(ctx, filepath.Join(dir, "continuity.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	socketPath := filepath.Join(os.TempDir(), "continuityd-"+strconv.FormatInt(time.Now().UnixNano(), 10)+".sock")
	defer os.Remove(socketPath)
	server := NewServer(store)
	errCh := make(chan error, 1)
	go func() {
		errCh <- server.ServeUnix(ctx, socketPath)
	}()
	waitForSocket(t, socketPath)

	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	encoder := json.NewEncoder(conn)
	decoder := json.NewDecoder(conn)

	if err := encoder.Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      "health-1",
		"method":  "daemon.health",
	}); err != nil {
		t.Fatal(err)
	}
	var health rpcResponse
	if err := decoder.Decode(&health); err != nil {
		t.Fatal(err)
	}
	if health.Error != nil {
		t.Fatalf("health returned error: %+v", health.Error)
	}
	result := health.Result.(map[string]any)
	if result["provider"] != "continuityd" || result["ok"] != true {
		t.Fatalf("unexpected health result: %+v", result)
	}

	if err := encoder.Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      "status-1",
		"method":  "lane.status",
		"params": map[string]any{
			"projectId": "rp-arielrodriguez/agent-continuity",
			"taskId":    "agent-continuity-decentralized-runtime",
			"laneId":    "main",
		},
	}); err != nil {
		t.Fatal(err)
	}
	var status rpcResponse
	if err := decoder.Decode(&status); err != nil {
		t.Fatal(err)
	}
	if status.Error != nil {
		t.Fatalf("status returned error: %+v", status.Error)
	}
	statusResult := status.Result.(map[string]any)
	if statusResult["action"] != "continue" {
		t.Fatalf("unexpected status result: %+v", statusResult)
	}

	cancel()
	select {
	case err := <-errCh:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("server did not stop after context cancellation")
	}
}

func waitForSocket(t *testing.T, socketPath string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.Dial("unix", socketPath)
		if err == nil {
			_ = conn.Close()
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("socket %s was not ready", socketPath)
}
