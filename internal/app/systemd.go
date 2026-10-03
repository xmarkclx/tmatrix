package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"tmatrix/internal/config"
)

// systemdQuote escapes unit specifiers and command expansion as well as quotes.
func systemdQuote(value string) (string, error) {
	if strings.ContainsAny(value, "\n\r\x00") {
		return "", errors.New("service paths must not contain control characters")
	}
	value = strings.NewReplacer("\\", "\\\\", "\"", "\\\"", "%", "%%", "$", "$$").Replace(value)
	return "\"" + value + "\"", nil
}

func serviceUnit(executable, dir, path string) (string, error) {
	exe, err := systemdQuote(executable)
	if err != nil {
		return "", err
	}
	cfg, err := systemdQuote(dir)
	if err != nil {
		return "", err
	}
	// Environment= does not perform shell dollar expansion.
	env, err := systemdQuote("PATH=" + path)
	if err != nil {
		return "", err
	}
	env = strings.ReplaceAll(env, "$$", "$")
	return fmt.Sprintf(`# Managed by tmatrix service install
[Unit]
Description=TMatrix AI worker daemon

[Service]
Type=simple
ExecStart=%s --config-dir %s daemon
Environment=%s
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=infinity
UMask=0077

[Install]
WantedBy=default.target
`, exe, cfg, env), nil
}

// ManageService installs and starts the user unit after draining this instance.
func ManageService(dir, action string) error {
	return manageService(dir, action, os.Stdout)
}

// ManageService keeps subprocess output out of the terminal UI.
func (s *Service) ManageService(action string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return manageService(s.Dir, action, io.Discard)
}

