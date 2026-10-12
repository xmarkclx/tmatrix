package backend

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAdapterCreditsSnapshotAndRefresh(t *testing.T) {
	var action string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testBridgeToken {
			t.Error("missing local authentication")
		}
		if r.URL.Path == "/v1/snapshot" {
			fmt.Fprint(w, `{"version":1,"max_workers":4,"adapter_credits":{"adapter_id":"echo","display_name":"Echo","status":"ready","refreshing":false,"last_successful_at":"2026-10-12T00:00:00Z","windows":[{"label":"5h","remaining_percent":0},{"label":"7d","remaining_percent":21}]}}`)
			return
		}
		body, _ := io.ReadAll(r.Body)
		action = r.Method + " " + r.URL.Path + " " + string(body)
		w.WriteHeader(http.StatusAccepted)
		fmt.Fprint(w, `{"ok":true}`)
	}))
	defer server.Close()
	client, err := NewHTTP(discoveryFile(t, server.URL))
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := client.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	credits := snapshot.AdapterCredits
	if credits == nil || credits.DisplayName != "Echo" || len(credits.Windows) != 2 || credits.Windows[0].RemainingPercent == nil || *credits.Windows[0].RemainingPercent != 0 || *credits.Windows[1].RemainingPercent != 21 {
		t.Fatalf("lost credit readings: %+v", credits)
	}
	if err := client.RefreshAdapterCredits(context.Background()); err != nil {
		t.Fatal(err)
	}
	if action != "POST /v1/adapter/credits/refresh {}" {
		t.Fatalf("incorrect credit action: %s", action)
	}
}

func TestAdapterCreditRefreshHandlesLegacyAndPrivateFailures(t *testing.T) {
	for _, test := range []struct {
		status     int
		body, want string
	}{
		{404, "private provider failure", "unavailable in this engine"},
		{409, "private provider failure", "unavailable in this engine"},
		{500, "private provider failure", "HTTP 500"},
		{202, `{"ok":false}`, "did not acknowledge"},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(test.status); fmt.Fprint(w, test.body) }))
		client, err := NewHTTP(discoveryFile(t, server.URL))
		if err != nil {
			t.Fatal(err)
		}
		err = client.RefreshAdapterCredits(context.Background())
		if err == nil || !strings.Contains(err.Error(), test.want) || strings.Contains(err.Error(), "private") {
			t.Fatalf("unsafe refresh error: %v", err)
		}
		server.Close()
	}
}

func TestDemoCreditsAreSimulatedAndSnapshotCopiesIndependent(t *testing.T) {
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	demo := newDemo(func() time.Time { return now })
	first, _ := demo.Snapshot(context.Background())
	if first.AdapterCredits == nil || *first.AdapterCredits.Windows[0].RemainingPercent != 15 || *first.AdapterCredits.Windows[1].RemainingPercent != 21 {
		t.Fatal("missing simulated credit readings")
	}
	*first.AdapterCredits.Windows[0].RemainingPercent = 99
	if err := demo.RefreshAdapterCredits(context.Background()); err != nil {
		t.Fatal(err)
	}
	next, _ := demo.Snapshot(context.Background())
	if *next.AdapterCredits.Windows[0].RemainingPercent != 16 || *next.AdapterCredits.Windows[1].RemainingPercent != 22 || next.RunningWorkers != 2 || next.IntakePaused != first.IntakePaused {
		t.Fatal("refresh changed workers or lost deterministic readings")
	}
}
