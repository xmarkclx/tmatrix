package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"tmatrix/internal/config"
)

func TestEngineEnvironmentIsolatesQueueIdentity(t *testing.T) {
	parent := []string{"PATH=/bin", "HOME=/home/operator", "API_KEY=old-private", "POLL_URL=https://wrong.invalid", "SWARM_ID=old", "INSTANCE_ID=production", "MAX_WORKERS=100", "CONFIG_PATH=/wrong", "TMATRIX_CONTROL_FILE=/old"}
	env := engineEnvironment(parent, map[string]string{"API_KEY": "new-private", "CONFIG_PATH": "/new"})
	joined := strings.Join(env, "\n")
	for _, forbidden := range []string{"old-private", "wrong.invalid", "SWARM_ID=", "production", "MAX_WORKERS=", "/old"} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("inherited queue setting %s", forbidden)
		}
	}
	if !strings.Contains(joined, "HOME=/home/operator") || !strings.Contains(joined, "API_KEY=new-private") {
		t.Fatal("lost required environment")
	}
}

func TestStartupWithoutCredentialsCannotLaunch(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "private")
	err := StartEngine(context.Background(), dir, config.Default())
	if err == nil || !strings.Contains(err.Error(), "connect Tzu Do") {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, err := os.Stat(config.DiscoveryPath(dir)); !os.IsNotExist(err) {
		t.Fatal("unexpected discovery")
	}
	if _, err := os.Stat(filepath.Join(dir, "start.lock")); !os.IsNotExist(err) {
		t.Fatal("startup lock was not released")
	}
}

func TestOfflineServiceSettingsPersistAndNoClaims(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "private")
	service, err := New(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	first, err := service.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second, _ := service.Snapshot(context.Background())
	if first.InstanceID != second.InstanceID || !first.IntakePaused || first.Poller.Status != "not_connected" {
		t.Fatal("unstable offline identity/state")
	}
}

func TestLegacyEngineCannotStartWithoutPausedControlSupport(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "dist"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "dist", "index.js"), []byte("// legacy worker without local control"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := FindEngine(dir); err == nil {
		t.Fatal("legacy engine could ignore startup pause and claim tasks")
	}
}

func TestEngineDiscoveryUsesBundleOrExplicitPath(t *testing.T) {
	fixture := func(dir string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Join(dir, "dist"), 0700); err != nil {
			t.Fatal(err)
		}
		for name, body := range map[string]string{
			"index.js":                "// TMATRIX_CONTROL_FILE TMATRIX_INTAKE_PAUSED",
			"local-control-server.js": "// fixture",
		} {
			if err := os.WriteFile(filepath.Join(dir, "dist", name), []byte(body), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	untrusted := t.TempDir()
	fixture(untrusted)
	fixture(filepath.Join(untrusted, "staging", "engine"))
	t.Chdir(untrusted)
	install := t.TempDir()
	exe := filepath.Join(install, "tmatrix")
	if _, err := findEngine("", exe); err == nil {
		t.Fatal("missing bundled engine must not fall back to working-directory code")
	}
	bundled := filepath.Join(install, "engine")
	fixture(bundled)
	if got, err := findEngine("", exe); err != nil || got != bundled {
		t.Fatalf("bundled engine not selected: %q, %v", got, err)
	}
	if got, err := findEngine(untrusted, exe); err != nil || got != untrusted {
		t.Fatalf("explicit development engine not selected: %q, %v", got, err)
	}
}
