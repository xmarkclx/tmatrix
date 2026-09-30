package app

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestServiceUnitEscaping(t *testing.T) {
	unit, err := serviceUnit("/home/a b/tmatrix", "/home/a%/cfg$test", "/bin:/with space")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`ExecStart="/home/a b/tmatrix" --config-dir "/home/a%%/cfg$$test" daemon`, `Environment="PATH=/bin:/with space"`, "KillMode=mixed", "TimeoutStopSec=infinity", "Restart=on-failure"} {
		if !strings.Contains(unit, want) {
			t.Fatalf("missing %q", want)
		}
	}
	if _, err := serviceUnit("/bin/tmatrix\nExecStart=bad", "/tmp", "/bin"); err == nil {
		t.Fatal("accepted newline")
	}
}

func TestSystemdAcceptsUnit(t *testing.T) {
	tool, err := exec.LookPath("systemd-analyze")
	if err != nil {
		t.Skip("systemd-analyze unavailable")
	}
	unit, err := serviceUnit("/bin/true", "/tmp/config with spaces%value", "/usr/bin:/bin")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "tmatrix.service")
	if err := os.WriteFile(path, []byte(unit), 0600); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command(tool, "--user", "verify", path).CombinedOutput(); err != nil {
		t.Fatalf("invalid systemd unit: %v: %s", err, output)
	}
}

func TestServiceUninstallIsolated(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("systemd is Linux-only")
	}
	home := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", home)
	bin := t.TempDir()
	// No real service manager is contacted. Output must not corrupt the TUI.
	if err := os.WriteFile(filepath.Join(bin, "systemctl"), []byte("#!/bin/sh\necho test-output\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	dir := filepath.Join(home, "tmatrix")
	unit, err := serviceUnit("/bin/true", dir, "/bin")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, "systemd", "user", "tmatrix.service")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(unit), 0600); err != nil {
		t.Fatal(err)
	}
	wrong := &Service{Dir: filepath.Join(home, "other")}
	if err := wrong.ManageService("uninstall"); err == nil {
		t.Fatal("removed another configuration's service")
	}
	service := &Service{Dir: dir}
	if err := service.ManageService("uninstall"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("unit remains")
	}
}
