package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
)

const testBridgeToken = "fictional-bridge-token-for-tests"

func discoveryFile(t *testing.T, address string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "bridge.json")
	data, err := json.Marshal(discovery{Version: 1, URL: address, Token: testBridgeToken, PID: os.Getpid()})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestHTTPActionsAndQueuedAcknowledgement(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer "+testBridgeToken {
			t.Error("missing bridge authorization")
		}
		switch r.URL.Path {
		case "/v1/snapshot":
			if r.Method != http.MethodGet {
				t.Error("snapshot changed state")
			}
			fmt.Fprint(w, `{"version":1,"max_workers":3,"running_workers":1,"workers":[{"id":"worker-1","status":"running","input_revision":7,"thread_id":"fictional-thread","run_kind":"resumed"}]}`)
		case "/v1/settings":
			var values map[string]any
			if err := json.NewDecoder(r.Body).Decode(&values); err != nil {
				t.Error(err)
			}
			if len(values) != 1 || values["max_workers"] != float64(5) {
				t.Error("settings overwrote omitted values or sent unsupported adapter fields")
			}
			w.WriteHeader(http.StatusNoContent)
		case "/v1/workers/worker-1/steer":
			var values map[string]string
			if err := json.NewDecoder(r.Body).Decode(&values); err != nil {
				t.Error(err)
			}
			if values["message"] != "Please focus on keyboard access" || values["request_id"] == "" {
				t.Error("steering lost message or idempotency ID")
			}
			fmt.Fprint(w, `{"id":"message-1","status":"queued"}`)
		case "/v1/workers/worker-1/pin":
			var values map[string]bool
			if err := json.NewDecoder(r.Body).Decode(&values); err != nil {
				t.Error(err)
			}
			if r.Method != http.MethodPost || len(values) != 1 {
				t.Error("invalid pin request")
			}
			if _, ok := values["pinned"]; !ok {
				t.Error("pin boolean omitted")
			}
			w.WriteHeader(http.StatusOK)
		case "/v1/workers/worker-1/stop", "/v1/shutdown":
			w.WriteHeader(http.StatusAccepted)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	client, err := NewHTTP(discoveryFile(t, server.URL))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	snapshot, err := client.Snapshot(ctx)
	if err != nil || snapshot.Workers[0].InputRevision != 7 || snapshot.Workers[0].RunKind != "resumed" || snapshot.Workers[0].ThreadID != "fictional-thread" {
		t.Fatalf("snapshot failed: %v", err)
	}
	max, kind := 5, "codex"
	if err := client.Configure(ctx, Settings{MaxWorkers: &max, WorkerType: &kind}); err != nil {
		t.Fatal(err)
	}
	message, err := client.Steer(ctx, "worker-1", "Please focus on keyboard access")
	if err != nil || message.Status != "queued" {
		t.Fatalf("steering did not preserve queued state: %v", err)
	}
	if err := client.Stop(ctx, "worker-1"); err != nil {
		t.Fatal(err)
	}
	if err := client.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	for _, pinned := range []bool{true, false} {
		if err := client.Pin(ctx, "worker-1", pinned); err != nil {
			t.Fatal(err)
		}
	}
	if err := client.Pin(ctx, "../invalid", true); err == nil {
		t.Fatal("invalid worker ID accepted")
	}
	if calls.Load() != 7 {
		t.Fatalf("unexpected request count: %d", calls.Load())
	}
}

func TestBridgeNeverFollowsRedirectsOrExposesErrors(t *testing.T) {
	var targetCalls atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { targetCalls.Add(1) }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/snapshot" {
			http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprint(w, "private task content and "+testBridgeToken)
	}))
	defer server.Close()
	client, err := NewHTTP(discoveryFile(t, server.URL))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Snapshot(context.Background()); err == nil || targetCalls.Load() != 0 {
		t.Fatal("bridge followed redirect")
	}
	err = client.Stop(context.Background(), "worker-1")
	if err == nil || strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), testBridgeToken) {
		t.Fatal("raw backend error exposed private data")
	}
}

func TestHTTPInitialPromptAndOlderSnapshotCompatibility(t *testing.T) {
	for _, payload := range []string{
		`{"version":1,"max_workers":3,"workers":[{"id":"worker-1"}]}`,
		`{"version":1,"max_workers":3,"workers":[{"id":"worker-1","initial_prompt":{"text":"Fictional input","at":"2026-09-29T10:00:00Z","input_revision":2,"truncated":true,"redacted":true}}]}`,
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, payload) }))
		client, err := NewHTTP(discoveryFile(t, server.URL))
		if err != nil {
			server.Close()
			t.Fatal(err)
		}
		snapshot, err := client.Snapshot(context.Background())
		server.Close()
		if err != nil {
			t.Fatal(err)
		}
		prompt := snapshot.Workers[0].InitialPrompt
		if strings.Contains(payload, "initial_prompt") {
			if prompt == nil || prompt.Text != "Fictional input" || prompt.InputRevision != 2 || !prompt.Truncated || !prompt.Redacted || prompt.At == "" {
				t.Fatal("lost initial prompt metadata")
			}
		} else if prompt != nil {
			t.Fatal("older snapshot invented an initial prompt")
		}
	}
}

