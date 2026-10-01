package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"tmatrix/internal/backend"
	"tmatrix/internal/config"
)

// FindEngine supports a development checkout and an installed release bundle.
func FindEngine(configured string) (string, error) {
	if configured == "" {
		configured = os.Getenv("TMATRIX_ENGINE_DIR")
	}
	exe, _ := os.Executable()
	return findEngine(configured, exe)
}

func findEngine(configured, executable string) (string, error) {
	var candidates []string
	if configured != "" {
		candidates = []string{configured}
	} else {
		// Installed bundles and binaries built into bin/ own their engine.
		// Never substitute code from the caller's working directory or parent.
		candidates = []string{
			filepath.Join(filepath.Dir(executable), "engine"),
			filepath.Join(filepath.Dir(executable), "..", "lib", "tmatrix", "engine"),
			filepath.Join(filepath.Dir(executable), "..", "staging", "engine"),
		}
	}
	for _, candidate := range candidates {
		abs, err := filepath.Abs(candidate)
		if err != nil {
			continue
		}
		entry, err := os.ReadFile(filepath.Join(abs, "dist", "index.js"))
		if err != nil || !strings.Contains(string(entry), "TMATRIX_CONTROL_FILE") || !strings.Contains(string(entry), "TMATRIX_INTAKE_PAUSED") {
			continue
		}
		if info, err := os.Stat(filepath.Join(abs, "dist", "local-control-server.js")); err == nil && !info.IsDir() {
			return abs, nil
		}
	}
	return "", errors.New("compatible TMatrix engine not found; run sh scripts/stage-engine.sh in the tmatrix directory or set TMATRIX_ENGINE_DIR to a release engine")
}

func StartEngine(ctx context.Context, dir string, cfg config.Config) error {
	return runEngine(ctx, dir, cfg, false)
}

// RunDaemon owns the child until it exits so systemd can supervise the runtime.
func RunDaemon(ctx context.Context, dir string, cfg config.Config) error {
	return runEngine(ctx, dir, cfg, true)
}

