package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"tmatrix/internal/backend"
	"tmatrix/internal/config"
)

func TestRuntimeRoutingSavesAndUpdatesConnectedEngine(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "private")
	service, err := New(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	snapshot, err := service.Snapshot(ctx)
	if err != nil || snapshot.RuntimePolicy != "subscriptions-first" {
		t.Fatalf("default routing policy was not applied: %q, %v", snapshot.RuntimePolicy, err)
	}
	requests := make(chan backend.Settings, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var settings backend.Settings
		if r.Method != http.MethodPost || r.URL.Path != "/v1/settings" || r.Header.Get("Authorization") != "Bearer fictional-policy-token" || json.NewDecoder(r.Body).Decode(&settings) != nil {
			t.Error("routing policy did not use the authenticated settings action")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		requests <- settings
		if settings.RuntimePolicy != nil && *settings.RuntimePolicy == "codex-only" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	discovery, _ := json.Marshal(map[string]any{"version": 1, "url": server.URL, "token": "fictional-policy-token", "pid": os.Getpid()})
	if err := os.WriteFile(config.DiscoveryPath(dir), discovery, 0600); err != nil {
		t.Fatal(err)
	}

	policy := config.SubscriptionsOnly
	if err := service.Configure(ctx, backend.Settings{RuntimePolicy: &policy}); err != nil {
		t.Fatal(err)
	}
	if sent := <-requests; sent.RuntimePolicy == nil || *sent.RuntimePolicy != "subscriptions-only" {
		t.Fatalf("engine did not receive subscriptions-only: %+v", sent.RuntimePolicy)
	}
	rejected := config.CodexOnly
	if err := service.Configure(ctx, backend.Settings{RuntimePolicy: &rejected}); err == nil {
		t.Fatal("reported a rejected policy as saved")
	}
	if sent := <-requests; sent.RuntimePolicy == nil || *sent.RuntimePolicy != "codex-only" {
		t.Fatalf("engine did not receive codex-only: %+v", sent.RuntimePolicy)
	}
	cfg, err := config.Load(dir)
	if err != nil || cfg.RuntimePolicy != "subscriptions-only" {
		t.Fatalf("did not preserve the last accepted policy: %q, %v", cfg.RuntimePolicy, err)
	}
}

func TestRuntimeRoutingRejectsAnEngineThatCannotApplyTheSavedPolicy(t *testing.T) {
	cfg := config.Default()
	cfg.EngineDir = sourceEngineFixture(t)
	if err := os.Remove(filepath.Join(cfg.EngineDir, "dist", "runtime-routing.js")); err != nil {
		t.Fatal(err)
	}
	if _, err := sourceEngine(cfg); err == nil || !strings.Contains(err.Error(), "engine update needed for runtime routing") {
		t.Fatalf("unsafe legacy engine was accepted: %v", err)
	}
	if err := os.WriteFile(filepath.Join(cfg.EngineDir, "dist", "runtime-routing.js"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if selected, err := sourceEngine(cfg); err != nil || selected != cfg.EngineDir {
		t.Fatalf("routing-enabled engine was rejected: %q, %v", selected, err)
	}
}