func manageService(dir, action string, output io.Writer) error {
	if action == "install" {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := PrepareUpgrade(ctx, dir); err != nil {
			return err
		}
	}
	if runtime.GOOS == "darwin" {
		return manageLaunchAgent(dir, action, output)
	}
	if runtime.GOOS != "linux" {
		return errors.New("service installation requires macOS/launchd or Linux/systemd (including WSL with systemd enabled)")
	}
	if action != "install" && action != "uninstall" {
		return errors.New("use service install or service uninstall")
	}
	home, err := os.UserConfigDir()
	if err != nil {
		return err
	}
	unitPath := filepath.Join(home, "systemd", "user", "tmatrix.service")
	control := func(args ...string) error {
		cmd := exec.Command("systemctl", append([]string{"--user"}, args...)...)
		data, err := cmd.CombinedOutput()
		if err != nil {
			return fmt.Errorf("systemctl %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(data)))
		}
		return nil
	}
	if content, err := os.ReadFile(unitPath); err == nil {
		if !strings.HasPrefix(string(content), "# Managed by tmatrix service install\n") {
			return errors.New("refusing to change an unmanaged tmatrix.service")
		}
		quoted, err := systemdQuote(dir)
		if err != nil {
			return err
		}
		if !strings.Contains(string(content), " --config-dir "+quoted+" daemon\n") {
			return errors.New("tmatrix.service belongs to another configuration directory; use that configuration to manage it")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if action == "uninstall" {
		if err := control("disable", "--now", "tmatrix.service"); err != nil {
			return err
		}
		if err := os.Remove(unitPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := control("daemon-reload"); err != nil {
			return err
		}
		fmt.Fprintln(output, "Service removed. Settings, credentials and conversation state retained.")
		return nil
	}
	cfg, err := config.Load(dir)
	if err != nil {
		return err
	}
	key, err := config.LoadAPIKey(dir)
	if err != nil {
		return err
	}
	if key == "" {
		return errors.New("connect in TMatrix before installing the service")
	}
	engine, err := FindEngine(cfg.EngineDir)
	if err != nil {
		return err
	}
	cfg.EngineDir = engine
	if err := config.Save(dir, cfg); err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	if strings.Contains(executable, "/go-build") {
		return errors.New("build a permanent binary before installing the service")
	}
	unit, err := serviceUnit(executable, dir, os.Getenv("PATH"))
	if err != nil {
		return err
	}
	for _, name := range []string{"CODEX_HOME", "XDG_STATE_HOME"} {
		if value := os.Getenv(name); value != "" {
			quoted, err := systemdQuote(name + "=" + value)
			if err != nil {
				return err
			}
			unit = strings.Replace(unit, "[Service]\n", "[Service]\nEnvironment="+strings.ReplaceAll(quoted, "$$", "$")+"\n", 1)
		}
	}
	if err := os.MkdirAll(filepath.Dir(unitPath), 0700); err != nil {
		return err
	}
	if err := privateWrite(unitPath, []byte(unit)); err != nil {
		return err
	}
	if err := control("daemon-reload"); err != nil {
		return err
	}
	if err := control("enable", "tmatrix.service"); err != nil {
		return err
	}
	fmt.Fprintln(output, "Draining existing TMatrix workers before starting the service…")
	if err := startInstalledService(context.Background(), dir, control); err != nil {
		return fmt.Errorf("service installed and enabled, but startup failed: %w", err)
	}
	fmt.Fprintln(output, "Service enabled and started. For startup before login: sudo loginctl enable-linger \"$USER\".")
	return nil
}

// Stop the supervisor first so it cannot race the standalone engine's drain.
// Neither systemd stop nor drainConnection imposes a deadline on active work.
func startInstalledService(ctx context.Context, dir string, control func(...string) error) error {
	if err := control("stop", "tmatrix.service"); err != nil {
		return err
	}
	service := &Service{Dir: dir}
	if err := service.drainConnection(ctx); err != nil {
		return fmt.Errorf("cannot drain existing engine: %w", err)
	}
	if err := control("start", "tmatrix.service"); err != nil {
		return err
	}
	return waitServiceReady(ctx, dir, "systemctl --user status tmatrix.service")
}

func waitServiceReady(ctx context.Context, dir, diagnostic string) error {
	service := &Service{Dir: dir}
	// Supervisors acknowledge process launch, not engine readiness.
	ready, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		if client, err := service.client(); err == nil {
			if _, err := client.Snapshot(ready); err == nil {
				return nil
			}
		}
		select {
		case <-ready.Done():
			return fmt.Errorf("service did not become ready; inspect %s", diagnostic)
		case <-tick.C:
		}
	}
}

// StartConsole respects an installed supervisor instead of racing it with a
// detached child when the service is stopped or recovering from a crash.
func (s *Service) StartConsole(ctx context.Context) error {
	return s.startConsole(ctx, false)
}

func (s *Service) startConsole(ctx context.Context, restart bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !restart {
		// A draining daemon keeps its bridge open so the console can monitor
		// admitted work. Starting its unit would cancel the installer's stop
		// job and then wait for that same drain instead of opening the console.
		if client, err := s.client(); err == nil {
			probe, cancel := context.WithTimeout(ctx, time.Second)
			_, err = client.Snapshot(probe)
			cancel()
			if err == nil {
				return nil
			}
		}
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	if runtime.GOOS == "darwin" {
		return s.startLaunchAgentConsole(ctx, restart)
	}
	if runtime.GOOS == "linux" {
		home, err := os.UserConfigDir()
		if err != nil {
			return err
		}
		content, err := os.ReadFile(filepath.Join(home, "systemd", "user", "tmatrix.service"))
		quoted, quoteErr := systemdQuote(s.Dir)
		if err == nil && quoteErr == nil && strings.HasPrefix(string(content), "# Managed by tmatrix service install\n") && strings.Contains(string(content), " --config-dir "+quoted+" daemon\n") {
			action := "start"
			if restart {
				// Wait for the old supervisor to exit before launching its replacement.
				action = "restart"
			}
			// Refuse conflicting jobs rather than replacing an upgrade's stop
			// request if its bridge disappeared between the probe and this call.
			cmd := exec.CommandContext(ctx, "systemctl", "--user", "--job-mode=fail", action, "tmatrix.service")
			if err := cmd.Run(); err != nil {
				return errors.New("cannot start installed TMatrix service (it may be draining for an upgrade); inspect tmatrix status and systemctl --user status tmatrix.service")
			}
			return nil
		}
	}
	return s.Start(ctx)
}
