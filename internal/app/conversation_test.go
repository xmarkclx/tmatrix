package app

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"tmatrix/internal/config"
)

func TestRecoverConversationOffline(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node unavailable")
	}
	dir, engine := t.TempDir(), t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	dist := filepath.Join(engine, "dist")
	if err := os.MkdirAll(dist, 0700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		"index.js":                "// TMATRIX_CONTROL_FILE TMATRIX_INTAKE_PAUSED\nthrow new Error('must not start the daemon');",
		"local-control-server.js": "",
		"recover-conversation.js": `const fs = require('node:fs');
if (process.env.API_KEY || process.env.TMATRIX_CONTROL_FILE) process.exit(9);
fs.writeFileSync(process.env.RECOVERY_TEST_OUTPUT, JSON.stringify(process.argv.slice(2)));`,
	} {
		if err := os.WriteFile(filepath.Join(dist, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	cfg := config.Default()
	cfg.EngineDir = engine
	if err := config.Save(dir, cfg); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(filepath.Join(dir, config.ConfigFilename))
	output := filepath.Join(t.TempDir(), "arguments.json")
	t.Setenv("RECOVERY_TEST_OUTPUT", output)
	t.Setenv("API_KEY", "fictional-must-not-reach-recovery")
	t.Setenv("TMATRIX_CONTROL_FILE", "must-not-reach-recovery")
	for _, confirmed := range []bool{false, true} {
		if err := RecoverConversation(context.Background(), dir, "", "00000000-0000-4000-8000-000000000000", confirmed); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(output)
		if err != nil {
			t.Fatal(err)
		}
		var args []string
		if err := json.Unmarshal(data, &args); err != nil {
			t.Fatal(err)
		}
		wantLen := 2
		if confirmed {
			wantLen = 3
		}
		if len(args) != wantLen || args[0] != cfg.PollURL || args[1] != "00000000-0000-4000-8000-000000000000" || (confirmed && args[2] != "--confirm-runtime-stopped") {
			t.Fatalf("unexpected recovery args: %v", args)
		}
	}
	after, _ := os.ReadFile(filepath.Join(dir, config.ConfigFilename))
	if string(before) != string(after) {
		t.Fatal("recovery changed configuration")
	}
	if _, err := os.Stat(config.DiscoveryPath(dir)); !os.IsNotExist(err) {
		t.Fatal("recovery created daemon discovery")
	}
	if err := os.WriteFile(filepath.Join(dist, "recover-conversation.js"), []byte("process.exit(7)"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := RecoverConversation(context.Background(), dir, engine, "task", false); err == nil {
		t.Fatal("recovery failure was hidden")
	}
}
