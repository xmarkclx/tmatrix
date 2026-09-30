package app

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"tmatrix/internal/config"
)

// SetupService defers first-time service startup until credentials are saved.
// Release directories remain immutable while the previous engine drains.
func (s *Service) SetupService() error {
	if err := os.WriteFile(filepath.Join(s.Dir, "install-service-on-connect"), []byte("1\n"), 0600); err != nil {
		return err
	}
	key, err := config.LoadAPIKey(s.Dir)
	if err != nil {
		return err
	}
	if key == "" {
		fmt.Println("Service setup queued. Authenticate Codex, then open tmatrix and connect with c; the service will be installed automatically.")
		return nil
	}
	return s.finishServiceSetup()
}

func (s *Service) finishServiceSetup() error {
	if err := manageService(s.Dir, "install", io.Discard); err != nil {
		return err
	}
	err := os.Remove(filepath.Join(s.Dir, "install-service-on-connect"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
