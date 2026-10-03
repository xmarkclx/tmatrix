package app

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"time"

	"tmatrix/internal/backend"
	"tmatrix/internal/config"
)

// CheckUpgradeIdle is read-only: a busy daemon keeps processing its queue.
func CheckUpgradeIdle(ctx context.Context, dir string) error {
	_, err := upgradeConnection(ctx, dir)
	return err
}

// PrepareUpgrade reserves an idle daemon before any installation or settings
// changes. A worker admitted after preflight causes the atomic request to fail.
func PrepareUpgrade(ctx context.Context, dir string) error {
	client, err := upgradeConnection(ctx, dir)
	if err != nil || client == nil {
		return err
	}
	if err := client.ShutdownIfIdle(ctx); err != nil {
		return err
	}
	// A shutdown acknowledgement alone does not prove the old engine exited.
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		if _, err := os.Lstat(config.DiscoveryPath(dir)); errors.Is(err, os.ErrNotExist) {
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

func upgradeConnection(ctx context.Context, dir string) (*backend.HTTP, error) {
	path := config.DiscoveryPath(dir)
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return nil, ctx.Err()
	} else if err != nil {
		return nil, errors.New("cannot inspect engine upgrade state")
	}
	client, err := backend.NewHTTP(path)
	if err != nil {
		return nil, err
	}
	snapshot, err := client.Snapshot(ctx)
	if err != nil {
		var record struct {
			PID int `json:"pid"`
		}
		data, readErr := os.ReadFile(path)
		if readErr == nil && json.Unmarshal(data, &record) == nil && record.PID > 0 && !processExists(record.PID) {
			return nil, ctx.Err()
		}
		return nil, errors.New("cannot verify whether workers are active; upgrade deferred")
	}
	if snapshot.RunningWorkers > 0 {
		return nil, backend.ErrUpgradeBusy
	}
	return client, nil
}
