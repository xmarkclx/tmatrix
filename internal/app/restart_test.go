package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"tmatrix/internal/config"
)

func TestRestartWaitsAndCancellationPreservesSettings(t *testing.T) {
	s, requested := drainingService(t)
	if err := config.SaveAPIKey(s.Dir, "restart-fixture"); err != nil {
		t.Fatal(err)
	}
	before, err := config.Load(s.Dir)
	if err != nil {
		t.Fatal(err)
	}
	discovery, err := os.ReadFile(config.DiscoveryPath(s.Dir))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.Restart(ctx) }()
	select {
	case <-requested:
	case <-time.After(3 * time.Second):
		t.Fatal("restart did not request drain")
	}
	select {
	case err := <-done:
		t.Fatalf("restart did not wait for workers: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	other := &Service{Dir: s.Dir}
	if !other.restartPending() {
		t.Fatal("restart intent not visible to another console")
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation: %v", err)
	}
	if s.restartPending() {
		t.Fatal("cancelled restart still pending")
	}
	after, err := config.Load(s.Dir)
	if err != nil || before != after {
		t.Fatal("restart changed saved settings")
	}
	key, err := config.LoadAPIKey(s.Dir)
	if err != nil || key != "restart-fixture" {
		t.Fatal("restart changed credentials")
	}
	remaining, err := os.ReadFile(config.DiscoveryPath(s.Dir))
	if err != nil || string(remaining) != string(discovery) {
		t.Fatal("restart replaced draining engine")
	}
}

func TestRestartRefusesUnverifiedEngine(t *testing.T) {
	s, err := New(t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.DiscoveryPath(s.Dir), []byte("invalid discovery"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.Restart(context.Background()); err == nil {
		t.Fatal("restart accepted unverified engine")
	}
}

func TestStaleRestartHeartbeatExpires(t *testing.T) {
	s := &Service{Dir: t.TempDir()}
	path := filepath.Join(s.Dir, "restart-pending-stale")
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Minute)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	if s.restartPending() {
		t.Fatal("stale restart shown as pending")
	}
}

func TestRestartStatusSurvivesMissingAndUnreadableBridge(t *testing.T) {
	s, err := New(filepath.Join(t.TempDir(), "private"), "")
	if err != nil {
		t.Fatal(err)
	}
	finish, err := s.trackRestart()
	if err != nil {
		t.Fatal(err)
	}
	defer finish()
	other := &Service{Dir: s.Dir}
	snapshot, err := other.Snapshot(context.Background())
	if err != nil || !snapshot.RestartPending {
		t.Fatal("missing bridge hid restart")
	}
	if err := os.WriteFile(config.DiscoveryPath(s.Dir), []byte("invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	snapshot, err = other.Snapshot(context.Background())
	if err == nil || !snapshot.RestartPending {
		t.Fatal("bridge error hid restart")
	}
}
