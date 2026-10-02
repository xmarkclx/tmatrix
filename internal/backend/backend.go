// Package backend is the terminal's transport boundary. Additional runtimes and
// pollers can implement Backend without adding transport logic to UI screens.
package backend

import (
	"context"
	"errors"
	"regexp"
	"strings"
)

type Backend interface {
	Snapshot(context.Context) (Snapshot, error)
	Steer(context.Context, string, string) (Steering, error)
	Stop(context.Context, string) error
	Pin(context.Context, string, bool) error
	Configure(context.Context, Settings) error
	Connect(context.Context, Connection) error
}

// AdapterUpdater is optional so custom backends and older engines remain usable.
// These methods acknowledge a background operation, not update completion.
type AdapterUpdater interface {
	CheckAdapterUpdate(context.Context) error
	RollbackAdapterUpdate(context.Context) error
}

type AdapterUpdate struct {
	AdapterID       string `json:"adapter_id"`
	DisplayName     string `json:"display_name"`
	CanRollback     bool   `json:"can_rollback"`
	Status          string `json:"status"`
	CurrentVersion  string `json:"current_version"`
	PreviousVersion string `json:"previous_version,omitempty"`
	LatestVersion   string `json:"latest_version,omitempty"`
	BlockedVersion  string `json:"blocked_version,omitempty"`
	LastCheckedAt   string `json:"last_checked_at,omitempty"`
	NextCheckAt     string `json:"next_check_at,omitempty"`
	Error           string `json:"error,omitempty"`
}

type Snapshot struct {
	AdapterUpdate  *AdapterUpdate `json:"adapter_update,omitempty"`
	RuntimeAdapter string         `json:"runtime_adapter"`
	RestartPending bool           `json:"restart_pending,omitempty"`
	Version        int            `json:"version"`
	InstanceID     string         `json:"instance_id"`
	MaxWorkers     int            `json:"max_workers"`
	RunningWorkers int            `json:"running_workers"`
	PollIntervalMS int            `json:"poll_interval_ms"`
	IntakePaused   bool           `json:"intake_paused"`
	Poller         Poller         `json:"poller"`
	Workers        []Worker       `json:"workers"`
}

type Poller struct {
	Type       string `json:"type"`
	Status     string `json:"status"`
	URL        string `json:"url"`
	LastPollAt string `json:"last_poll_at,omitempty"`
	Error      string `json:"error,omitempty"`
}

type Worker struct {
	Pinned        bool           `json:"pinned"`
	ID            string         `json:"id"`
	TicketID      string         `json:"ticket_id"`
	Title         string         `json:"title"`
	Status        string         `json:"status"`
	Model         string         `json:"model"`
	WorkerType    string         `json:"worker_type"`
	ThreadID      string         `json:"thread_id"`
	RunKind       string         `json:"run_kind,omitempty"`
	InputRevision int            `json:"input_revision"`
	StartedAt     string         `json:"started_at"`
	EndedAt       string         `json:"ended_at,omitempty"`
	InitialPrompt *InitialPrompt `json:"initial_prompt,omitempty"`
	Activity      []Activity     `json:"activity"`
	Steering      []Steering     `json:"steering"`
}

// InitialPrompt is the prepared first input for this execution, kept separately
// from the activity ring. Absence means that this engine has no captured input.
// Its presence is not evidence that the runtime received the prompt.
type InitialPrompt struct {
	Text          string `json:"text"`
	At            string `json:"at"`
	InputRevision int    `json:"input_revision"`
	Truncated     bool   `json:"truncated"`
	Redacted      bool   `json:"redacted"`
}

type Activity struct {
	Sequence int64  `json:"sequence"`
	At       string `json:"at"`
	Kind     string `json:"kind"`
	Text     string `json:"text"`
}

type Steering struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

type Settings struct {
	MaxWorkers     *int    `json:"max_workers,omitempty"`
	IntakePaused   *bool   `json:"intake_paused,omitempty"`
	PollIntervalMS *int    `json:"poll_interval_ms,omitempty"`
	WorkerType     *string `json:"-"`
	PollerType     *string `json:"-"`
}

// Connection is never included in snapshots or persisted alongside settings.
type Connection struct {
	URL    string `json:"url"`
	APIKey string `json:"-"`
}

func ValidateSettings(s Settings) error {
	if s.MaxWorkers != nil && (*s.MaxWorkers < 1 || *s.MaxWorkers > 100) {
		return errors.New("max workers must be between 1 and 100")
	}
	if s.PollIntervalMS != nil && (*s.PollIntervalMS < 250 || *s.PollIntervalMS > 300000) {
		return errors.New("poll interval must be between 250 and 300000 milliseconds")
	}
	if s.WorkerType != nil && !regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`).MatchString(*s.WorkerType) {
		return errors.New("invalid worker adapter ID")
	}
	if s.PollerType != nil && *s.PollerType != "tzudo" {
		return errors.New("only the tzudo poller is available")
	}
	return nil
}

func validateMessage(message string) error {
	if strings.TrimSpace(message) == "" || len(message) > 8000 {
		return errors.New("steering message must contain between 1 and 8000 bytes")
	}
	return nil
}
