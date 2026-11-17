package app

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"

	"tmatrix/internal/config"
)

// RecoverConversation runs an offline engine utility; it never starts a poller.
func RecoverConversation(ctx context.Context, dir, engineOverride, task string, confirmed bool, sourceID ...string) error {
	cfg, err := config.Load(dir)
	if err != nil {
		return err
	}
	selected := ""
	if len(sourceID) > 0 {
		selected = sourceID[0]
	}
	var source config.Source
	if selected == "" && len(cfg.Sources) == 1 {
		source = cfg.Sources[0]
	} else {
		for _, candidate := range cfg.Sources {
			if candidate.ID == selected {
				source = candidate
				break
			}
		}
	}
	if source.ID == "" {
		return errors.New("select a configured source with --source <source-id> for conversation recovery")
	}
	if engineOverride == "" {
		engineOverride = cfg.EngineDir
	}
	engine, err := FindEngine(engineOverride)
	if err != nil {
		return err
	}
	args := []string{filepath.Join(engine, "dist", "recover-conversation.js"), source.PollURL, task, "--namespace", source.ConversationNamespace}
	if confirmed {
		args = append(args, "--confirm-runtime-stopped")
	}
	cmd := exec.CommandContext(ctx, "node", args...)
	cmd.Env = engineEnvironment(os.Environ(), nil)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd.Run()
}
