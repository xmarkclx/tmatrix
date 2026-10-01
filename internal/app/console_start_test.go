package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestConsoleAttachesWithoutReplacingServiceJobs(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("systemd is Linux-only")
	}
	for _, scenario := range []string{"draining", "unavailable", "invalid snapshot", "restart", "cancelled"} {
		t.Run(scenario, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("XDG_CONFIG_HOME", home)
			dir := filepath.Join(home, "tmatrix")
			if err := os.MkdirAll(dir, 0700); err != nil {
				t.Fatal(err)
			}
			unit, err := serviceUnit("/bin/true", dir, "/bin")
			if err != nil {
				t.Fatal(err)
			}
			unitPath := filepath.Join(home, "systemd", "user", "tmatrix.service")
			if err := os.MkdirAll(filepath.Dir(unitPath), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(unitPath, []byte(unit), 0600); err != nil {
				t.Fatal(err)
			}
			bin := t.TempDir()
			calls := filepath.Join(bin, "calls")
			t.Setenv("TMATRIX_TEST_SYSTEMCTL_LOG", calls)
			if err := os.WriteFile(filepath.Join(bin, "systemctl"), []byte("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$TMATRIX_TEST_SYSTEMCTL_LOG\"\n"), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", bin)
			if scenario != "unavailable" {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Method != http.MethodGet || r.URL.Path != "/v1/snapshot" {
						t.Errorf("console changed engine state: %s %s", r.Method, r.URL.Path)
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					if scenario == "restart" || scenario == "cancelled" {
						t.Error("restart or cancelled launch probed the engine")
					}
					if scenario == "invalid snapshot" {
						_, _ = w.Write([]byte(`{"version":99}`))
						return
					}
					_, _ = w.Write([]byte(`{"version":1,"max_workers":10,"running_workers":4,"poller":{"status":"stopped"}}`))
				}))
				defer server.Close()
				record, _ := json.Marshal(map[string]any{"version": 1, "pid": os.Getpid(), "url": server.URL, "token": "test-console-control-token"})
				if err := os.WriteFile(filepath.Join(dir, "bridge.json"), record, 0600); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if scenario == "cancelled" {
				cancel()
			}
			s := &Service{Dir: dir}
			err = s.startConsole(ctx, scenario == "restart")
			if scenario == "cancelled" {
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("cancelled console error = %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			data, readErr := os.ReadFile(calls)
			if scenario == "draining" || scenario == "cancelled" {
				if !errors.Is(readErr, os.ErrNotExist) {
					t.Fatalf("console contacted systemd during %s: %s (%v)", scenario, data, readErr)
				}
				return
			}
			action := "start"
			if scenario == "restart" {
				action = "restart"
			}
			want := "--user --job-mode=fail " + action + " tmatrix.service"
			if readErr != nil || strings.TrimSpace(string(data)) != want {
				t.Fatalf("systemd call = %q (%v), want %q", data, readErr, want)
			}
		})
	}
}
