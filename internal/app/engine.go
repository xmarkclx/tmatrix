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
	"sync"
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

func sourceEngine(cfg config.Config) (string, error) {
	engine, err := FindEngine(cfg.EngineDir)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(filepath.Join(engine, "dist", "source-supervisor.js"))
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("engine update needed for multiple sources; install or build the matching TMatrix engine")
	}
	if cfg.WorkerType == "claude" {
		info, err := os.Stat(filepath.Join(engine, "dist", "adapters", "claude", "index.js"))
		if err != nil || !info.Mode().IsRegular() {
			return "", errors.New("engine update needed for Claude. Install or build a TMatrix engine with the Claude adapter")
		}
	}
	if cfg.EffectiveRuntimePolicy() != "" {
		info, err := os.Stat(filepath.Join(engine, "dist", "runtime-routing.js"))
		if err != nil || !info.Mode().IsRegular() {
			return "", errors.New("engine update needed for runtime routing. Install or build the matching TMatrix engine")
		}
	}
	return engine, nil
}

func StartEngine(ctx context.Context, dir string, cfg config.Config) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		return errors.New("the v1 live engine requires WSL; run TMatrix inside WSL (the native Windows binary supports the demo)")
	}
	if err := config.Validate(cfg); err != nil {
		return err
	}
	if len(cfg.Sources) == 0 {
		return errors.New("add a source in TMatrix first (press c)")
	}
	if client, err := backend.NewHTTP(config.DiscoveryPath(dir)); err == nil {
		probe, cancel := context.WithTimeout(ctx, time.Second)
		_, err = client.Snapshot(probe)
		cancel()
		if err == nil {
			return nil
		}
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(executable, "--config-dir", dir, "--engine-dir", cfg.EngineDir, "daemon")
	var diagnostics startupDiagnostics
	cmd.Stderr = &diagnostics
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return errors.New("cannot start engine supervisor")
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	stop := func() {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		<-done
	}
	timer := time.NewTimer(15 * time.Second)
	defer timer.Stop()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			stop()
			return ctx.Err()
		case <-timer.C:
			stop()
			return errors.New("engine supervisor did not become ready; inspect the private engine-launch.log")
		case <-done:
			return fmt.Errorf("engine supervisor exited during startup: %s; inspect the private engine-launch.log", strings.TrimSpace(string(diagnostics)))
		case <-tick.C:
			if _, err := os.Lstat(filepath.Join(dir, "start.lock")); !errors.Is(err, os.ErrNotExist) {
				continue
			}
			client, err := backend.NewHTTP(config.DiscoveryPath(dir))
			if err != nil {
				continue
			}
			probe, cancel := context.WithTimeout(ctx, time.Second)
			_, err = client.Snapshot(probe)
			cancel()
			if err == nil {
				return nil
			}
		}
	}
}

// RunDaemon owns the child until it exits so systemd can supervise the runtime.
func RunDaemon(ctx context.Context, dir string, cfg config.Config) error {
	if err := config.Validate(cfg); err != nil {
		return err
	}
	if len(cfg.Sources) == 0 {
		return nil
	}
	return runEngine(ctx, dir, cfg)
}

