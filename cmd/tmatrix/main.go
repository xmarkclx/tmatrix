package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/term"
	"tmatrix/internal/app"
	"tmatrix/internal/backend"
	"tmatrix/internal/config"
	"tmatrix/internal/tui"
	"tmatrix/internal/update"
)

var version = "dev"
var commit = "local"
var commitCount = "unknown"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "TMatrix:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	flags := flag.NewFlagSet("tmatrix", flag.ContinueOnError)
	demo := flags.Bool("demo", false, "use fictional workers without network or configuration writes")
	mouse := flags.Bool("mouse", true, "enable mouse navigation (default on; --mouse=false disables)")
	noMouse := flags.Bool("no-mouse", false, "disable mouse capture for terminal text selection")
	terminal := flags.String("terminal", "auto", "rendering: auto (portable over SSH), portable, rich")
	color := flags.String("color", "auto", "color capability: auto, 16, 256, truecolor, none (NO_COLOR takes precedence)")
	configDir := flags.String("config-dir", "", "private TMatrix settings directory")
	engineDir := flags.String("engine-dir", "", "directory containing the TMatrix engine dist/index.js")
	showVersion := flags.Bool("version", false, "print version")
	flags.Usage = func() {
		fmt.Fprintln(flags.Output(), "TMatrix — workers, within reach.\n\nUsage: tmatrix [flags] [update [--prefix /absolute/path]|setup|engine start|engine stop|engine restart|daemon|conversation recover <task-id> [--confirm-runtime-stopped]|service install|service uninstall|status]\n\nNo arguments opens the terminal console. q detaches without stopping workers.\nConnect with c. Saving a connection starts task intake automatically. Space pauses/resumes intake; subsequent launches restore the saved preference.")
		flags.PrintDefaults()
	}
	if err := flags.Parse(args); errors.Is(err, flag.ErrHelp) {
		return nil
	} else if err != nil {
		return err
	}
	if *showVersion {
		fmt.Println(buildVersion())
		return nil
	}
	if command := flags.Args(); len(command) > 0 && command[0] == "update" {
		if *demo || *configDir != "" || *engineDir != "" {
			return errors.New("update uses the installed release and its saved settings; omit --demo, --config-dir and --engine-dir")
		}
		updateFlags := flag.NewFlagSet("tmatrix update", flag.ContinueOnError)
		prefix := updateFlags.String("prefix", "", "installation prefix (default: TMATRIX_PREFIX, current release prefix, or ~/.local)")
		updateFlags.Usage = func() {
			fmt.Fprintln(updateFlags.Output(), "Usage: tmatrix update [--prefix /absolute/path]\n\nInstall the latest official release using the checksum-verifying installer.\nExisting workers finish before the new engine starts; keep this command open.\nRequires sh, curl, tar, install, Node.js and npm (macOS can install missing runtimes).")
			updateFlags.PrintDefaults()
		}
		if err := updateFlags.Parse(command[1:]); errors.Is(err, flag.ErrHelp) {
			return nil
		} else if err != nil {
			return err
		}
		if updateFlags.NArg() != 0 {
			return errors.New("unexpected update arguments; see tmatrix update --help")
		}
		return update.Run(*prefix, os.Stdin, os.Stdout, os.Stderr)
	}
	portable, profile, err := terminalSettings(*terminal, *color, os.Getenv)
	if err != nil {
		return err
	}
	if len(flags.Args()) == 0 && (!term.IsTerminal(os.Stdin.Fd()) || !term.IsTerminal(os.Stdout.Fd())) {
		return errors.New("the console needs an interactive terminal; connect using ssh -t host tmatrix (or use tmatrix status)")
	}
	lipgloss.SetColorProfile(profile)
	var service backend.Backend
	if *demo {
		if len(flags.Args()) > 0 {
			return errors.New("demo mode opens the console; omit engine/status commands")
		}
		service = backend.NewDemo()
	} else {
		dir := *configDir
		var err error
		if dir == "" {
			dir, err = config.DefaultDir()
		}
		if err != nil {
			return err
		}
		dir, err = filepath.Abs(dir)
		if err != nil {
			return err
		}
		command := flags.Args()
		if (len(command) == 3 || (len(command) == 4 && command[3] == "--confirm-runtime-stopped")) && command[0] == "conversation" && command[1] == "recover" {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			return app.RecoverConversation(ctx, dir, *engineDir, command[2], len(command) == 4)
		}
		live, err := app.New(dir, *engineDir)
		if err != nil {
			return err
		}
		service = live
		if len(command) > 0 {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			switch {
			case len(command) == 1 && command[0] == "setup":
				return live.SetupService()
			case len(command) == 1 && command[0] == "daemon":
				cfg, err := config.Load(dir)
				if err != nil {
					return err
				}
				return app.RunDaemon(context.Background(), dir, cfg)
			case len(command) == 2 && command[0] == "service":
				return app.ManageService(dir, command[1])
			case len(command) == 1 && command[0] == "status":
				snapshot, err := live.Snapshot(ctx)
				if err != nil {
					return err
				}
				// Deliberately exclude local transcript text and credentials from status.
				return json.NewEncoder(os.Stdout).Encode(map[string]any{"workers": snapshot.RunningWorkers, "max_workers": snapshot.MaxWorkers, "intake_paused": snapshot.IntakePaused, "poller": snapshot.Poller.Status})
			case len(command) == 2 && command[0] == "engine" && command[1] == "start":
				if err := live.Start(ctx); err != nil {
					return err
				}
				fmt.Println("TMatrix engine available. Saved intake preference restored; open tmatrix to manage workers.")
				return nil
			case len(command) == 2 && command[0] == "engine" && command[1] == "restart":
				// Active tasks may run for hours; only replacement startup is bounded.
				restartCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
				defer stop()
				fmt.Println("Restart requested. Pausing intake and waiting for active workers to finish; keep this command open.")
				if err := live.Restart(restartCtx); err != nil {
					return fmt.Errorf("restart incomplete (a requested drain continues); inspect tmatrix status before retrying: %w", err)
				}
				fmt.Println("TMatrix engine restarted and ready. Saved intake preference restored.")
				return nil
			case len(command) == 2 && command[0] == "engine" && command[1] == "stop":
				if err := live.Shutdown(ctx); err != nil {
					return err
				}
				fmt.Println("Shutdown requested. Intake is paused; the engine exits after active workers finish. Reattach to monitor or stop individual workers.")
				return nil
			default:
				return errors.New("unknown command; see tmatrix --help")
			}
		}
		key, err := config.LoadAPIKey(dir)
		if err != nil {
			return err
		}
		if key != "" {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			err := live.StartConsole(ctx)
			cancel()
			if err != nil {
				return err
			}
		}
	}
	options := []tea.ProgramOption{tea.WithAltScreen()}
	if *mouse && !*noMouse {
		options = append(options, tea.WithMouseCellMotion())
	}
	_, err = tea.NewProgram(tui.New(service, tui.Options{Demo: *demo, Portable: portable, NoMouse: !*mouse || *noMouse}), options...).Run()
	return err
}
