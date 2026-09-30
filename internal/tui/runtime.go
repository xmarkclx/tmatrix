package tui

import (
	"fmt"
	"time"

	"tmatrix/internal/backend"
)

// elapsedLabel measures this worker execution, not the conversation's age. A
// request to stop keeps ticking until the bridge confirms execution has ended.
func elapsedLabel(worker backend.Worker, now time.Time) string {
	started, err := time.Parse(time.RFC3339Nano, worker.StartedAt)
	if err != nil || started.After(now) {
		return "Runtime unknown"
	}
	end := now
	suffix := " elapsed"
	switch worker.Status {
	case "running", "stopping":
	case "completed", "failed", "stopped", "done", "cancelled", "ready_for_review":
		suffix = " total"
		endedAt := worker.EndedAt
		if endedAt == "" {
			// Older engines retain the terminal event, but do not expose ended_at.
			// A tool/message timestamp is never evidence that execution stopped.
			for _, event := range worker.Activity {
				if event.Kind == "worker."+worker.Status {
					endedAt = event.At
					break
				}
			}
		}
		end, err = time.Parse(time.RFC3339Nano, endedAt)
		if err != nil || end.Before(started) || end.After(now) {
			return "Runtime unknown"
		}
	default:
		// In particular, stop_unverified must not appear as either running or
		// confirmed stopped, even though the engine retains its activity.
		return "Runtime unknown"
	}
	return durationLabel(end.Sub(started)) + suffix
}

func durationLabel(duration time.Duration) string {
	seconds := int64(duration / time.Second)
	if seconds < 60 {
		return fmt.Sprintf("%ds", seconds)
	}
	if seconds < 3600 {
		return fmt.Sprintf("%dm %02ds", seconds/60, seconds%60)
	}
	if seconds < 86400 {
		return fmt.Sprintf("%dh %02dm %02ds", seconds/3600, seconds/60%60, seconds%60)
	}
	return fmt.Sprintf("%dd %02dh %02dm %02ds", seconds/86400, seconds/3600%24, seconds/60%60, seconds%60)
}
