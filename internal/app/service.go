package app

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
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
	_, statErr := os.Lstat(filepath.Join(dir, config.ConfigFilename))
	if statErr == nil && (engineDir == "" || engineDir == cfg.EngineDir) {
		return &Service{Dir: dir}, nil
	}
	if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return nil, statErr
	}
	unlock, err := config.LockSettings(dir)
	if err != nil {
		return nil, err
	}
	defer unlock()
	cfg, err = config.Load(dir)
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
		snapshot, err = client.Snapshot(ctx)
		if err == nil {
			return snapshot, nil
		}
	}
	pid, pidErr := engineDiscoveryPID(config.DiscoveryPath(s.Dir))
	if !errors.Is(pidErr, os.ErrNotExist) && (pidErr != nil || processExists(pid)) {
		return backend.Snapshot{}, err
	}
	cfg, err := config.Load(s.Dir)
	if err != nil {
		return backend.Snapshot{}, err
	}
	return backend.Snapshot{
		Version: 2, InstanceID: cfg.InstanceID, MaxWorkers: cfg.MaxWorkers, RuntimeAdapter: cfg.WorkerType,
		PollIntervalMS: cfg.PollIntervalMS, IntakePaused: true,
		Pollers: savedPollers(cfg),
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

func (s *Service) CheckAdapterUpdate(ctx context.Context) error {
	client, err := s.client()
	if err != nil {
		return errors.New("engine is disconnected; runtime update check could not be requested")
	}
	return client.CheckAdapterUpdate(ctx)
}

func (s *Service) RollbackAdapterUpdate(ctx context.Context) error {
	client, err := s.client()
	if err != nil {
		return errors.New("engine is disconnected; runtime rollback could not be requested")
	}
	return client.RollbackAdapterUpdate(ctx)
}

func (s *Service) Configure(ctx context.Context, settings backend.Settings) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	unlock, err := config.LockSettings(s.Dir)
	if err != nil {
		return err
	}
	defer unlock()

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
	unlock, err := config.LockSettings(s.Dir)
	if err != nil {
		return err
	}
	defer unlock()

	if err := config.ValidatePollURL(connection.URL); err != nil {
		return err
	}
	cfg, err := config.Load(s.Dir)
	if err != nil {
		return err
	}
	if connection.SourceID == "" {
		return s.addSource(ctx, cfg, connection)
	}
	cfg.Sources = append([]config.Source{}, cfg.Sources...)
	index := -1
	var source config.Source
	for i, candidate := range cfg.Sources {
		if candidate.ID == connection.SourceID {
			index = i
			source = candidate
			break
		}
	}
	if index < 0 {
		return errors.New("source no longer exists")
	}
	source.Name = strings.TrimSpace(connection.Name)
	if source.PollURL != connection.URL {
		source.ConversationNamespace = config.SourceNamespace(connection.URL, source.ID)
	}
	source.PollURL = connection.URL
	key := connection.APIKey
	if key == "" {
		key, err = config.LoadSourceKey(s.Dir, source.CredentialID)
	}
	if err != nil {
		return err
	}
	if err := config.ValidateAPIKey(key); err != nil {
		return err
	}
	oldCredential := source.CredentialID
	newCredential := ""
	if connection.APIKey != "" {
		newCredential = config.NewID()
		source.CredentialID = newCredential
	}
	if err := config.ValidateSource(source); err != nil {
		return err
	}
	cfg.Sources[index] = source
	cfg.ResumeIntake = true
	if err := config.Validate(cfg); err != nil {
		return err
	}
	if _, err := sourceEngine(cfg.EngineDir); err != nil {
		return err
	}
	if err := s.drainConnection(ctx); err != nil {
		return err
	}
	if newCredential != "" {
		if err := config.SaveCredential(s.Dir, newCredential, key); err != nil {
			return err
		}
	}
	if err := config.Save(s.Dir, cfg); err != nil {
		if newCredential != "" {
			_ = config.RemoveCredential(s.Dir, newCredential)
		}
		return err
	}
	if newCredential != "" && oldCredential != "" {
		_ = config.RemoveCredential(s.Dir, oldCredential)
	}
	return s.startSources(ctx, cfg, true)
}

func (s *Service) RemoveSource(ctx context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	unlock, err := config.LockSettings(s.Dir)
	if err != nil {
		return err
	}
	defer unlock()

	cfg, err := config.Load(s.Dir)
	if err != nil {
		return err
	}
	index := -1
	for i, source := range cfg.Sources {
		if source.ID == id {
			index = i
			break
		}
	}
	if index < 0 {
		return errors.New("source no longer exists")
	}
	removed := cfg.Sources[index]
	next := append([]config.Source{}, cfg.Sources[:index]...)
	cfg.Sources = append(next, cfg.Sources[index+1:]...)
	if len(cfg.Sources) == 0 {
		cfg.ResumeIntake = false
	}
	if len(cfg.Sources) > 0 {
		if _, err := sourceEngine(cfg.EngineDir); err != nil {
			return err
		}
	}
	if err := s.drainConnection(ctx); err != nil {
		return err
	}
	if err := config.Save(s.Dir, cfg); err != nil {
		return err
	}
	_ = config.RemoveCredential(s.Dir, removed.CredentialID)
	if len(cfg.Sources) == 0 {
		return nil
	}
	return s.startSources(ctx, cfg, true)
}

func savedPollers(cfg config.Config) []backend.Poller {
	pollers := make([]backend.Poller, 0, len(cfg.Sources))
	for _, source := range cfg.Sources {
		pollers = append(pollers, backend.Poller{ID: source.ID, Name: source.Name, Type: "tzudo", Status: "not_connected", URL: source.PollURL})
	}
	return pollers
}

func sameSources(snapshot backend.Snapshot, cfg config.Config) bool {
	if len(snapshot.Pollers) != len(cfg.Sources) {
		return false
	}
	for _, source := range cfg.Sources {
		found := false
		for _, poller := range snapshot.Pollers {
			if poller.ID == source.ID && poller.URL == source.PollURL {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func (s *Service) startSources(ctx context.Context, cfg config.Config, restart bool) error {
	if _, err := os.Stat(filepath.Join(s.Dir, "install-service-on-connect")); err == nil {
		if err := s.finishServiceSetup(io.Discard); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	} else if err := s.startConsole(ctx, restart); err != nil {
		return err
	}
	ready, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		if client, err := s.client(); err == nil {
			if snapshot, err := client.Snapshot(ready); err == nil && snapshot.IntakePaused == !cfg.ResumeIntake && sameSources(snapshot, cfg) {
				return nil
			}
		}
		select {
		case <-ready.Done():
			return errors.New("sources saved, but engine is not ready; inspect engine or service status")
		case <-tick.C:
		}
	}
}

// drainConnection leaves the old credentials in place until all admitted work
// finishes. Shutdown pauses intake and drains workers without interrupting them.
func (s *Service) drainConnection(ctx context.Context) error {
	path := config.DiscoveryPath(s.Dir)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return ctx.Err()
	} else if err != nil {
		return errors.New("cannot inspect engine shutdown state")
	}
	client, err := s.client()
	if err != nil {
		return err
	}
	pid, err := engineDiscoveryPID(path)
	if err != nil {
		return err
	}
	if !processExists(pid) {
		return ctx.Err()
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
		latest, err := os.Lstat(path)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		} else if err != nil {
			return errors.New("cannot inspect engine shutdown state")
		}
		if !os.SameFile(info, latest) || !processExists(pid) {
			return backend.ErrDrainInterrupted
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