func runEngine(ctx context.Context, dir string, cfg config.Config) error {
	ctx, cancelSignals := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer cancelSignals()
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
	releaseLock := sync.OnceFunc(func() { _ = os.Remove(filepath.Join(dir, "start.lock")) })
	defer releaseLock()
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
			return errors.New("engine already running; drain it before starting the service")
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
	if len(cfg.Sources) == 0 {
		return errors.New("add a source in TMatrix first (press c)")
	}
	engineDir, err := sourceEngine(cfg)
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
		"instance_id": cfg.InstanceID, "update_origin": cfg.UpdateOrigin,
		"max_workers": cfg.MaxWorkers, "poll_interval_ms": cfg.PollIntervalMS,
		"idle_backoff_max_ms": max(60_000, cfg.PollIntervalMS),
		"shutdown_grace_ms":   -1, "log_dir": filepath.Join(dir, "logs"),
		"pretty_logs":     false,
		"runtime_adapter": cfg.WorkerType,
	}
	sources := make([]map[string]string, 0, len(cfg.Sources))
	for _, source := range cfg.Sources {
		path, err := config.CredentialPath(dir, source.CredentialID)
		if err != nil {
			return err
		}
		sources = append(sources, map[string]string{"id": source.ID, "name": source.Name, "poll_url": source.PollURL, "instance_id": source.InstanceID, "credential_file": path, "conversation_namespace": source.ConversationNamespace})
	}
	engineConfig["sources"] = sources
	if cfg.AdapterModule != "" {
		engineConfig["adapter_module"] = cfg.AdapterModule
	}
	if cfg.EffectiveRuntimePolicy() != "" {
		engineConfig["runtime_policy"] = cfg.EffectiveRuntimePolicy()
	}
	if cfg.ClaudeModel != "" {
		engineConfig["claude_model"] = cfg.ClaudeModel
	}
	data, _ := json.MarshalIndent(engineConfig, "", "  ")
	engineConfigPath := filepath.Join(dir, "engine.json")
	sourceSettingsFile, err := filepath.Abs(filepath.Join(dir, config.ConfigFilename))
	if err != nil {
		return errors.New("cannot locate TMatrix source settings")
	}
	if err := privateWrite(engineConfigPath, data); err != nil {
		return err
	}
	log, err := newLaunchLog(filepath.Join(dir, "engine-launch.log"), 10*1024*1024, 3)
	if err != nil {
		return fmt.Errorf("cannot open private engine launch log: %w", err)
	}
	defer log.Close()
	cmd := exec.Command(node, filepath.Join(engineDir, "dist", "index.js"))
	cmd.Dir = engineDir
	cmd.Env = engineEnvironment(os.Environ(), map[string]string{
		"CONFIG_PATH":                  engineConfigPath,
		"TMATRIX_SOURCE_SETTINGS_FILE": sourceSettingsFile,
		"TMATRIX_CONTROL_FILE":         path, "TMATRIX_CONTROL_PORT": "0", "TMATRIX_INTAKE_PAUSED": "1",
	})
	output := &engineLogOutput{log: log, errors: make(chan error, 1)}
	cmd.Stdout, cmd.Stderr = output, output
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
			stopPausedEngine(cmd, done)
			return ctx.Err()
		case err := <-output.errors:
			stopPausedEngine(cmd, done)
			return fmt.Errorf("engine launch log failed: %w", err)
		case <-done:
			return errors.New("engine exited during startup; inspect the private engine-launch.log")
		case <-timer.C:
			stopPausedEngine(cmd, done)
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
						_ = cmd.Process.Signal(syscall.SIGTERM)
						<-done
						return err
					}
				}
				releaseLock()
				var logErr error
				select {
				case logErr = <-output.errors:
				case err := <-done:
					return err
				case <-ctx.Done():
				}
				stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				err := client.Shutdown(stopCtx)
				cancel()
				if err != nil {
					_ = cmd.Process.Signal(syscall.SIGTERM)
				}
				childErr := <-done
				if logErr != nil {
					return fmt.Errorf("engine launch log failed: %w", logErr)
				}
				return childErr
			}
		}
	}
}

type startupDiagnostics []byte

func (d *startupDiagnostics) Write(p []byte) (int, error) {
	*d = append(*d, p[:min(len(p), 4096-len(*d))]...)
	return len(p), nil
}

func stopPausedEngine(cmd *exec.Cmd, done <-chan error) {
	_ = cmd.Process.Signal(syscall.SIGTERM)
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
		_ = cmd.Process.Kill()
		<-done
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
	blocked := strings.Fields("RUNTIME_ADAPTER RUNTIME_POLICY ADAPTER_MODULE POLL_URL API_KEY INSTANCE_ID SWARM_ID MAX_WORKERS MAX_TICKETS_PER_POLL POLL_INTERVAL_MS IDLE_BACKOFF_MAX_MS REQUEST_TIMEOUT_MS MAX_REQUEST_ATTEMPTS CONTROL_PING_INTERVAL_MS CONTROL_RECONNECT_MAX_MS SHUTDOWN_GRACE_MS METRICS_INTERVAL_MS LOG_LEVEL PRETTY_LOGS LOG_DIR LOG_ROTATE_SIZE LOG_ROTATE_INTERVAL LOG_MAX_FILES CONFIG_PATH TMATRIX_CONTROL_FILE TMATRIX_CONTROL_PORT TMATRIX_INTAKE_PAUSED TMATRIX_SOURCE_SETTINGS_FILE")
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