func TestRejectRemoteOrUnsafeDiscovery(t *testing.T) {
	for _, address := range []string{"http://example.com:1234", "http://192.0.2.1:1234", "http://localhost:1234", "http://127.0.0.1", "http://user:pass@127.0.0.1:1234", "http://127.0.0.1:1234/private", "http://127.0.0.1:1234?token=value", "http://127.0.0.1:1234#fragment", "https://127.0.0.1:1234"} {
		if _, err := NewHTTP(discoveryFile(t, address)); err == nil {
			t.Errorf("accepted unsafe discovery address %s", address)
		}
	}
	if runtime.GOOS != "windows" {
		path := discoveryFile(t, "http://127.0.0.1:1234")
		if err := os.Chmod(path, 0644); err != nil {
			t.Fatal(err)
		}
		if _, err := NewHTTP(path); err == nil {
			t.Fatal("accepted public bridge token file")
		}
	}
}

func TestInvalidActionsNeverReachEngine(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer server.Close()
	client, err := NewHTTP(discoveryFile(t, server.URL))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := client.Steer(ctx, "worker-1", "  "); err == nil {
		t.Fatal("accepted empty steering")
	}
	if _, err := client.Steer(ctx, "worker-1", strings.Repeat("a", 8001)); err == nil {
		t.Fatal("accepted oversized steering")
	}
	if _, err := client.Steer(ctx, "worker-1", strings.Repeat("<", 8000)); err == nil {
		t.Fatal("accepted message whose JSON encoding exceeds bridge body limit")
	}
	if err := client.Stop(ctx, "../../shutdown"); err == nil {
		t.Fatal("accepted path traversal")
	}
	unsupported := "invalid/adapter"
	if err := client.Configure(ctx, Settings{WorkerType: &unsupported}); err == nil {
		t.Fatal("accepted invalid runtime ID")
	}
	if calls.Load() != 0 {
		t.Fatal("invalid action reached engine")
	}
}

func TestDemoPreservesConversationAndSeparatesRequestFromReceipt(t *testing.T) {
	demo := NewDemo()
	ctx := context.Background()
	original, _ := demo.Snapshot(ctx)
	worker := original.Workers[0]
	steering, err := demo.Steer(ctx, worker.ID, "Keep the existing keyboard shortcuts")
	if err != nil || steering.Status != "queued" {
		t.Fatal("steering was not initially queued")
	}
	for _, expected := range []string{"queued", "runtime_received", "response_observed"} {
		snapshot, _ := demo.Snapshot(ctx)
		got := snapshot.Workers[0]
		if got.Steering[0].Status != expected || got.ThreadID != worker.ThreadID || got.InputRevision != worker.InputRevision {
			t.Fatalf("steering lost conversation/revision or state %s", expected)
		}
	}
	if err := demo.Stop(ctx, worker.ID); err != nil {
		t.Fatal(err)
	}
	pending, _ := demo.Snapshot(ctx)
	confirmed, _ := demo.Snapshot(ctx)
	if pending.Workers[0].Status != "stopping" || pending.RunningWorkers != 2 {
		t.Fatal("stop request fabricated confirmation")
	}
	if confirmed.Workers[0].Status != "stopped" || confirmed.RunningWorkers != 1 {
		t.Fatal("simulated stop never confirmed")
	}
}

func TestDemoSnapshotsAreIsolatedAndCapacityDoesNotStopJobs(t *testing.T) {
	demo := NewDemo()
	ctx := context.Background()
	snapshot, _ := demo.Snapshot(ctx)
	snapshot.Workers[0].Activity[0].Text = "mutated"
	max := 1
	if err := demo.Configure(ctx, Settings{MaxWorkers: &max}); err != nil {
		t.Fatal(err)
	}
	current, _ := demo.Snapshot(ctx)
	if current.RunningWorkers != 2 || current.MaxWorkers != 1 || current.Workers[0].Activity[0].Text == "mutated" {
		t.Fatal("capacity change stopped workers or snapshot mutated backend")
	}
}

func TestPinNotFoundExplainsOldEngineOrMissingWorker(t *testing.T) {
	for _, test := range []struct {
		name, snapshot, want string
		status               int
	}{
		{"old engine", `{"version":1,"max_workers":4,"workers":[{"id":"w","status":"running"}]}`, "engine update needed", 200},
		{"worker finished", `{"version":1,"max_workers":4,"workers":[]}`, "worker finished or was removed", 200},
		{"disconnected", "private body", "reconnect", 503},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer "+testBridgeToken {
					t.Error("missing authentication")
				}
				if r.URL.Path == "/v1/snapshot" {
					w.WriteHeader(test.status)
					fmt.Fprint(w, test.snapshot)
					return
				}
				w.WriteHeader(404)
				fmt.Fprint(w, "private body")
			}))
			defer server.Close()
			client, err := NewHTTP(discoveryFile(t, server.URL))
			if err != nil {
				t.Fatal(err)
			}
			err = client.Pin(context.Background(), "w", true)
			if err == nil || !strings.Contains(err.Error(), test.want) || strings.Contains(err.Error(), "private body") {
				t.Fatalf("unexpected diagnostic: %v", err)
			}
		})
	}
}
