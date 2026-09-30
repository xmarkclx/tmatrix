package app

import (
	"os"
	"path/filepath"
	"time"

	"tmatrix/internal/config"
)

// A short-lived heartbeat shares restart intent with other console processes.
// Expiration avoids promising a restart after its coordinator crashes.
func (s *Service) trackRestart() (func(), error) {
	path := filepath.Join(s.Dir, "restart-pending-"+config.NewID())
	if err := os.WriteFile(path, nil, 0600); err != nil {
		return nil, err
	}
	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case now := <-ticker.C:
				_ = os.Chtimes(path, now, now)
			case <-stop:
				return
			}
		}
	}()
	return func() { close(stop); <-done; _ = os.Remove(path) }, nil
}

func (s *Service) restartPending() bool {
	paths, _ := filepath.Glob(filepath.Join(s.Dir, "restart-pending-*"))
	for _, path := range paths {
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		age := time.Since(info.ModTime())
		if age >= 0 && age < 5*time.Second {
			return true
		}
	}
	return false
}
