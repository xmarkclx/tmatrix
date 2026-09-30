package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestServiceStartWaitsForDrain(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bridge.json")
	shutdown := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/shutdown" {
			shutdown <- struct{}{}
			w.WriteHeader(http.StatusAccepted)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":1,"max_workers":1,"running_workers":0}`))
	}))
	defer server.Close()
	record, _ := json.Marshal(map[string]any{"version": 1, "pid": os.Getpid(), "url": server.URL, "token": "test-token-for-local-engine"})
	if err := os.WriteFile(path, record, 0600); err != nil {
		t.Fatal(err)
	}
	calls := make(chan string, 4)
	control := func(args ...string) error {
		calls <- args[0]
		if args[0] == "start" {
			return os.WriteFile(path, record, 0600)
		}
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- startInstalledService(ctx, dir, control) }()
	if got := <-calls; got != "stop" {
		t.Fatalf("first action = %s", got)
	}
	select {
	case <-shutdown:
	case <-ctx.Done():
		t.Fatal("shutdown not requested")
	}
	// A shutdown acknowledgement is not drain completion. The discovery file
	// remains until active work and its result delivery have finished.
	select {
	case got := <-calls:
		t.Fatalf("started before drain completed: %s", got)
	case err := <-done:
		t.Fatalf("returned before drain completed: %v", err)
	case <-time.After(150 * time.Millisecond):
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
		t.Fatal("start never completed")
	}
	if got := <-calls; got != "start" {
		t.Fatalf("next action = %s", got)
	}
}

func TestServiceStartFailsClosed(t *testing.T) {
	for _, scenario := range []string{"stop fails", "invalid discovery", "start fails", "not ready"} {
		t.Run(scenario, func(t *testing.T) {
			dir := t.TempDir()
			if scenario == "invalid discovery" {
				if err := os.WriteFile(filepath.Join(dir, "bridge.json"), []byte("invalid"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			var calls []string
			control := func(args ...string) error {
				calls = append(calls, args[0])
				if (scenario == "stop fails" && args[0] == "stop") || (scenario == "start fails" && args[0] == "start") {
					return errors.New("systemd failure")
				}
				return nil
			}
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			if err := startInstalledService(ctx, dir, control); err == nil {
				t.Fatal("reported success")
			}
			want := []string{"stop"}
			if scenario == "start fails" || scenario == "not ready" {
				want = append(want, "start")
			}
			if !reflect.DeepEqual(calls, want) {
				t.Fatalf("commands = %v, want %v", calls, want)
			}
		})
	}
}
