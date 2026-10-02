package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"tmatrix/internal/config"
)

func TestAdapterUpdateActionsUseExistingEngineWithoutChangingConfiguration(t *testing.T) {
	s, err := New(filepath.Join(t.TempDir(), "private"), "")
	if err != nil {
		t.Fatal(err)
	}
	if err := config.SaveAPIKey(s.Dir, "fictional-original-key"); err != nil {
		t.Fatal(err)
	}
	before, _ := config.Load(s.Dir)
	paths := make(chan string, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !strings.HasPrefix(r.URL.Path, "/v1/adapter/") {
			t.Errorf("update changed worker or service lifecycle: %s", r.URL.Path)
		}
		paths <- r.URL.Path
		w.WriteHeader(http.StatusAccepted)
		fmt.Fprint(w, `{"ok":true}`)
	}))
	defer server.Close()
	data, _ := json.Marshal(map[string]any{"version": 1, "url": server.URL, "token": "fictional-update-token", "pid": os.Getpid()})
	if err := os.WriteFile(config.DiscoveryPath(s.Dir), data, 0600); err != nil {
		t.Fatal(err)
	}
	for _, action := range []func(context.Context) error{s.CheckAdapterUpdate, s.RollbackAdapterUpdate} {
		if err := action(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if <-paths != "/v1/adapter/check-now" || <-paths != "/v1/adapter/rollback" {
		t.Fatal("application misrouted runtime update")
	}
	after, _ := config.Load(s.Dir)
	key, err := config.LoadAPIKey(s.Dir)
	if err != nil || before != after || key != "fictional-original-key" {
		t.Fatal("runtime update changed saved settings or credentials")
	}
	if err := os.Remove(config.DiscoveryPath(s.Dir)); err != nil {
		t.Fatal(err)
	}
	for _, action := range []func(context.Context) error{s.CheckAdapterUpdate, s.RollbackAdapterUpdate} {
		if err := action(context.Background()); err == nil || !strings.Contains(err.Error(), "disconnected") {
			t.Fatal("disconnected update did not explain unavailable engine")
		}
	}
}
