package backend

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAdapterUpdateStatusAndAuthenticatedActions(t *testing.T) {
	paths := make(chan string, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testBridgeToken {
			t.Error("missing bridge authentication")
		}
		if r.URL.Path == "/v1/snapshot" {
			fmt.Fprint(w, `{"version":1,"max_workers":3,"adapter_update":{"adapter_id":"fictional","display_name":"Fictional CLI","can_rollback":true,"status":"up_to_date","current_version":"1.0.0","previous_version":"2.0.0","latest_version":"2.0.0","blocked_version":"2.0.0","last_checked_at":"2026-10-02T04:00:00Z","next_check_at":"2026-10-03T04:00:00Z"}}`)
			return
		}
		if r.Method != http.MethodPost {
			t.Error("update action was not POST")
		}
		paths <- r.URL.Path
		w.WriteHeader(http.StatusAccepted)
		fmt.Fprint(w, `{"ok":true}`)
	}))
	defer server.Close()
	client, err := NewHTTP(discoveryFile(t, server.URL))
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := client.Snapshot(context.Background())
	if err != nil || snapshot.AdapterUpdate == nil || snapshot.AdapterUpdate.CurrentVersion != "1.0.0" || snapshot.AdapterUpdate.PreviousVersion != "2.0.0" || snapshot.AdapterUpdate.NextCheckAt == "" || snapshot.AdapterUpdate.BlockedVersion != "2.0.0" {
		t.Fatalf("lost updater metadata: %v", err)
	}
	if snapshot.AdapterUpdate.AdapterID != "fictional" || snapshot.AdapterUpdate.DisplayName != "Fictional CLI" || !snapshot.AdapterUpdate.CanRollback {
		t.Fatal("lost adapter identity or update capabilities")
	}
	for _, action := range []func(context.Context) error{client.CheckAdapterUpdate, client.RollbackAdapterUpdate} {
		if err := action(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if <-paths != "/v1/adapter/check-now" || <-paths != "/v1/adapter/rollback" {
		t.Fatal("incorrect update routing")
	}
}

func TestAdapterUpdateHandlesOldEnginesAndPrivateFailures(t *testing.T) {
	for _, test := range []struct {
		status     int
		body, want string
	}{
		{404, "private runtime body", "unavailable in this engine"},
		{409, "private runtime body", "current state"},
		{500, "private runtime body", "HTTP 500"},
		{202, `{"ok":false}`, "did not acknowledge"},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(test.status)
			fmt.Fprint(w, test.body)
		}))
		client, err := NewHTTP(discoveryFile(t, server.URL))
		if err != nil {
			server.Close()
			t.Fatal(err)
		}
		for _, action := range []func(context.Context) error{client.CheckAdapterUpdate, client.RollbackAdapterUpdate} {
			err := action(context.Background())
			if err == nil || !strings.Contains(err.Error(), test.want) || strings.Contains(err.Error(), "private") {
				t.Fatalf("unsafe or incorrect updater error: %v", err)
			}
		}
		server.Close()
	}
}
