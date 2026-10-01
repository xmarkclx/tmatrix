package app

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"tmatrix/internal/backend"
	"tmatrix/internal/config"
)

// Service adds local persistence and process ownership to the bridge adapter.
// The terminal never needs to know a bearer token or run a shell command.
type Service struct {
	Dir string
	mu  sync.Mutex
}

func New(dir, engineDir string) (*Service, error) {
	cfg, err := config.Load(dir)
	if err != nil {
		return nil, err
	}
	if engineDir != "" {
		cfg.EngineDir = engineDir
	}
	if err := config.Save(dir, cfg); err != nil {
		return nil, err
	}
	return &Service{Dir: dir}, nil
}

func (s *Service) client() (*backend.HTTP, error) {
	return backend.NewHTTP(config.DiscoveryPath(s.Dir))
}

func (s *Service) Snapshot(ctx context.Context) (snapshot backend.Snapshot, snapshotErr error) {
	defer func() { snapshot.RestartPending = s.restartPending() }()
	client, err := s.client()
	if err == nil {
		return client.Snapshot(ctx)
	}
	if _, statErr := os.Stat(config.DiscoveryPath(s.Dir)); !errors.Is(statErr, os.ErrNotExist) {
		return backend.Snapshot{}, err
	}
	cfg, err := config.Load(s.Dir)
	if err != nil {
		return backend.Snapshot{}, err
	}
	return backend.Snapshot{
		Version: 1, InstanceID: cfg.InstanceID, MaxWorkers: cfg.MaxWorkers, RuntimeAdapter: cfg.WorkerType,
		PollIntervalMS: cfg.PollIntervalMS, IntakePaused: true,
		Poller:  backend.Poller{Type: cfg.PollerType, Status: "not_connected", URL: cfg.PollURL},
		Workers: []backend.Worker{},
	}, nil
}

func (s *Service) Steer(ctx context.Context, id, message string) (backend.Steering, error) {
	client, err := s.client()
	if err != nil {
		return backend.Steering{}, errors.New("engine is disconnected; reconnect before sending")
	}
	return client.Steer(ctx, id, message)
}

func (s *Service) Stop(ctx context.Context, id string) error {
	client, err := s.client()
	if err != nil {
		return errors.New("engine is disconnected; stop could not be requested")
	}
	return client.Stop(ctx, id)
}

func (s *Service) Pin(ctx context.Context, id string, pinned bool) error {
	client, err := s.client()
	if err != nil {
		return errors.New("engine is disconnected; pin could not be changed")
	}
	return client.Pin(ctx, id, pinned)
}

func (s *Service) Configure(ctx context.Context, settings backend.Settings) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := backend.ValidateSettings(settings); err != nil {
		return err
	}
	cfg, err := config.Load(s.Dir)
	if err != nil {
		return err
	}
	previous := cfg
	if settings.IntakePaused != nil {
		cfg.ResumeIntake = !*settings.IntakePaused
	}
	if settings.MaxWorkers != nil {
		cfg.MaxWorkers = *settings.MaxWorkers
	}
	if settings.PollIntervalMS != nil {
		cfg.PollIntervalMS = *settings.PollIntervalMS
	}
	if settings.WorkerType != nil && *settings.WorkerType != cfg.WorkerType {
		return errors.New("select worker_type and adapter_module together in config.json, then restart the engine")
	}
	if settings.PollerType != nil {
		cfg.PollerType = *settings.PollerType
	}
	if err := config.Save(s.Dir, cfg); err != nil {
		return err
	}
	client, err := s.client()
	if err != nil {
		if settings.IntakePaused != nil && !*settings.IntakePaused {
			if err = StartEngine(ctx, s.Dir, cfg); err != nil {
				return err
			}
			client, err = s.client()
		} else if _, statErr := os.Stat(config.DiscoveryPath(s.Dir)); errors.Is(statErr, os.ErrNotExist) {
			return nil
		}
	}
	if err != nil {
		return err
	}
	if err := client.Configure(ctx, settings); err != nil {
		_ = config.Save(s.Dir, previous)
		return err
	}
	return nil
}

func (s *Service) Connect(ctx context.Context, connection backend.Connection) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := config.ValidatePollURL(connection.URL); err != nil {
		return err
	}
	cfg, err := config.Load(s.Dir)
	if err != nil {
		return err
	}
	key := connection.APIKey
	if key == "" {
		key, err = config.LoadAPIKey(s.Dir)
	}
	if err != nil {
		return err
	}
	if err := config.ValidateAPIKey(key); err != nil {
		return err
	}
	if err := s.drainConnection(ctx); err != nil {
		return err
	}
	if err := config.SaveAPIKey(s.Dir, key); err != nil {
		return err
	}
	cfg.PollURL = connection.URL
	cfg.ResumeIntake = true
	if err := config.Save(s.Dir, cfg); err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(s.Dir, "install-service-on-connect")); err == nil {
		return s.finishServiceSetup(io.Discard)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := s.startConsole(ctx, true); err != nil {
		return err
	}
	// systemctl returns before the daemon has exposed its bridge. Report
	// completion only once the replacement has resumed intake.
	ready, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		if client, err := s.client(); err == nil {
			if snapshot, err := client.Snapshot(ready); err == nil && !snapshot.IntakePaused && snapshot.Poller.URL == connection.URL {
				return nil
			}
		}
		select {
		case <-ready.Done():
			return errors.New("connection saved, but restarted engine is not ready; inspect engine or service status")
		case <-tick.C:
		}
	}
}

// drainConnection leaves the old credentials in place until all admitted work
// finishes. Shutdown pauses intake and drains workers without interrupting them.
func (s *Service) drainConnection(ctx context.Context) error {
	if _, err := os.Lstat(config.DiscoveryPath(s.Dir)); errors.Is(err, os.ErrNotExist) {
		return ctx.Err()
	} else if err != nil {
		return errors.New("cannot inspect engine shutdown state")
	}
	client, err := s.client()
	if err != nil {
		return err
	}
	if err := client.Shutdown(ctx); err != nil {
		return err
	}
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if _, err := os.Lstat(config.DiscoveryPath(s.Dir)); errors.Is(err, os.ErrNotExist) {
			return nil
		} else if err != nil {
			return errors.New("cannot inspect engine shutdown state")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-tick.C:
		}
	}
}

func (s *Service) Start(ctx context.Context) error {
	cfg, err := config.Load(s.Dir)
	if err != nil {
		return err
	}
	return StartEngine(ctx, s.Dir, cfg)
}

// Restart waits without a drain deadline: admitted workers must finish before
// a replacement is launched. It preserves credentials and saved intake settings.
func (s *Service) Restart(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	finish, err := s.trackRestart()
	if err != nil {
		return err
	}
	defer finish()
	if err := s.drainConnection(ctx); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := s.startConsole(ctx, true); err != nil {
		return err
	}
	return waitServiceReady(ctx, s.Dir, "tmatrix status and the private engine-launch.log or installed service status")
}

func (s *Service) Shutdown(ctx context.Context) error {
	client, err := s.client()
	if err != nil {
		return errors.New("no reachable TMatrix engine; existing AI Worker services are managed separately")
	}
	return client.Shutdown(ctx)
}
