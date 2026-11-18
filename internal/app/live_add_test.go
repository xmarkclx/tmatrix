package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"tmatrix/internal/backend"
	"tmatrix/internal/config"
)

func TestAddSourceWhileEngineHasActiveWork(t *testing.T) {
	s, err := New(filepath.Join(t.TempDir(), "private"), sourceEngineFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	before := saveFixtureSource(t, s, "https://original.invalid/poll", "original-fixture")
	original := backend.Poller{ID: "legacy", Name: "TzuDo", URL: before.Sources[0].PollURL, Status: "connected"}
	added := make(chan backend.Poller, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/snapshot":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"version": 2, "live_source_add": true, "max_workers": 3, "running_workers": 1,
				"pollers": []backend.Poller{original}, "intake_paused": false,
			})
		case "/v1/sources/add":
			var input struct{ ID string }
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				http.Error(w, "bad request", 400)
				return
			}
			cfg, err := config.Load(s.Dir)
			if err != nil || len(cfg.Sources) != 2 || cfg.Sources[1].ID != input.ID {
				http.Error(w, "source not persisted", 400)
				return
			}
			key, err := config.LoadSourceKey(s.Dir, cfg.Sources[1].CredentialID)
			if err != nil || key != "new-fixture" {
				http.Error(w, "credential not persisted", 400)
				return
			}
			added <- backend.Poller{ID: input.ID, Name: cfg.Sources[1].Name, URL: cfg.Sources[1].PollURL}
			_ = json.NewEncoder(w).Encode(input)
		default:
			t.Errorf("adding a source must not call %s while the first worker is running", r.URL.Path)
			w.WriteHeader(409)
		}
	}))
	defer server.Close()
	writeUpgradeDiscovery(t, s.Dir, server.URL)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	endpoint := "https://new.invalid/chat/poll"
	if err := s.Connect(ctx, backend.Connection{Name: "MindSpace", URL: endpoint, APIKey: "new-fixture"}); err != nil {
		t.Fatal(err)
	}
	select {
	case source := <-added:
		if source.Name != "MindSpace" || source.URL != endpoint {
			t.Fatalf("unexpected source: %+v", source)
		}
	default:
		t.Fatal("source was not attached to the running engine")
	}
	after, err := config.Load(s.Dir)
	if err != nil || len(after.Sources) != 2 || after.Sources[0] != before.Sources[0] || after.ResumeIntake != before.ResumeIntake {
		t.Fatal("adding the source changed the existing connection or intake preference")
	}
}

func TestAddSourceCanRetryAfterPersisting(t *testing.T) {
	s, err := New(filepath.Join(t.TempDir(), "private"), sourceEngineFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	before := saveFixtureSource(t, s, "https://original.invalid/poll", "original-fixture")
	attempts := make(chan string, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/snapshot" {
			pollers := []backend.Poller{{ID: "legacy", URL: before.Sources[0].PollURL, Status: "connected"}}
			_ = json.NewEncoder(w).Encode(backend.Snapshot{Version: 2, LiveSourceAdd: true, MaxWorkers: 3, Pollers: pollers})
			return
		}
		if r.URL.Path != "/v1/sources/add" {
			t.Errorf("unexpected request: %s", r.URL.Path)
			w.WriteHeader(409)
			return
		}
		var input struct{ ID string }
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			http.Error(w, "bad request", 400)
			return
		}
		attempts <- input.ID
		if len(attempts) == 1 {
			w.WriteHeader(503)
			return
		}
		_ = json.NewEncoder(w).Encode(input)
	}))
	defer server.Close()
	writeUpgradeDiscovery(t, s.Dir, server.URL)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	connection := backend.Connection{Name: "MindSpace", URL: "https://new.invalid/chat/poll", APIKey: "new-fixture"}
	if err := s.Connect(ctx, connection); !errors.Is(err, errSourceSaved) {
		t.Fatalf("expected saved-source recovery message: %v", err)
	}
	saved, err := config.Load(s.Dir)
	if err != nil || len(saved.Sources) != 2 {
		t.Fatalf("source did not survive an activation failure: %v", err)
	}
	if err := s.Connect(ctx, connection); err != nil {
		t.Fatal(err)
	}
	after, err := config.Load(s.Dir)
	if err != nil || len(after.Sources) != 2 || after.Sources[1] != saved.Sources[1] {
		t.Fatal("retry replaced or duplicated the saved source")
	}
	if len(attempts) != 2 || <-attempts != saved.Sources[1].ID || <-attempts != saved.Sources[1].ID {
		t.Fatal("retry did not attach the same source identity")
	}
}
