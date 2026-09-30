package backend

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"tmatrix/internal/config"
)

// Demo contains fictional, deterministic activity. Actions progress on snapshot
// reads only and never launch a process, contact a poller, or write credentials.
type Demo struct {
	mu       sync.Mutex
	snapshot Snapshot
	nextID   int
	now      func() time.Time
}

func NewDemo() *Demo {
	return newDemo(time.Now)
}

// Relative fixture times make each launch start at the same elapsed durations,
// while an injectable clock keeps verification deterministic.
func newDemo(now func() time.Time) *Demo {
	demo := &Demo{now: now, snapshot: Snapshot{
		Version: 1, InstanceID: "demo", MaxWorkers: 4, RunningWorkers: 2, PollIntervalMS: 5000,
		Poller: Poller{Type: "tzudo", Status: "demo", URL: config.DefaultPollURL, LastPollAt: "2026-09-29T10:04:30Z"},
		Workers: []Worker{
			{ID: "demo-01", TicketID: "TMX-12", Title: "⌨️ Build a keyboard-first command palette", Status: "running", Model: "gpt-6-astra", WorkerType: "codex", ThreadID: "demo-conversation-01", InputRevision: 3, StartedAt: "2026-09-29T10:00:00Z", InitialPrompt: &InitialPrompt{
				Text: "Build a keyboard-first command palette.\nKeep every action reachable without a mouse, preserve focus when switching workers, and verify the shortcuts.\nUse fictional sample data only. [sample prompt]", At: "2026-09-29T10:00:00Z", InputRevision: 2,
			}, Activity: []Activity{
				{1, "2026-09-29T10:00:00Z", "status", "Sample worker opened the existing conversation."},
				{2, "2026-09-29T10:00:06Z", "message", "👩🏽‍💻 Checking the keyboard shortcuts and focus order."},
				{3, "2026-09-29T10:00:12Z", "tool", "$ go test ./internal/palette/..."},
				{4, "2026-09-29T10:00:14Z", "output", "✅ ok  sample/palette  0.042s  [simulated output]"},
				{5, "2026-09-29T10:00:17Z", "status", "Task update queued for this conversation; runtime receipt is not yet observed. [sample]"},
			}},
			{ID: "demo-02", TicketID: "TMX-18", Title: "🌱 Add friendly empty states", Status: "running", Model: "gpt-6-sol", WorkerType: "codex", ThreadID: "demo-conversation-02", InputRevision: 1, StartedAt: "2026-09-29T10:01:00Z", InitialPrompt: &InitialPrompt{
				Text: "Add friendly empty states for workers and pollers.\nExplain the next action and include a keyboard shortcut to connect Tzu Do. [sample prompt]", At: "2026-09-29T10:01:00Z", InputRevision: 1,
			}, Activity: []Activity{
				{1, "2026-09-29T10:01:00Z", "status", "Sample worker started in a separate conversation."},
				{2, "2026-09-29T10:01:09Z", "message", "The empty state will explain how to connect a poller."},
			}},
			{ID: "demo-03", TicketID: "TMX-09", Title: "📖 Document the local installation", Status: "completed", Model: "gpt-6-sol", WorkerType: "codex", ThreadID: "demo-conversation-03", InputRevision: 2, StartedAt: "2026-09-29T09:57:00Z", EndedAt: "2026-09-29T09:59:00Z", InitialPrompt: &InitialPrompt{
				Text: "Document local installation and the demo controls.\nExplain how to detach while workers continue running. [sample prompt]", At: "2026-09-29T09:57:00Z", InputRevision: 2,
			}, Activity: []Activity{
				{1, "2026-09-29T09:57:00Z", "message", "Added installation steps and a keyboard reference. [sample]"},
				{2, "2026-09-29T09:59:00Z", "status", "Sample result ready for review."},
			}},
		},
	}}
	baseline := time.Date(2026, 9, 29, 10, 4, 32, 0, time.UTC)
	offset := now().UTC().Sub(baseline)
	shift := func(value string) string {
		parsed, _ := time.Parse(time.RFC3339, value)
		return parsed.Add(offset).Format(time.RFC3339Nano)
	}
	demo.snapshot.Poller.LastPollAt = shift(demo.snapshot.Poller.LastPollAt)
	for i := range demo.snapshot.Workers {
		worker := &demo.snapshot.Workers[i]
		worker.StartedAt = shift(worker.StartedAt)
		if worker.InitialPrompt != nil {
			worker.InitialPrompt.At = shift(worker.InitialPrompt.At)
		}
		if worker.EndedAt != "" {
			worker.EndedAt = shift(worker.EndedAt)
		}
		for j := range worker.Activity {
			worker.Activity[j].At = shift(worker.Activity[j].At)
		}
	}
	return demo
}

