package app

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"

	"tmatrix/internal/config"
)

// RecoverConversation runs an offline engine utility; it never starts a poller.
func RecoverConversation(ctx context.Context, dir, engineOverride, task string, confirmed bool) error {
	cfg, err := config.Load(dir)
	if err != nil {
		return err
	}
	if engineOverride == "" {
		engineOverride = cfg.EngineDir
	}
	engine, err := FindEngine(engineOverride)
	if err != nil {
		return err
	}
	args := []string{filepath.Join(engine, "dist", "recover-conversation.js"), cfg.PollURL, task}
	if confirmed {
		args = append(args, "--confirm-runtime-stopped")
	}
	cmd := exec.CommandContext(ctx, "node", args...)
	cmd.Env = engineEnvironment(os.Environ(), nil)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd.Run()
}
