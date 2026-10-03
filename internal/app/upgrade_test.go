package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tmatrix/internal/backend"
)

func TestUpgradeDefersWithoutChangingBusyEngine(t *testing.T) {
	dir := t.TempDir()
	var actions int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			actions++
			t.Errorf("busy engine received %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"version":1,"max_workers":50,"running_workers":2,"intake_paused":false}`))
	}))
	defer server.Close()
	writeUpgradeDiscovery(t, dir, server.URL)
	for _, check := range []func(context.Context, string) error{CheckUpgradeIdle, PrepareUpgrade} {
		if err := check(context.Background(), dir); !errors.Is(err, backend.ErrUpgradeBusy) {
			t.Fatalf("got %v", err)
		}
	}
	if err := (&Service{Dir: dir}).SetupService(); !errors.Is(err, backend.ErrUpgradeBusy) {
		t.Fatalf("setup got %v", err)
	}
	if actions != 0 {
		t.Fatal("busy engine was changed")
	}
	if _, err := os.Stat(filepath.Join(dir, "install-service-on-connect")); !os.IsNotExist(err) {
		t.Fatal("busy setup wrote a marker")
	}
}

func TestUpgradeRechecksAdmissionAtomically(t *testing.T) {
	for _, tc := range []struct {
		status  int
		message string
	}{{409, "workers are active"}, {400, "does not support idle-only"}} {
		t.Run(tc.message, func(t *testing.T) {
			dir := t.TempDir()
			var requests int
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.Method == http.MethodGet {
					w.Write([]byte(`{"version":1,"max_workers":50,"running_workers":0}`))
					return
				}
				requests++
				var body map[string]bool
				json.NewDecoder(r.Body).Decode(&body)
				if r.URL.Path != "/v1/shutdown" || len(body) != 1 || !body["only_if_idle"] {
					t.Error("unguarded shutdown")
				}
				w.WriteHeader(tc.status)
			}))
			defer server.Close()
			writeUpgradeDiscovery(t, dir, server.URL)
			if err := PrepareUpgrade(context.Background(), dir); err == nil || !strings.Contains(err.Error(), tc.message) {
				t.Fatalf("got %v", err)
			}
			if requests != 1 {
				t.Fatal("retried using an unguarded shutdown")
			}
		})
	}
}

func TestUpgradeWaitsForIdleEngineExit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bridge.json")
	shutdown := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost {
			shutdown <- struct{}{}
			w.WriteHeader(202)
			w.Write([]byte(`{"status":"shutting_down"}`))
			return
		}
		w.Write([]byte(`{"version":1,"max_workers":50,"running_workers":0}`))
	}))
	defer server.Close()
	writeUpgradeDiscovery(t, dir, server.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- PrepareUpgrade(ctx, dir) }()
	select {
	case <-shutdown:
	case <-ctx.Done():
		t.Fatal("shutdown not requested")
	}
	select {
	case err := <-done:
		t.Fatalf("proceeded before engine exit: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("engine exit not observed")
	}
}

func TestUpgradeDefersWhenEngineStateCannotBeVerified(t *testing.T) {
	dir := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer server.Close()
	writeUpgradeDiscovery(t, dir, server.URL)
	if err := PrepareUpgrade(context.Background(), dir); err == nil {
		t.Fatal("unknown live engine allowed")
	}
	if err := PrepareUpgrade(context.Background(), t.TempDir()); err != nil {
		t.Fatal("first install rejected", err)
	}
}

func writeUpgradeDiscovery(t *testing.T, dir, url string) {
	t.Helper()
	data, _ := json.Marshal(map[string]any{"version": 1, "pid": os.Getpid(), "url": url, "token": "fictional-private-bridge-token"})
	if err := os.WriteFile(filepath.Join(dir, "bridge.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
}
