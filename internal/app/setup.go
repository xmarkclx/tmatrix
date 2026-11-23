package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
	"tmatrix/internal/config"
)

// SetupService defers first-time service startup until credentials are saved.
// A busy engine keeps its current installation and continues processing work.
func (s *Service) SetupService() error {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := PrepareUpgrade(ctx, s.Dir); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(s.Dir, "install-service-on-connect"), []byte("1\n"), 0600); err != nil {
		return err
	}
	cfg, err := config.Load(s.Dir)
	if err != nil {
		return err
	}
	if len(cfg.Sources) == 0 {
		fmt.Println("Service setup queued. Set up authentication for the worker runtime, then open tmatrix and connect with c. The service will install automatically.")
		return nil
	}
	return s.finishServiceSetup(os.Stdout)
}

func (s *Service) finishServiceSetup(output io.Writer) error {
	if err := manageService(s.Dir, "install", output); err != nil {
		return err
	}
	err := os.Remove(filepath.Join(s.Dir, "install-service-on-connect"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
