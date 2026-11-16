package app

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestLaunchLogBoundsAndRetainsNewestBytes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine-launch.log")
	log, err := newLaunchLog(path, 4, 3)
	if err != nil {
		t.Fatal(err)
	}
	if n, err := log.Write([]byte("aaaabbbbccccddddeeee")); err != nil || n != 20 {
		t.Fatalf("write %d: %v", n, err)
	}
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{path: "eeee", path + ".1": "dddd", path + ".2": "cccc", path + ".3": "bbbb"} {
		data, err := os.ReadFile(name)
		if err != nil || string(data) != want {
			t.Fatalf("%s = %q, %v", name, data, err)
		}
		info, _ := os.Stat(name)
		if info.Mode().Perm() != 0600 {
			t.Fatal("log is not private")
		}
	}
	if _, err := log.Write([]byte("x")); !os.IsNotExist(err) && err != os.ErrClosed {
		t.Fatalf("closed write: %v", err)
	}
}

func TestLaunchLogTrimsHistoricalFilesAndRotatesBeforeWriting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine-launch.log")
	for name, body := range map[string]string{path: "old-tail", path + ".1": "old-back", path + ".3": "discard"} {
		if err := os.WriteFile(name, []byte(body), 0644); err != nil {
			t.Fatal(err)
		}
	}
	log, err := newLaunchLog(path, 4, 3)
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	for name, want := range map[string]string{path: "", path + ".1": "tail", path + ".2": "back"} {
		data, err := os.ReadFile(name)
		if err != nil || string(data) != want {
			t.Fatalf("%s = %q, %v", name, data, err)
		}
	}
}

func TestLaunchLogRejectsUnsafePaths(t *testing.T) {
	for _, suffix := range []string{"", ".1", ".2", ".3"} {
		for _, kind := range []string{"symlink", "directory"} {
			t.Run(suffix+kind, func(t *testing.T) {
				dir := t.TempDir()
				path := filepath.Join(dir, "engine-launch.log")
				target := filepath.Join(dir, "target")
				if err := os.WriteFile(target, []byte("private-target"), 0644); err != nil {
					t.Fatal(err)
				}
				var err error
				if kind == "symlink" {
					err = os.Symlink(target, path+suffix)
				} else {
					err = os.Mkdir(path+suffix, 0700)
				}
				if err != nil {
					t.Fatal(err)
				}
				if log, err := newLaunchLog(path, 4, 3); err == nil {
					log.Close()
					t.Fatal("accepted unsafe path")
				}
				data, _ := os.ReadFile(target)
				if string(data) != "private-target" {
					t.Fatal("changed symlink target")
				}
				info, _ := os.Stat(target)
				if info.Mode().Perm() != 0644 {
					t.Fatal("changed symlink target permissions")
				}
			})
		}
	}
}

func TestLaunchLogConcurrentWritesAndRotationErrors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine-launch.log")
	log, err := newLaunchLog(path, 128, 3)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 20; i++ {
				if _, err := log.Write([]byte(strings.Repeat("x", 16))); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	wg.Wait()
	if err := os.Mkdir(path+".3", 0700); err == nil {
		t.Fatal("expected retained backup")
	}
	if err := os.Remove(path + ".3"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path+".3", 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := log.Write([]byte(strings.Repeat("x", 129))); err == nil {
		t.Fatal("rotation error was swallowed")
	}
	log.Close()
}

func TestEngineLogFailureKeepsDrainingOutput(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine-launch.log")
	log, err := newLaunchLog(path, 4, 3)
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	if err := os.Mkdir(path+".3", 0700); err != nil {
		t.Fatal(err)
	}
	output := &engineLogOutput{log: log, errors: make(chan error, 1)}
	for i := 0; i < 100; i++ {
		if n, err := output.Write([]byte("abcdefgh")); n != 8 || err != nil {
			t.Fatalf("child pipe interrupted: %d, %v", n, err)
		}
	}
	select {
	case <-output.errors:
	default:
		t.Fatal("supervisor was not notified")
	}
	select {
	case <-output.errors:
		t.Fatal("repeated failure notification")
	default:
	}
}