func runEngine(ctx context.Context, dir string, cfg config.Config, foreground bool) error {
	if runtime.GOOS == "windows" {
		return errors.New("the v1 live engine requires WSL; run TMatrix inside WSL (the native Windows binary supports the demo)")
	}
	if err := config.Validate(cfg); err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return errors.New("cannot create TMatrix configuration directory")
	}
	lock, err := os.OpenFile(filepath.Join(dir, "start.lock"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return errors.New("engine startup already in progress (if a launch crashed, inspect and remove start.lock)")
	}
	lock.Close()
	defer os.Remove(filepath.Join(dir, "start.lock"))
	path := config.DiscoveryPath(dir)
	if _, err := os.Lstat(path); err == nil {
		client, err := backend.NewHTTP(path)
		if err != nil {
			return err
		}
		probe, cancel := context.WithTimeout(ctx, time.Second)
		_, err = client.Snapshot(probe)
		cancel()
		if err == nil {
			if foreground {
				return errors.New("engine already running; drain it before starting the service")
			}
			return nil
		}
		var old struct {
			PID int `json:"pid"`
		}
		data, _ := os.ReadFile(path)
		if json.Unmarshal(data, &old) != nil || processExists(old.PID) {
			return errors.New("existing engine is unavailable; inspect it before starting another poller")
		}
		if err := os.Remove(path); err != nil {
			return errors.New("cannot remove exited engine discovery record")
		}
	}
	key, err := config.LoadAPIKey(dir)
	if err != nil {
		return err
	}
	if key == "" {
		return errors.New("connect Tzu Do in TMatrix first (press c)")
	}
	engineDir, err := FindEngine(cfg.EngineDir)
	if err != nil {
		return err
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return errors.New("Node.js 20.19 or 22.12+ is required by the engine")
	}
	// Validate dependencies without starting the poller or authenticating remotely.
	prerequisites := "const [major,minor]=process.versions.node.split('.').map(Number);if(!((major===20&&minor>=19)||(major===22&&minor>=12)||major>22))process.exit(1);await import('pino');await import('zod');await import('ws');"
	if cfg.WorkerType == "codex" {
		prerequisites += "import.meta.resolve('@openai/codex/bin/codex.js');"
	} else {
		// Older bundles ignore adapter configuration and would run Codex instead.
		prerequisites += "await import('./dist/adapter-loader.js');"
	}
	check := exec.CommandContext(ctx, node, "--input-type=module", "-e", prerequisites)
	check.Dir = engineDir
	if check.Run() != nil {
		return errors.New("engine prerequisites missing; install Node.js 20.19 or 22.12+ and run npm ci --omit=dev in the engine directory")
	}
	engineConfig := map[string]any{
		"poll_url": cfg.PollURL, "instance_id": cfg.InstanceID,
		"max_workers": cfg.MaxWorkers, "poll_interval_ms": cfg.PollIntervalMS,
		"idle_backoff_max_ms": max(60_000, cfg.PollIntervalMS),
		"shutdown_grace_ms":   -1, "log_dir": filepath.Join(dir, "logs"),
		"pretty_logs":     false,
		"runtime_adapter": cfg.WorkerType,
	}
	if cfg.AdapterModule != "" {
		engineConfig["adapter_module"] = cfg.AdapterModule
	}
	data, _ := json.MarshalIndent(engineConfig, "", "  ")
	engineConfigPath := filepath.Join(dir, "engine.json")
	if err := privateWrite(engineConfigPath, data); err != nil {
		return err
	}
	logPath := filepath.Join(dir, "engine-launch.log")
	if info, statErr := os.Lstat(logPath); statErr == nil && !info.Mode().IsRegular() {
		return errors.New("engine launch log must be a regular private file")
	} else if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return errors.New("cannot inspect engine launch log")
	}
	log, err := os.OpenFile(logPath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0600)
	if err != nil {
		return errors.New("cannot open private engine launch log")
	}
	defer log.Close()
	if err := log.Chmod(0600); err != nil {
		return errors.New("cannot protect engine launch log")
	}
	cmd := exec.Command(node, filepath.Join(engineDir, "dist", "index.js"))
	cmd.Dir = engineDir
	cmd.Env = engineEnvironment(os.Environ(), map[string]string{
		"CONFIG_PATH": engineConfigPath, "API_KEY": key,
		"TMATRIX_CONTROL_FILE": path, "TMATRIX_CONTROL_PORT": "0", "TMATRIX_INTAKE_PAUSED": "1",
	})
	cmd.Stdout, cmd.Stderr = log, log
	if !foreground {
		detach(cmd)
	}
	signals := make(chan os.Signal, 1)
	if foreground {
		signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
		defer signal.Stop(signals)
	}
	if err := cmd.Start(); err != nil {
		return errors.New("cannot start worker engine")
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	timer := time.NewTimer(12 * time.Second)
	defer timer.Stop()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			_ = cmd.Process.Kill() // This startup is paused; no workers were admitted.
			return ctx.Err()
		case <-done:
			return errors.New("engine exited during startup; inspect the private engine-launch.log")
		case <-timer.C:
			_ = cmd.Process.Kill()
			return errors.New("engine did not expose its control interface; rebuild the TMatrix engine adapter")
		case <-tick.C:
			client, err := backend.NewHTTP(path)
			if err != nil {
				continue
			}
			probe, cancel := context.WithTimeout(ctx, time.Second)
			_, err = client.Snapshot(probe)
			cancel()
			if err == nil {
				if cfg.ResumeIntake {
					paused := false
					if err := client.Configure(ctx, backend.Settings{IntakePaused: &paused}); err != nil {
						_ = client.Shutdown(context.Background())
						return err
					}
				}
				if !foreground {
					return nil
				}
				_ = os.Remove(filepath.Join(dir, "start.lock"))
				select {
				case err := <-done:
					return err
				case <-signals:
				case <-ctx.Done():
				}
				stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				err := client.Shutdown(stopCtx)
				cancel()
				if err != nil {
					_ = cmd.Process.Signal(syscall.SIGTERM)
				}
				return <-done
			}
		}
	}
}

func privateWrite(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".tmatrix-*")
	if err != nil {
		return errors.New("cannot create private engine configuration")
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(f.Name(), path)
	}
	if err != nil {
		return errors.New("cannot save private engine configuration")
	}
	return nil
}

func engineEnvironment(parent []string, overrides map[string]string) []string {
	// A TMatrix instance must not inherit another daemon's queue identity or
	// credentials. Preserve normal PATH, HOME and Codex account configuration.
	blocked := strings.Fields("RUNTIME_ADAPTER ADAPTER_MODULE POLL_URL API_KEY INSTANCE_ID SWARM_ID MAX_WORKERS MAX_TICKETS_PER_POLL POLL_INTERVAL_MS IDLE_BACKOFF_MAX_MS REQUEST_TIMEOUT_MS MAX_REQUEST_ATTEMPTS CONTROL_PING_INTERVAL_MS CONTROL_RECONNECT_MAX_MS SHUTDOWN_GRACE_MS METRICS_INTERVAL_MS LOG_LEVEL PRETTY_LOGS LOG_DIR LOG_ROTATE_SIZE LOG_ROTATE_INTERVAL LOG_MAX_FILES CONFIG_PATH TMATRIX_CONTROL_FILE TMATRIX_CONTROL_PORT TMATRIX_INTAKE_PAUSED")
	deny := map[string]bool{}
	for _, name := range blocked {
		deny[name] = true
	}
	var env []string
	for _, entry := range parent {
		name, _, _ := strings.Cut(entry, "=")
		if !deny[name] {
			env = append(env, entry)
		}
	}
	for name, value := range overrides {
		env = append(env, fmt.Sprintf("%s=%s", name, value))
	}
	return env
}
