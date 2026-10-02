package tui

import (
	"context"
	"errors"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"tmatrix/internal/backend"
)

type fakeCodexUpdater struct {
	fakeBackend
	checks, rollbacks int
}

func (b *fakeCodexUpdater) CheckCodexUpdate(context.Context) error {
	b.checks++
	return b.err
}

func (b *fakeCodexUpdater) RollbackCodexUpdate(context.Context) error {
	b.rollbacks++
	return b.err
}

func codexUpdateModel() (Model, *fakeCodexUpdater) {
	b := &fakeCodexUpdater{fakeBackend: fakeBackend{snapshot: backend.Snapshot{
		MaxWorkers: 3, RunningWorkers: 1,
		CodexUpdate: &backend.CodexUpdate{Status: "up_to_date", CurrentVersion: "2.0.0", PreviousVersion: "1.0.0"},
		Workers:     []backend.Worker{{ID: "worker", Status: "running", ThreadID: "thread", InputRevision: 7}},
	}}}
	m := New(b, Options{})
	updated, _ := m.Update(snapshotMsg{snapshot: b.snapshot})
	m = updated.(Model)
	m.openForm(settingsScreen)
	return m, b
}

func TestCodexUpdateControlsPreserveSettingsAndWorkers(t *testing.T) {
	for _, width := range []int{40, 60, 100} {
		m, b := codexUpdateModel()
		m.width, m.height = width, 16
		m.form[0].SetValue("7")
		m, _ = clickTarget(t, m, "key", "o", "", 0)
		if m.screen != codexUpdatesScreen || !strings.Contains(m.View(), "Current: 2.0.0") || !strings.Contains(m.View(), "Check now") {
			t.Fatal("Codex update screen is unavailable at supported size")
		}
		m, cmd := clickTarget(t, m, "key", "c", "", 0)
		if !m.busy || cmd == nil || b.checks != 0 {
			t.Fatal("update did not run asynchronously")
		}
		m = execute(m, cmd)
		if m.busy || b.checks != 1 || !strings.Contains(m.notice, "requested") {
			t.Fatal("request acknowledgement claims completion or blocks the UI")
		}
		m, cmd = clickTarget(t, m, "key", "b", "", 0)
		m = execute(m, cmd)
		if b.rollbacks != 1 || m.snapshot.RunningWorkers != 1 || m.worker().ThreadID != "thread" || m.worker().InputRevision != 7 || b.stops != 0 || b.settings.IntakePaused != nil {
			t.Fatal("rollback changed active worker or intake state")
		}
		m, _ = press(m, "esc")
		if m.screen != settingsScreen || m.form[0].Value() != "7" {
			t.Fatal("Codex updates discarded settings draft")
		}
	}
}

func TestCodexUpdateEditingPasteAndPendingState(t *testing.T) {
	m, b := codexUpdateModel()
	m, _ = press(m, "enter")
	before := m.form[0].Value()
	m, _ = press(m, "o")
	if m.form[0].Value() != before+"o" || m.screen != settingsScreen {
		t.Fatal("updates shortcut intercepted editing")
	}
	m, _ = clickTarget(t, m, "key", "o", "", 0)
	updated, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("c"), Paste: true})
	m = updated.(Model)
	if cmd != nil || b.checks != 0 {
		t.Fatal("pasted text triggered update")
	}
	for _, status := range []string{"checking", "installing", "verifying"} {
		m.snapshot.CodexUpdate.Status = status
		for _, key := range []string{"c", "b"} {
			m, cmd = press(m, key)
			if cmd != nil || m.busy {
				t.Fatal("pending update accepted duplicate action")
			}
		}
		if strings.Contains(m.View(), "Check now") {
			t.Fatal("pending action remains enabled")
		}
	}
	// A background update never traps the operator on this screen.
	m, _ = press(m, "w")
	if m.screen != workersScreen || m.worker().Status != "running" {
		t.Fatal("background update prevented worker supervision")
	}
}

func TestCodexUpdateUnavailableAndFailureStates(t *testing.T) {
	for _, mode := range []string{"legacy", "demo", "disabled", "unsupported", "no previous"} {
		m, b := codexUpdateModel()
		switch mode {
		case "legacy":
			m.snapshot.CodexUpdate = nil
		case "demo":
			m.options.Demo = true
		case "disabled":
			m.snapshot.CodexUpdate.Status = "disabled"
		case "unsupported":
			m.backend = &fakeBackend{}
		case "no previous":
			m.snapshot.CodexUpdate.PreviousVersion = ""
		}
		m, _ = press(m, "o")
		key := "c"
		if mode == "no previous" {
			key = "b"
		}
		m, cmd := press(m, key)
		if cmd != nil || b.checks+b.rollbacks != 0 || m.failure == "" {
			t.Fatalf("%s unexpectedly accepted update", mode)
		}
	}
	m, b := codexUpdateModel()
	b.err = errors.New("engine is disconnected")
	m, _ = press(m, "o")
	m, cmd := press(m, "c")
	m = execute(m, cmd)
	if m.busy || !strings.Contains(m.failure, "disconnected") {
		t.Fatal("failed request remained busy or hid the failure")
	}
	m.snapshot.CodexUpdate.Status = "failed"
	m.snapshot.CodexUpdate.Error = "Candidate verification failed."
	if !strings.Contains(m.View(), "verification failed") || !strings.Contains(m.View(), "Check now") {
		t.Fatal("failed check hid its recovery action or reason")
	}
}

func TestCodexUpdateDetailsRemainReachableAtMinimumSize(t *testing.T) {
	m, _ := codexUpdateModel()
	m.width, m.height = 40, 16
	m.snapshot.CodexUpdate.LatestVersion = "2.0.0"
	m, _ = press(m, "o")
	m, _ = serviceKey(m, "end")
	if m.pageOffset == 0 || !strings.Contains(m.View(), "activating") {
		t.Fatal("narrow screen lost lower update details")
	}
	if !strings.Contains(m.View(), "Check now") || !strings.Contains(m.View(), "Current: 2.0.0") {
		t.Fatal("scrolling hid update controls or active version")
	}
}

func TestCodexUpdateExplainsRetainedRollback(t *testing.T) {
	m, _ := codexUpdateModel()
	m.snapshot.CodexUpdate = &backend.CodexUpdate{
		Status: "up_to_date", CurrentVersion: "1.0.0", PreviousVersion: "2.0.0",
		LatestVersion: "2.0.0", BlockedVersion: "2.0.0",
	}
	m, _ = press(m, "o")
	if !strings.Contains(m.View(), "Rollback retained") || !strings.Contains(m.View(), "Skipped after rollback: 2.0.0") || strings.Contains(m.View(), "Status: Up to date") {
		t.Fatal("rollback hold was hidden or mislabeled as the latest version")
	}
	m.snapshot.CodexUpdate.BlockedVersion = ""
	m.snapshot.CodexUpdate.LatestVersion = "1.0.0"
	if !strings.Contains(m.View(), "Status: Up to date") || strings.Contains(m.View(), "Skipped after rollback") {
		t.Fatal("released rollback hold remained visible")
	}
}
