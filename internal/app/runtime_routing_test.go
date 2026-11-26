package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"tmatrix/internal/backend"
	"tmatrix/internal/config"
)

func TestSavedRoutingPolicyIsDroppedOnNextSave(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "private")
	service, err := New(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	legacy, _ := json.Marshal(map[string]any{"version": 2, "max_workers": 3, "poll_interval_ms": 5000, "engine_dir": "", "worker_type": "codex",
		"runtime_policy": "codex-only", "instance_id": config.NewID(), "update_origin": "https://tzudo.app", "sources": []any{}})
	if err := os.WriteFile(filepath.Join(dir, config.ConfigFilename), legacy, 0600); err != nil {
		t.Fatal(err)
	}
	maximum := 5
	if err := service.Configure(context.Background(), backend.Settings{MaxWorkers: &maximum}); err != nil {
		t.Fatal(err)
	}
	saved, err := os.ReadFile(filepath.Join(dir, config.ConfigFilename))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(saved), "runtime_policy") || !strings.Contains(string(saved), `"max_workers": 5`) {
		t.Fatalf("legacy routing policy was kept or settings were not saved: %s", saved)
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
