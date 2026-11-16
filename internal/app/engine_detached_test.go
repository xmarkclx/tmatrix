//go:build !windows

package app

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"tmatrix/internal/backend"
	"tmatrix/internal/config"
)

func TestDetachedCLIContinuesRotatingAndDrains(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js required for isolated engine fixture")
	}
	root := t.TempDir()
	binary := filepath.Join(root, "tmatrix")
	build := exec.Command("go", "build", "-o", binary, "./cmd/tmatrix")
	build.Dir = "../.."
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v, %s", err, output)
	}
	engine := filepath.Join(root, "engine")
	if err := os.MkdirAll(filepath.Join(engine, "dist"), 0700); err != nil {
		t.Fatal(err)
	}
	wrapper := "#!/bin/sh\nif [ \"$1\" = \"--input-type=module\" ]; then exit 0; fi\nexec '" + strings.ReplaceAll(node, "'", "'\\''") + "' \"$@\"\n"
	if err := os.WriteFile(filepath.Join(root, "node"), []byte(wrapper), 0700); err != nil {
		t.Fatal(err)
	}
	fixture := `// TMATRIX_CONTROL_FILE TMATRIX_INTAKE_PAUSED
const fs = require('node:fs');
const http = require('node:http');
const bridge = process.env.TMATRIX_CONTROL_FILE;
let stopping = false;
const output = setInterval(() => { process.stdout.write('o'.repeat(524288)); process.stderr.write('e'.repeat(524288)); }, 20);
function stop() {
 if (stopping) return;
 stopping = true;
 clearInterval(output);
 setTimeout(() => { process.stderr.write('DRAINED\n', () => { fs.unlinkSync(bridge); process.exit(0); }); }, 350);
}
process.on('SIGTERM', stop);
const server = http.createServer((req,res) => {
 res.setHeader('content-type', 'application/json');
 if (req.url === '/v1/shutdown') { res.end('{}'); stop(); }
 else res.end(JSON.stringify({version:1,max_workers:1,running_workers:0,intake_paused:true,poller:{status:'paused'}}));
});
server.listen(0,'127.0.0.1',() => fs.writeFileSync(bridge, JSON.stringify({version:1,pid:process.pid,url:'http://127.0.0.1:'+server.address().port,token:'fixture-token-123456789'}),{mode:0o600}));`
	for name, body := range map[string]string{"index.js": fixture, "local-control-server.js": "// isolated fixture"} {
		if err := os.WriteFile(filepath.Join(engine, "dist", name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	dir := filepath.Join(root, "private")
	cfg := config.Default()
	cfg.EngineDir = engine
	if err := config.Save(dir, cfg); err != nil {
		t.Fatal(err)
	}
	if err := config.SaveAPIKey(dir, "isolated-test-key"); err != nil {
		t.Fatal(err)
	}
	command := func(args ...string) *exec.Cmd {
		c := exec.Command(binary, append([]string{"--config-dir", dir}, args...)...)
		c.Env = append(os.Environ(), "PATH="+root+string(os.PathListSeparator)+os.Getenv("PATH"))
		return c
	}
	if output, err := command("engine", "start").CombinedOutput(); err != nil {
		t.Fatalf("launcher: %v %s", err, output)
	}
	client, err := backend.NewHTTP(config.DiscoveryPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = client.Shutdown(ctx)
	}()
	await := func(test func() bool) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for !test() {
			if time.Now().After(deadline) {
				t.Fatal("fixture did not reach expected state")
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	logPath := filepath.Join(dir, "engine-launch.log")
	await(func() bool { _, err := os.Stat(logPath + ".3"); return err == nil })
	for _, suffix := range []string{"", ".1", ".2", ".3"} {
		info, err := os.Stat(logPath + suffix)
		if err != nil || info.Size() > 10*1024*1024 || info.Mode().Perm() != 0600 {
			t.Fatalf("unbounded/private log %s: %v, %v", suffix, info, err)
		}
	}
	if err := client.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(config.DiscoveryPath(dir)); err != nil {
		t.Fatal("shutdown did not drain before exit")
	}
	await(func() bool { _, err := os.Stat(config.DiscoveryPath(dir)); return os.IsNotExist(err) })
	data, err := os.ReadFile(logPath)
	if err != nil || !strings.HasSuffix(string(data), "DRAINED\n") {
		t.Fatalf("drain output missing: %v", err)
	}
	if err := os.WriteFile(filepath.Join(engine, "dist", "index.js"), []byte("// TMATRIX_CONTROL_FILE TMATRIX_INTAKE_PAUSED\nprocess.exit(42)"), 0600); err != nil {
		t.Fatal(err)
	}
	output, err := command("engine", "start").CombinedOutput()
	if err == nil || !strings.Contains(string(output), "engine exited during startup") {
		t.Fatalf("failed startup: %v %s", err, output)
	}
	if _, err := os.Stat(filepath.Join(dir, "start.lock")); !os.IsNotExist(err) {
		t.Fatal("failed daemon retained startup lock")
	}
}

func TestPausedStartupCancellationReapsChild(t *testing.T) {
	cmd := exec.Command("sh", "-c", "trap '' TERM; echo ready; while :; do sleep 1; done")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	if line, err := bufio.NewReader(stdout).ReadString('\n'); err != nil || line != "ready\n" {
		t.Fatalf("child not ready: %q, %v", line, err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	stopPausedEngine(cmd, done)
	if err := cmd.Process.Signal(syscall.Signal(0)); err == nil {
		t.Fatal("canceled child still alive")
	}
}

func TestCanceledLaunchDoesNotStartDaemon(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := StartEngine(ctx, t.TempDir(), config.Default()); err != context.Canceled {
		t.Fatalf("got %v", err)
	}
}
