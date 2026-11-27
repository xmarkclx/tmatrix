package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"tmatrix/internal/app"
	"tmatrix/internal/backend"
	"tmatrix/internal/config"
)

func TestAccountsAddAndRemove(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "private")
	if err := run([]string{"--config-dir", dir, "accounts", "add", "codex", "work"}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "accounts", "codex", "work")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !info.IsDir() || (runtime.GOOS != "windows" && info.Mode().Perm() != 0700) {
		t.Fatalf("account mode %v", info.Mode())
	}
	if err := os.WriteFile(filepath.Join(path, "session"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	args := []string{"remove", "codex", "work"}
	var prompt bytes.Buffer
	if err := app.RunAccounts(dir, "", args, strings.NewReader("n\n"), &prompt, io.Discard); err == nil {
		t.Fatal("removal succeeded without confirmation")
	}
	if !strings.Contains(prompt.String(), path) {
		t.Fatalf("removal prompt omitted account path: %s", &prompt)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	if err := app.RunAccounts(dir, "", args, strings.NewReader("y\n"), io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("account still exists: %v", err)
	}
	for _, args := range [][]string{
		{"add", "codex", "default"},
		{"add", "claude", "UPPER"},
		{"add", "../elsewhere", "work"},
		{"remove", "codex", "default"},
	} {
		if err := app.RunAccounts(dir, "", args, strings.NewReader("y\n"), io.Discard, io.Discard); err == nil {
			t.Fatalf("accepted accounts %v", args)
		}
	}
}

func TestAccountsRemoveChecksActiveWorker(t *testing.T) {
	dir := t.TempDir()
	if err := app.RunAccounts(dir, "", []string{"add", "claude", "work"}, strings.NewReader(""), io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/snapshot" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		json.NewEncoder(w).Encode(backend.Snapshot{
			Version: 2, MaxWorkers: 10, RunningWorkers: 1,
			Workers: []backend.Worker{{WorkerType: "claude", Account: "work", Status: "stop_unverified"}},
		})
	}))
	defer server.Close()
	data, err := json.Marshal(map[string]any{"version": 1, "pid": os.Getpid(), "url": server.URL, "token": "fictional-accounts-test-token"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.DiscoveryPath(dir), data, 0600); err != nil {
		t.Fatal(err)
	}
	err = app.RunAccounts(dir, "", []string{"remove", "claude", "work"}, strings.NewReader("y\n"), io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "worker is using it") {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "accounts", "claude", "work")); err != nil {
		t.Fatal(err)
	}
}

func TestAccountsListRunsOfflineUtility(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is required to run the account utility")
	}
	dir := filepath.Join(t.TempDir(), "private")
	engine := filepath.Join(dir, "engine")
	dist := filepath.Join(engine, "dist")
	if err := os.MkdirAll(dist, 0700); err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.EngineDir = engine
	if err := config.Save(dir, cfg); err != nil {
		t.Fatal(err)
	}
	for name, source := range map[string]string{
		"index.js":                "// TMATRIX_CONTROL_FILE TMATRIX_INTAKE_PAUSED\nthrow new Error('must not start the daemon');",
		"local-control-server.js": "",
		"account-cli.js": `
const [dir, provider, adapter, action] = process.argv.slice(2);
if (provider !== 'codex' || adapter || action !== 'list' || process.env.API_KEY) process.exit(1);
console.log(['codex', 'work', require('node:path').join(dir, 'accounts', 'codex', 'work'), 'logged in'].join('\t'));`,
	} {
		if err := os.WriteFile(filepath.Join(dist, name), []byte(source), 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("API_KEY", "fictional-accounts-test-api-key")
	var output bytes.Buffer
	if err := app.RunAccounts(dir, "", []string{"list"}, strings.NewReader(""), &output, io.Discard); err != nil {
		t.Fatal(err)
	}
	want := "codex\twork\t" + filepath.Join(dir, "accounts", "codex", "work") + "\tlogged in\n"
	if output.String() != want {
		t.Fatalf("got %q, want %q", output.String(), want)
	}
}
