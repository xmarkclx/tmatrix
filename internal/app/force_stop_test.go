package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"tmatrix/internal/config"
)

func TestForceStopTargetsOnlyTheOwnedServiceAndVerifiesExit(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("systemd process verification runs on Linux")
	}
	const (
		mainPID   = 22222
		enginePID = 33333
		group     = "/user.slice/tmatrix-fixture.service"
	)
	for _, test := range []struct {
		name   string
		engine string
		main   string
		before string
		kill   bool
	}{
		{name: "draining service", engine: group, main: group, kill: true},
		{name: "standalone engine", engine: "/another.slice", main: group},
		{name: "unowned daemon", engine: group, main: "/another.slice"},
		{name: "unverified fragment", engine: group, main: group, before: "/usr/lib/systemd/user/tmatrix.service"},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			dir := filepath.Join(root, "private")
			proc := filepath.Join(root, "proc")
			cgroups := filepath.Join(root, "cgroup")
			unitPath := filepath.Join(root, "tmatrix-fixture.service")
			data, err := serviceUnit("/fixture/tmatrix", dir, "/fixture/bin")
			if err != nil {
				t.Fatal(err)
			}
			write := func(path, value string) {
				t.Helper()
				if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(value), 0600); err != nil {
					t.Fatal(err)
				}
			}
			write(unitPath, data)
			writeTestEnginePID(t, dir, enginePID, "http://127.0.0.1:1")
			write(filepath.Join(proc, strconv.Itoa(os.Getpid()), "cgroup"), "0::/console.slice\n")
			write(filepath.Join(proc, strconv.Itoa(mainPID), "cgroup"), "0::"+test.main+"\n")
			write(filepath.Join(proc, strconv.Itoa(mainPID), "cmdline"), "/fixture/tmatrix\x00--config-dir\x00"+dir+"\x00daemon\x00")
			write(filepath.Join(proc, strconv.Itoa(enginePID), "cgroup"), "0::"+test.engine+"\n")
			groupEvents := filepath.Join(cgroups, group, "cgroup.events")
			write(groupEvents, "populated 1\nfrozen 0\n")
			fragment := unitPath
			if test.before != "" {
				fragment = test.before
			}
			active, pid := "active", mainPID
			var mutations []string
			var confirmations int
			controller := forceStopService{
				unit: filepath.Base(unitPath), unitPath: unitPath, proc: proc, cgroups: cgroups,
				control: func(_ context.Context, args ...string) (string, error) {
					if args[0] == "show" {
						if active == "inactive" {
							confirmations++
							if confirmations == 2 {
								write(groupEvents, "populated 0\nfrozen 0\n")
							}
						}
						return fmt.Sprintf("ActiveState=%s\nMainPID=%d\nControlGroup=%s\nFragmentPath=%s\nDropInPaths=\nNeedDaemonReload=no\nInvocationID=initial\n", active, pid, group, fragment), nil
					}
					action := strings.Join(args[:len(args)-1], " ")
					mutations = append(mutations, action)
					switch action {
					case "--job-mode=replace-irreversibly --no-block stop":
						active = "deactivating"
					case "kill --kill-whom=all --signal=SIGKILL":
						active, pid = "inactive", 0
						if err := os.RemoveAll(filepath.Join(proc, strconv.Itoa(enginePID))); err != nil {
							t.Fatal(err)
						}
					default:
						t.Fatalf("unexpected systemd action %q", action)
					}
					return "", nil
				},
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			err = controller.stop(ctx, dir)
			if !test.kill {
				if err == nil || len(mutations) != 0 {
					t.Fatalf("unverified service permitted a stop: %v %v", err, mutations)
				}
				return
			}
			if err != nil || strings.Join(mutations, ",") != "--job-mode=replace-irreversibly --no-block stop,kill --kill-whom=all --signal=SIGKILL" || confirmations != 2 {
				t.Fatalf("force stop returned before verifying that service descendants exited: %v %v %d", err, mutations, confirmations)
			}
			if _, err := os.Lstat(config.DiscoveryPath(dir)); err != nil {
				t.Fatal("force stop removed the stale bridge needed to fence an earlier drain")
			}
			if err := controller.stop(ctx, dir); err != nil || len(mutations) != 2 {
				t.Fatalf("repeating a completed force stop changed the service: %v %v", err, mutations)
			}
		})
	}
}

func TestForceStoppedEngineInterruptsDrainAndAllowsLaterStart(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("live daemon runs on Unix")
	}
	dir := filepath.Join(t.TempDir(), "private")
	s := &Service{Dir: dir}
	cfg := config.Default()
	cfg.ResumeIntake = true
	cfg.Sources = []config.Source{fixtureSource(cfg, "https://fixture.invalid/poll")}
	if err := config.Save(dir, cfg); err != nil {
		t.Fatal(err)
	}
	child := exec.Command("sleep", "30")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer child.Process.Kill()
	shutdown := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/shutdown" {
			shutdown <- struct{}{}
			w.WriteHeader(http.StatusAccepted)
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	path := config.DiscoveryPath(dir)
	writeTestEnginePID(t, dir, child.Process.Pid, server.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	waiting := make(chan error, 1)
	go func() { waiting <- s.drainConnection(ctx) }()
	select {
	case <-shutdown:
	case <-ctx.Done():
		t.Fatal("running daemon never received the original graceful shutdown request")
	}
	if err := child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = child.Wait()
	if err := <-waiting; err == nil || !strings.Contains(err.Error(), "before the drain completed") {
		t.Fatalf("drain accepted forced death as a graceful exit: %v", err)
	}
	if err := s.drainConnection(ctx); err != nil {
		t.Fatalf("later explicit drain did not accept the already stopped daemon: %v", err)
	}
	snapshot, err := s.Snapshot(ctx)
	if err != nil || snapshot.RunningWorkers != 0 || !snapshot.IntakePaused || len(snapshot.Pollers) != 1 {
		t.Fatalf("stale bridge hid disconnected source status: %v", err)
	}
	saved, err := config.Load(dir)
	if err != nil || !saved.ResumeIntake || saved.Sources[0] != cfg.Sources[0] {
		t.Fatal("force stop changed saved sources or the next startup's intake preference")
	}
	if _, err := os.Lstat(path); err != nil {
		t.Fatal("force stop must keep the stale bridge until startup can safely replace it")
	}
}

func writeTestEnginePID(t *testing.T, dir string, pid int, url string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(map[string]any{"version": 1, "pid": pid, "url": url, "token": "private-fixture-control-token"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.DiscoveryPath(dir), data, 0600); err != nil {
		t.Fatal(err)
	}
}
