package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"tmatrix/internal/backend"
	"tmatrix/internal/config"
)

func drainingService(t *testing.T) (*Service, <-chan struct{}) {
	t.Helper()
	s, err := New(filepath.Join(t.TempDir(), "private"), "")
	if err != nil {
		t.Fatal(err)
	}
	requested := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/shutdown" || r.Method != http.MethodPost {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(400)
			return
		}
		requested <- struct{}{}
		w.WriteHeader(202)
	}))
	t.Cleanup(server.Close)
	data, _ := json.Marshal(map[string]any{"version": 1, "url": server.URL, "token": "test-control-token", "pid": os.Getpid()})
	if err := os.WriteFile(config.DiscoveryPath(s.Dir), data, 0600); err != nil {
		t.Fatal(err)
	}
	return s, requested
}

func TestConnectionDrainWaitsForWorkers(t *testing.T) {
	s, requested := drainingService(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.drainConnection(ctx) }()
	select {
	case <-requested:
	case <-ctx.Done():
		t.Fatal("shutdown was not requested")
	}
	// The bridge remains present while admitted workers finish.
	select {
	case err := <-done:
		t.Fatalf("drain returned before workers finished: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err := os.Remove(config.DiscoveryPath(s.Dir)); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestCancelledConnectionPreservesCredentials(t *testing.T) {
	s, requested := drainingService(t)
	if err := config.SaveAPIKey(s.Dir, "original-fixture"); err != nil {
		t.Fatal(err)
	}
	before, _ := config.Load(s.Dir)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- s.Connect(ctx, backend.Connection{URL: "https://replacement.invalid/api/v1/ai/poll", APIKey: "replacement-fixture"})
	}()
	select {
	case <-requested:
	case <-time.After(3 * time.Second):
		t.Fatal("shutdown was not requested")
	}
	key, err := config.LoadAPIKey(s.Dir)
	if err != nil || key != "original-fixture" {
		t.Fatal("credentials changed during drain")
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation: %v", err)
	}
	after, _ := config.Load(s.Dir)
	key, err = config.LoadAPIKey(s.Dir)
	if err != nil || key != "original-fixture" || before != after {
		t.Fatal("cancelled drain changed connection")
	}
}
