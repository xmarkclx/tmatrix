package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"tmatrix/internal/backend"
	"tmatrix/internal/config"
)

func TestBusyUpgradeDoesNotPersistReplacementEngine(t *testing.T) {
	for _, command := range [][]string{{"setup"}, {"service", "install"}, {"upgrade", "prepare"}} {
		t.Run(command[0], func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "private")
			cfg := config.Default()
			cfg.EngineDir = "previous-engine"
			if err := config.Save(dir, cfg); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(dir, "config.json")
			before, _ := os.ReadFile(path)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					t.Error("busy upgrade changed engine state")
				}
				w.Header().Set("Content-Type", "application/json")
				w.Write([]byte(`{"version":1,"max_workers":50,"running_workers":2}`))
			}))
			defer server.Close()
			data, _ := json.Marshal(map[string]any{"version": 1, "pid": os.Getpid(), "url": server.URL, "token": "fictional-upgrade-test-token"})
			if err := os.WriteFile(filepath.Join(dir, "bridge.json"), data, 0600); err != nil {
				t.Fatal(err)
			}
			args := append([]string{"--config-dir", dir, "--engine-dir", "/replacement-engine"}, command...)
			if err := run(args); !errors.Is(err, backend.ErrUpgradeBusy) {
				t.Fatalf("got %v", err)
			}
			after, _ := os.ReadFile(path)
			if !bytes.Equal(before, after) {
				t.Fatal("settings changed despite active workers")
			}
		})
	}
}
