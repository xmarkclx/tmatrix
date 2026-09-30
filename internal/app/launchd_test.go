package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestLaunchAgentPlist(t *testing.T) {
	t.Setenv("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
	t.Setenv("CODEX_HOME", "/Users/a & b/codex")
	t.Setenv("XDG_STATE_HOME", "/Users/a/state")
	t.Setenv("API_KEY", "must-not-be-captured")
	plist, err := launchAgentPlist("/Users/a & b/tmatrix", "/Users/a/Library/Application Support/tmatrix")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("python3", "-c", `import plistlib,sys
p=plistlib.loads(sys.stdin.buffer.read())
assert p['Label']=='app.tmatrix.worker'
assert p['ProgramArguments']==['/Users/a & b/tmatrix','--config-dir','/Users/a/Library/Application Support/tmatrix','daemon']
assert p['EnvironmentVariables']=={'PATH':'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin','CODEX_HOME':'/Users/a & b/codex','XDG_STATE_HOME':'/Users/a/state'}
assert p['KeepAlive']=={'SuccessfulExit':False}
assert p['RunAtLoad'] and p['ExitTimeOut']==0 and p['Umask']==63
`)
	cmd.Stdin = strings.NewReader(plist)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("plist validation: %v: %s", err, output)
	}
	if runtime.GOOS == "darwin" {
		path := filepath.Join(t.TempDir(), "agent.plist")
		os.WriteFile(path, []byte(plist), 0600)
		if output, err := exec.Command("plutil", "-lint", path).CombinedOutput(); err != nil {
			t.Fatalf("plutil: %v: %s", err, output)
		}
	}
	if _, err := launchAgentPlist("/bad\npath", "/config"); err == nil {
		t.Fatal("accepted invalid path")
	}
}

func fakeLaunchctl(t *testing.T) string {
	t.Helper()
	bin := t.TempDir()
	log := filepath.Join(bin, "calls")
	script := `#!/bin/sh
printf '%s\n' "$*" >> "$LAUNCH_TEST_LOG"
if [ "$1" = print ]; then
  if [ -f "$LAUNCH_TEST_LOG.unloaded" ]; then exit 113; fi
  exit "${LAUNCH_TEST_STATUS:-0}"
fi
if [ "$1" = bootout ]; then : > "$LAUNCH_TEST_LOG.unloaded"; fi
if [ "$1" = bootstrap ]; then /bin/rm -f "$LAUNCH_TEST_LOG.unloaded"; fi
`
	if err := os.WriteFile(filepath.Join(bin, "launchctl"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	t.Setenv("LAUNCH_TEST_LOG", log)
	t.Setenv("LAUNCH_TEST_STATUS", "0")
	return log
}

func TestLaunchAgentConsoleAndUninstall(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	path, _ := launchAgentPath()
	plist, _ := launchAgentPlist("/bin/tmatrix", dir)
	os.MkdirAll(filepath.Dir(path), 0700)
	os.WriteFile(path, []byte(plist), 0600)
	log := fakeLaunchctl(t)
	s := &Service{Dir: dir}
	if err := s.startLaunchAgentConsole(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(log)
	target := launchDomain() + "/" + launchAgentLabel
	if string(data) != "print "+target+"\nkickstart "+target+"\n" {
		t.Fatalf("unsafe console commands: %s", data)
	}
	os.WriteFile(log, nil, 0600)
	if err := s.startLaunchAgentConsole(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(log)
	if strings.Contains(string(data), "-k") || !strings.Contains(string(data), "bootout "+target) || !strings.Contains(string(data), "bootstrap "+launchDomain()+" "+path) {
		t.Fatalf("unsafe restart: %s", data)
	}
	if err := manageLaunchAgent(dir+"-other", "uninstall", io.Discard); err == nil {
		t.Fatal("removed another configuration")
	}
	if err := manageLaunchAgent(dir, "uninstall", io.Discard); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("plist remains")
	}
}

func TestLaunchAgentAbsentAndErrors(t *testing.T) {
	fakeLaunchctl(t)
	control := func(args ...string) error { return launchControl(context.Background(), args...) }
	for _, tc := range []struct {
		code           string
		loaded, failed bool
	}{{"0", true, false}, {"113", false, false}, {"5", false, true}} {
		t.Setenv("LAUNCH_TEST_STATUS", tc.code)
		loaded, err := launchAgentLoaded(control)
		if loaded != tc.loaded || (err != nil) != tc.failed {
			t.Fatalf("code %s: %v, %v", tc.code, loaded, err)
		}
	}
}

func TestLaunchAgentDrainFailureDoesNotUnload(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "bridge.json"), []byte("invalid discovery"), 0600)
	var calls []string
	err := stopLaunchAgent(dir, func(args ...string) error { calls = append(calls, args[0]); return nil })
	if err == nil || !reflect.DeepEqual(calls, []string{"print"}) {
		t.Fatalf("unloaded before drain: %v %v", calls, err)
	}
}

func TestLaunchAgentWaitsForDrainBeforeBootout(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bridge.json")
	shutdown := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/shutdown" {
			shutdown <- struct{}{}
			w.WriteHeader(http.StatusAccepted)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	record, _ := json.Marshal(map[string]any{"version": 1, "pid": os.Getpid(), "url": server.URL, "token": "local-test-token"})
	os.WriteFile(path, record, 0600)
	defer os.Remove(path)
	unloaded := make(chan struct{}, 1)
	done := make(chan error, 1)
	go func() {
		done <- stopLaunchAgent(dir, func(args ...string) error {
			if args[0] == "bootout" {
				unloaded <- struct{}{}
			}
			return nil
		})
	}()
	select {
	case <-shutdown:
	case <-time.After(3 * time.Second):
		t.Fatal("shutdown not requested")
	}
	select {
	case <-unloaded:
		t.Fatal("unloaded active engine")
	case <-time.After(100 * time.Millisecond):
	}
	os.Remove(path)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("drain never finished")
	}
	select {
	case <-unloaded:
	default:
		t.Fatal("never unloaded")
	}
}