func (d *Demo) Snapshot(ctx context.Context) (Snapshot, error) {
	if err := ctx.Err(); err != nil {
		return Snapshot{}, err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	copy := d.snapshot
	copy.Workers = append([]Worker(nil), d.snapshot.Workers...)
	for i := range copy.Workers {
		if copy.Workers[i].InitialPrompt != nil {
			prompt := *copy.Workers[i].InitialPrompt
			copy.Workers[i].InitialPrompt = &prompt
		}
		copy.Workers[i].Activity = append([]Activity(nil), copy.Workers[i].Activity...)
		copy.Workers[i].Steering = append([]Steering(nil), copy.Workers[i].Steering...)
	}
	// Return the request state once before simulating acknowledgement. This
	// preserves the distinction between requesting stop and confirming stop.
	for i := range d.snapshot.Workers {
		worker := &d.snapshot.Workers[i]
		if worker.Status == "stopping" {
			worker.Status = "stopped"
			worker.EndedAt = d.now().UTC().Format(time.RFC3339Nano)
			d.snapshot.RunningWorkers--
			d.addActivity(worker, "status", "Execution stopped. [simulated confirmation]")
		}
		for j := range worker.Steering {
			switch worker.Steering[j].Status {
			case "queued":
				worker.Steering[j].Status = "runtime_received"
				d.addActivity(worker, "status", "Steering received by the same conversation. [simulated receipt]")
			case "runtime_received":
				worker.Steering[j].Status = "response_observed"
				d.addActivity(worker, "message", "I will incorporate that guidance. [simulated response]")
			}
		}
	}
	return copy, nil
}

func (d *Demo) Steer(ctx context.Context, id, message string) (Steering, error) {
	if err := ctx.Err(); err != nil {
		return Steering{}, err
	}
	if err := validateMessage(message); err != nil {
		return Steering{}, err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	worker := d.worker(id)
	if worker == nil || worker.Status != "running" {
		return Steering{}, errors.New("select a running sample worker to steer")
	}
	d.nextID++
	steering := Steering{ID: fmt.Sprintf("demo-message-%d", d.nextID), Status: "queued"}
	worker.Steering = append(worker.Steering, steering)
	d.addActivity(worker, "steering", "Queued in this sample conversation: "+message)
	return steering, nil
}

func (d *Demo) Stop(ctx context.Context, id string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	worker := d.worker(id)
	if worker == nil || worker.Status != "running" {
		return errors.New("select a running sample worker to stop")
	}
	worker.Status = "stopping"
	for i := range worker.Steering {
		if worker.Steering[i].Status != "response_observed" {
			worker.Steering[i].Status = "failed"
		}
	}
	d.addActivity(worker, "status", "Stop requested; awaiting simulated confirmation.")
	return nil
}

func (d *Demo) Pin(ctx context.Context, id string, pinned bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	worker := d.worker(id)
	if worker == nil {
		return errors.New("sample worker is no longer available")
	}
	worker.Pinned = pinned
	return nil
}

func (d *Demo) Configure(ctx context.Context, settings Settings) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := ValidateSettings(settings); err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if settings.MaxWorkers != nil {
		d.snapshot.MaxWorkers = *settings.MaxWorkers
	}
	if settings.PollIntervalMS != nil {
		d.snapshot.PollIntervalMS = *settings.PollIntervalMS
	}
	if settings.IntakePaused != nil {
		d.snapshot.IntakePaused = *settings.IntakePaused
	}
	return nil
}

func (d *Demo) Connect(ctx context.Context, connection Connection) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := config.ValidatePollURL(connection.URL); err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.snapshot.Poller.URL = connection.URL
	d.snapshot.Poller.Status = "demo"
	return nil
}

func (d *Demo) worker(id string) *Worker {
	for i := range d.snapshot.Workers {
		if d.snapshot.Workers[i].ID == id {
			return &d.snapshot.Workers[i]
		}
	}
	return nil
}

func (d *Demo) addActivity(worker *Worker, kind, text string) {
	sequence := int64(1)
	if len(worker.Activity) > 0 {
		sequence = worker.Activity[len(worker.Activity)-1].Sequence + 1
	}
	worker.Activity = append(worker.Activity, Activity{Sequence: sequence, At: d.now().UTC().Format(time.RFC3339Nano), Kind: kind, Text: text})
	if len(worker.Activity) > 1000 {
		worker.Activity = append([]Activity(nil), worker.Activity[len(worker.Activity)-1000:]...)
	}
}
