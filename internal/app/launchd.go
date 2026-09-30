package app

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"tmatrix/internal/config"
)

const launchAgentLabel = "app.tmatrix.worker"
const launchAgentMarker = "<!-- Managed by tmatrix service install -->"

func plistString(value string) (string, error) {
	var b bytes.Buffer
	if err := xml.EscapeText(&b, []byte(value)); err != nil {
		return "", err
	}
	// EscapeText replaces invalid XML characters; reject instead of changing paths.
	for _, r := range value {
		if r < 32 || r == 0xfffd {
			return "", errors.New("service paths must not contain control or invalid characters")
		}
	}
	return "<string>" + b.String() + "</string>", nil
}

func launchAgentPlist(executable, dir string) (string, error) {
	var args strings.Builder
	for _, value := range []string{executable, "--config-dir", dir, "daemon"} {
		item, err := plistString(value)
		if err != nil {
			return "", err
		}
		args.WriteString(item)
	}
	var env strings.Builder
	for _, name := range []string{"PATH", "CODEX_HOME", "XDG_STATE_HOME"} {
		if value := os.Getenv(name); value != "" {
			item, err := plistString(value)
			if err != nil {
				return "", err
			}
			fmt.Fprintf(&env, "<key>%s</key>%s", name, item)
		}
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
%s
<plist version="1.0"><dict>
<key>Label</key><string>%s</string>
<key>ProgramArguments</key><array>%s</array>
<key>EnvironmentVariables</key><dict>%s</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>5</integer>
<key>ExitTimeOut</key><integer>0</integer>
<key>Umask</key><integer>63</integer>
</dict></plist>
`, launchAgentMarker, launchAgentLabel, args.String(), env.String()), nil
}

func launchAgentPath() (string, error) {
	home, err := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", launchAgentLabel+".plist"), err
}

func ownedLaunchAgent(path, dir string) (bool, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	cfg, err := plistString(dir)
	if err != nil {
		return false, err
	}
	if !strings.Contains(string(data), launchAgentMarker) || !strings.Contains(string(data), "<string>--config-dir</string>"+cfg+"<string>daemon</string>") {
		return false, errors.New("refusing to change an unmanaged LaunchAgent or one belonging to another configuration directory")
	}
	return true, nil
}

func launchControl(ctx context.Context, args ...string) error {
	data, err := exec.CommandContext(ctx, "launchctl", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("launchctl %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(data)))
	}
	return nil
}

func launchDomain() string { return fmt.Sprintf("gui/%d", os.Getuid()) }

// Only ESRCH (113 from launchctl) means absent. Permission/domain failures must
// not be mistaken for an unloaded job, or a second engine could be started.
func launchAgentLoaded(control func(...string) error) (bool, error) {
	err := control("print", launchDomain()+"/"+launchAgentLabel)
	if err == nil {
		return true, nil
	}
	var status *exec.ExitError
	if errors.As(err, &status) && status.ExitCode() == 113 {
		return false, nil
	}
	return false, err
}

func stopLaunchAgent(dir string, control func(...string) error) error {
	loaded, err := launchAgentLoaded(control)
	if err != nil {
		return err
	}
	if !loaded {
		return nil
	}
	// Drain through the bridge before bootout can signal the entire process group.
	// A clean daemon exit does not trigger SuccessfulExit=false recovery.
	if err := (&Service{Dir: dir}).drainConnection(context.Background()); err != nil {
		return err
	}
	return control("bootout", launchDomain()+"/"+launchAgentLabel)
}

func manageLaunchAgent(dir, action string, output io.Writer) error {
	if action != "install" && action != "uninstall" {
		return errors.New("use service install or service uninstall")
	}
	path, err := launchAgentPath()
	if err != nil {
		return err
	}
	owned, err := ownedLaunchAgent(path, dir)
	if err != nil {
		return err
	}
	control := func(args ...string) error { return launchControl(context.Background(), args...) }
	if action == "uninstall" {
		if owned {
			if err := stopLaunchAgent(dir, control); err != nil {
				return err
			}
			if err := os.Remove(path); err != nil {
				return err
			}
		}
		fmt.Fprintln(output, "LaunchAgent removed. Settings, credentials and conversation state retained.")
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
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	if strings.Contains(executable, "/go-build") {
		return errors.New("build a permanent binary before installing the service")
	}
	plist, err := launchAgentPlist(executable, dir)
	if err != nil {
		return err
	}
	// Reject a loaded service whose on-disk ownership cannot be verified.
	if !owned {
		loaded, err := launchAgentLoaded(control)
		if err != nil {
			return err
		}
		if loaded {
			return errors.New("refusing to replace a loaded LaunchAgent without an owned plist")
		}
	}
	fmt.Fprintln(output, "Draining existing TMatrix workers before starting the LaunchAgent…")
	if owned {
		if err := stopLaunchAgent(dir, control); err != nil {
			return err
		}
	}
	if err := (&Service{Dir: dir}).drainConnection(context.Background()); err != nil {
		return err
	}
	cfg.EngineDir = engine
	if err := config.Save(dir, cfg); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	if err := privateWrite(path, []byte(plist)); err != nil {
		return err
	}
	if err := control("enable", launchDomain()+"/"+launchAgentLabel); err != nil {
		return err
	}
	if err := control("bootstrap", launchDomain(), path); err != nil {
		return err
	}
	if err := waitServiceReady(context.Background(), dir, "launchctl print "+launchDomain()+"/"+launchAgentLabel); err != nil {
		return err
	}
	fmt.Fprintln(output, "LaunchAgent enabled and started; starts at login (not before login).")
	return nil
}

func (s *Service) startLaunchAgentConsole(ctx context.Context, restart bool) error {
	path, err := launchAgentPath()
	if err != nil {
		return err
	}
	owned, err := ownedLaunchAgent(path, s.Dir)
	if err != nil {
		return err
	}
	if !owned {
		return s.Start(ctx)
	}
	control := func(args ...string) error { return launchControl(ctx, args...) }
	if restart {
		if err := stopLaunchAgent(s.Dir, control); err != nil {
			return err
		}
	}
	loaded, err := launchAgentLoaded(control)
	if err != nil {
		return err
	}
	if !loaded {
		return control("bootstrap", launchDomain(), path)
	}
	// No -k: never kill active work when reopening the console.
	return control("kickstart", launchDomain()+"/"+launchAgentLabel)
}
