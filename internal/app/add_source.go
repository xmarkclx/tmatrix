package app

import (
	"context"
	"errors"
	"os"
	"slices"
	"time"

	"tmatrix/internal/backend"
	"tmatrix/internal/config"
)

var errSourceSaved = errors.New("source saved, but TMatrix could not confirm activation; retry Add source with the same URL and key")

func (s *Service) addSource(ctx context.Context, cfg config.Config, connection backend.Connection) error {
	if err := config.ValidateAPIKey(connection.APIKey); err != nil {
		return err
	}
	var saved config.Source
	for _, source := range cfg.Sources {
		if source.PollURL != connection.URL {
			continue
		}
		key, err := config.LoadSourceKey(s.Dir, source.CredentialID)
		if err == nil && key == connection.APIKey {
			saved = source
			break
		}
	}

	source := saved
	if saved.ID == "" {
		source = config.NewSource(connection.Name, connection.URL)
		source.CredentialID = config.NewID()
		if len(cfg.Sources) == 0 {
			cfg.ResumeIntake = true
		}
		cfg.Sources = append(cfg.Sources, source)
		if err := config.Validate(cfg); err != nil {
			return err
		}
	}

	client, snapshot, err := s.liveSourceAddTarget(ctx)
	if err != nil {
		return err
	}
	if client != nil {
		if saved.ID != "" && sourceInSnapshot(snapshot, saved) {
			return errors.New("this source connection is already configured; edit it in Pollers")
		}
		if !snapshot.LiveSourceAdd {
			return errors.New("engine update needed to add a source while TMatrix is running")
		}
	} else if _, err := sourceEngine(cfg.EngineDir); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	if saved.ID == "" {
		if err := config.SaveCredential(s.Dir, source.CredentialID, connection.APIKey); err != nil {
			return err
		}
		if err := config.Save(s.Dir, cfg); err != nil {
			_ = config.RemoveCredential(s.Dir, source.CredentialID)
			return err
		}
	}
	if client == nil {
		if err := s.startSources(ctx, cfg, false); err == nil {
			return nil
		}
	} else if err := client.AddSource(ctx, source.ID); err == nil {
		return nil
	}
	// The bridge may have applied the source before disconnecting. Its saved
	// identity and credential must survive the next Attach or daemon startup.
	probe, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	if latest, err := s.client(); err == nil {
		if snapshot, err := latest.Snapshot(probe); err == nil && sourceInSnapshot(snapshot, source) {
			return nil
		}
	}
	return errSourceSaved
}

func sourceInSnapshot(snapshot backend.Snapshot, source config.Source) bool {
	return slices.ContainsFunc(snapshot.Pollers, func(poller backend.Poller) bool {
		return poller.ID == source.ID && poller.URL == source.PollURL
	})
}

func (s *Service) liveSourceAddTarget(ctx context.Context) (*backend.HTTP, backend.Snapshot, error) {
	client, err := s.client()
	if err != nil {
		if _, statErr := os.Lstat(config.DiscoveryPath(s.Dir)); errors.Is(statErr, os.ErrNotExist) {
			return nil, backend.Snapshot{}, nil
		}
		return nil, backend.Snapshot{}, err
	}
	snapshot, err := client.Snapshot(ctx)
	if err != nil {
		return nil, backend.Snapshot{}, err
	}
	return client, snapshot, nil
}
