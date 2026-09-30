package backend

import (
	"context"
	"testing"
	"time"
)

func TestDemoClockAndStopTimestampMatchConfirmedExecution(t *testing.T) {
	now := time.Date(2030, 5, 4, 3, 2, 1, 0, time.UTC)
	demo := newDemo(func() time.Time { return now })
	ctx := context.Background()
	initial, _ := demo.Snapshot(ctx)
	if initial.Workers[0].InitialPrompt == nil || initial.Workers[0].InitialPrompt.At != initial.Workers[0].StartedAt {
		t.Fatal("initial prompt time did not follow the fixture clock")
	}
	start, err := time.Parse(time.RFC3339Nano, initial.Workers[0].StartedAt)
	if err != nil || now.Sub(start) != 4*time.Minute+32*time.Second {
		t.Fatal("demo launch duration drifted")
	}
	completed := initial.Workers[2]
	begin, _ := time.Parse(time.RFC3339Nano, completed.StartedAt)
	end, _ := time.Parse(time.RFC3339Nano, completed.EndedAt)
	if end.Sub(begin) != 2*time.Minute {
		t.Fatal("fixture completion duration missing")
	}
	if err := demo.Stop(ctx, initial.Workers[0].ID); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Second)
	pending, _ := demo.Snapshot(ctx)
	if pending.Workers[0].EndedAt != "" {
		t.Fatal("stop request invented end time")
	}
	confirmed, _ := demo.Snapshot(ctx)
	if confirmed.Workers[0].EndedAt != now.Format(time.RFC3339Nano) {
		t.Fatal("confirmation missing end time")
	}
	now = now.Add(time.Minute)
	later, _ := demo.Snapshot(ctx)
	if later.Workers[0].EndedAt != confirmed.Workers[0].EndedAt || later.Workers[0].StartedAt != initial.Workers[0].StartedAt {
		t.Fatal("snapshot refresh changed execution timestamps")
	}
}

func TestInitialPromptSurvivesDemoActivityAndSnapshotMutation(t *testing.T) {
	demo := NewDemo()
	ctx := context.Background()
	initial, _ := demo.Snapshot(ctx)
	worker := initial.Workers[0]
	if worker.InitialPrompt == nil || worker.InitialPrompt.Text == "" || worker.InitialPrompt.Text == worker.Title {
		t.Fatal("demo requires explicit fictional prompt text")
	}
	original := *worker.InitialPrompt
	worker.InitialPrompt.Text = "mutated by client"
	if _, err := demo.Steer(ctx, worker.ID, "Follow-up guidance"); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		current, _ := demo.Snapshot(ctx)
		if current.Workers[0].InitialPrompt == nil || *current.Workers[0].InitialPrompt != original {
			t.Fatal("client mutation or steering replaced the execution's initial prompt")
		}
	}
}
