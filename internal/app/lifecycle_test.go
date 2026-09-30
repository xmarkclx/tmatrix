package app

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"tmatrix/internal/backend"
	"tmatrix/internal/config"
)

// The optional integration runs the actual compiled engine with a fresh private
// identity, reserved .invalid endpoints, and fake credentials.
func TestActualEngineConnectionLifecycle(t *testing.T) {
	engine := os.Getenv("TMATRIX_TEST_ENGINE_DIR")
	if engine == "" {
		t.Skip("set TMATRIX_TEST_ENGINE_DIR to the isolated staged engine")
	}
	dir := filepath.Join(t.TempDir(), "private")
	service, err := New(dir, engine)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	if err := service.Connect(ctx, backend.Connection{URL: "https://tmatrix-test.invalid/api/v1/ai/poll", APIKey: "offline-test-fixture"}); err != nil {
		t.Fatal(err)
	}
	defer service.Shutdown(context.Background())
	first, err := service.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if first.IntakePaused || first.RunningWorkers != 0 {
		t.Fatalf("intake did not start: %+v", first)
	}
	if err := service.Start(ctx); err != nil {
		t.Fatal(err)
	}
	// Saving a replacement key must restart an idle connected engine safely.
	if err := service.Connect(ctx, backend.Connection{URL: "https://replacement.invalid/api/v1/ai/poll", APIKey: "replacement-test-fixture"}); err != nil {
		t.Fatal(err)
	}
	reconnected, err := service.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if reconnected.IntakePaused || reconnected.Poller.URL != "https://replacement.invalid/api/v1/ai/poll" || reconnected.InstanceID != first.InstanceID {
		t.Fatal("connection replacement did not restart safely")
	}
	key, err := config.LoadAPIKey(dir)
	if err != nil || key != "replacement-test-fixture" {
		t.Fatal("replacement credential was not saved")
	}
	paused := true
	maxWorkers, interval := 7, 120000
	workerType, pollerType := "codex", "tzudo"
	if err := service.Configure(ctx, backend.Settings{IntakePaused: &paused, MaxWorkers: &maxWorkers, PollIntervalMS: &interval, WorkerType: &workerType, PollerType: &pollerType}); err != nil {
		t.Fatal(err)
	}
	changed, err := service.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if changed.MaxWorkers != 7 || changed.PollIntervalMS != 120000 || changed.InstanceID != first.InstanceID {
		t.Fatal("live settings or idempotent start failed")
	}
	// Explicit restart must replace the process while preserving paused intake.
	beforeRestart, err := os.ReadFile(config.DiscoveryPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Restart(ctx); err != nil {
		t.Fatal(err)
	}
	afterRestart, err := os.ReadFile(config.DiscoveryPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	if string(beforeRestart) == string(afterRestart) {
		t.Fatal("restart reused old engine")
	}
	state, err := service.Snapshot(ctx)
	if err != nil || !state.IntakePaused || state.MaxWorkers != 7 || state.PollIntervalMS != interval || state.InstanceID != first.InstanceID {
		t.Fatalf("restart lost saved settings: %v", err)
	}
	if err := service.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(config.DiscoveryPath(dir)); os.IsNotExist(err) {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("engine did not remove its discovery record")
		case <-time.After(20 * time.Millisecond):
		}
	}
	// Restart checks persisted settings and a >60s poll interval at bootstrap.
	if err := service.Start(ctx); err != nil {
		t.Fatal(err)
	}
	restarted, err := service.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !restarted.IntakePaused || restarted.Poller.LastPollAt != "" || restarted.PollIntervalMS != interval {
		t.Fatal("restart did not restore safe settings")
	}
	if err := service.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(config.DiscoveryPath(dir)); os.IsNotExist(err) {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("restarted engine did not exit")
		case <-time.After(20 * time.Millisecond):
		}
	}
}

func TestActualForegroundDaemonLifecycle(t *testing.T) {
	engine := os.Getenv("TMATRIX_TEST_ENGINE_DIR")
	if engine == "" {
		t.Skip("set TMATRIX_TEST_ENGINE_DIR")
	}
	dir := filepath.Join(t.TempDir(), "private")
	service, err := New(dir, engine)
	if err != nil {
		t.Fatal(err)
	}
	if err := config.SaveAPIKey(dir, "offline-test-fixture"); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	cfg.PollURL = "https://tmatrix-test.invalid/api/v1/ai/poll"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- RunDaemon(ctx, dir, cfg) }()
	deadline := time.After(20 * time.Second)
	for {
		snapshot, err := service.Snapshot(context.Background())
		if err == nil && snapshot.Poller.Status == "paused" {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("daemon exited before readiness: %v", err)
		case <-deadline:
			t.Fatal("daemon never became ready")
		case <-time.After(25 * time.Millisecond):
		}
	}
	// A second foreground supervisor must not adopt an unrelated child.
	// Wait for the readiness path to release the startup lock first.
	for {
		if _, err := os.Stat(filepath.Join(dir, "start.lock")); os.IsNotExist(err) {
			break
		}
		select {
		case <-deadline:
			t.Fatal("startup lock retained")
		case <-time.After(10 * time.Millisecond):
		}
	}
	if err := RunDaemon(context.Background(), dir, cfg); err == nil {
		t.Fatal("adopted existing daemon")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("daemon did not drain")
	}
	if _, err := os.Stat(config.DiscoveryPath(dir)); !os.IsNotExist(err) {
		t.Fatal("discovery survived shutdown")
	}
}
