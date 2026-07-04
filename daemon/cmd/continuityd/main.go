package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/rp-arielrodriguez/agent-continuity/daemon/internal/continuityd"
)

func main() {
	socketPath := flag.String("socket", defaultSocketPath(), "Unix socket path for JSON-RPC")
	dbPath := flag.String("db", defaultDBPath(), "SQLite database path")
	peerListen := flag.String("peer-listen", "", "Optional read-only TCP peer listener address, for example 100.64.1.2:9987")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := os.MkdirAll(filepath.Dir(*socketPath), 0o755); err != nil {
		exit(fmt.Errorf("create socket directory: %w", err))
	}
	if err := os.MkdirAll(filepath.Dir(*dbPath), 0o755); err != nil {
		exit(fmt.Errorf("create database directory: %w", err))
	}

	store, err := continuityd.OpenSQLiteStore(ctx, *dbPath)
	if err != nil {
		exit(err)
	}
	defer store.Close()

	server := continuityd.NewServer(store)
	if *peerListen != "" {
		go func() {
			if err := server.ServeReadOnlyTCP(ctx, *peerListen); err != nil && ctx.Err() == nil {
				exit(err)
			}
		}()
	}
	if err := server.ServeUnix(ctx, *socketPath); err != nil {
		exit(err)
	}
}

func defaultSocketPath() string {
	if value := os.Getenv("CONTINUITYD_SOCKET"); value != "" {
		return value
	}
	return filepath.Join(defaultStateDir(), "continuityd.sock")
}

func defaultDBPath() string {
	if value := os.Getenv("CONTINUITYD_DB"); value != "" {
		return value
	}
	return filepath.Join(defaultStateDir(), "continuity.db")
}

func defaultStateDir() string {
	if value := os.Getenv("CONTINUITYD_STATE_DIR"); value != "" {
		return value
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".local", "state", "agent-continuity")
	}
	return "."
}

func exit(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
