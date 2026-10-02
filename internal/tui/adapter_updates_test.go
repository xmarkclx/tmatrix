package tui

import (
	"context"
	"errors"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"tmatrix/internal/backend"
)

type fakeAdapterUpdater struct {
	fakeBackend
	checks, rollbacks int
}

func (b *fakeAdapterUpdater) CheckAdapterUpdate(context.Context) error {
	b.checks++
	return b.err
}

func (b *fakeAdapterUpdater) RollbackAdapterUpdate(context.Context) error {
	b.rollbacks++
	return b.err
}

func adapterUpdateModel() (Model, *fakeAdapterUpdater) {
	b := &fakeAdapterUpdater{fakeBackend: fakeBackend{snapshot: backend.Snapshot{
		MaxWorkers: 3, RunningWorkers: 1,
		AdapterUpdate: &backend.AdapterUpdate{AdapterID: "fictional", DisplayName: "Fictional CLI", CanRollback: true, Status: "up_to_date", CurrentVersion: "2.0.0", PreviousVersion: "1.0.0"},
		Workers:       []backend.Worker{{ID: "worker", Status: "running", ThreadID: "thread", InputRevision: 7}},
	}}}
	m := New(b, Options{})
	updated, _ := m.Update(snapshotMsg{snapshot: b.snapshot})
	m = updated.(Model)
	m.openForm(settingsScreen)
	return m, b
}

func TestAdapterUpdateControlsPreserveSettingsAndWorkers(t *testing.T) {
	for _, width := range []int{40, 60, 100} {
		m, b := adapterUpdateModel()
		m.width, m.height = width, 16
		m.form[0].SetValue("7")
		m, _ = clickTarget(t, m, "key", "o", "", 0)
		if m.screen != adapterUpdatesScreen || !strings.Contains(m.View(), "Current: 2.0.0") || !strings.Contains(m.View(), "Check now") {
			t.Fatal("runtime update screen is unavailable at supported size")
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
			t.Fatal("runtime updates discarded settings draft")
		}
	}
}

func TestAdapterUpdateEditingPasteAndPendingState(t *testing.T) {
	m, b := adapterUpdateModel()
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
		m.snapshot.AdapterUpdate.Status = status
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

func TestAdapterUpdateUnavailableAndFailureStates(t *testing.T) {
	for _, mode := range []string{"legacy", "demo", "disabled", "unsupported", "no rollback"} {
		m, b := adapterUpdateModel()
		switch mode {
		case "legacy":
			m.snapshot.AdapterUpdate = nil
		case "demo":
			m.options.Demo = true
		case "disabled":
			m.snapshot.AdapterUpdate.Status = "disabled"
		case "unsupported":
			m.backend = &fakeBackend{}
		case "no rollback":
			m.snapshot.AdapterUpdate.CanRollback = false
		}
		m, _ = press(m, "o")
		key := "c"
		if mode == "no rollback" {
			key = "b"
		}
		m, cmd := press(m, key)
		if cmd != nil || b.checks+b.rollbacks != 0 || m.failure == "" {
			t.Fatalf("%s unexpectedly accepted update", mode)
		}
	}
	m, b := adapterUpdateModel()
	b.err = errors.New("engine is disconnected")
	m, _ = press(m, "o")
	m, cmd := press(m, "c")
	m = execute(m, cmd)
	if m.busy || !strings.Contains(m.failure, "disconnected") {
		t.Fatal("failed request remained busy or hid the failure")
	}
	m.snapshot.AdapterUpdate.Status = "failed"
	m.snapshot.AdapterUpdate.Error = "Candidate verification failed."
	if !strings.Contains(m.View(), "verification failed") || !strings.Contains(m.View(), "Check now") {
		t.Fatal("failed check hid its recovery action or reason")
	}
}

func TestAdapterUpdateDetailsRemainReachableAtMinimumSize(t *testing.T) {
	m, _ := adapterUpdateModel()
	m.width, m.height = 40, 16
	m.snapshot.AdapterUpdate.LatestVersion = "2.0.0"
	m, _ = press(m, "o")
	m, _ = serviceKey(m, "end")
	if m.pageOffset == 0 || !strings.Contains(m.View(), "activating") {
		t.Fatal("narrow screen lost lower update details")
	}
	if !strings.Contains(m.View(), "Check now") || !strings.Contains(m.View(), "Current: 2.0.0") {
		t.Fatal("scrolling hid update controls or active version")
	}
}

func TestAdapterUpdateExplainsRetainedRollback(t *testing.T) {
	m, _ := adapterUpdateModel()
	m.snapshot.AdapterUpdate = &backend.AdapterUpdate{
		Status: "up_to_date", CurrentVersion: "1.0.0", PreviousVersion: "2.0.0",
		LatestVersion: "2.0.0", BlockedVersion: "2.0.0",
	}
	m, _ = press(m, "o")
	if !strings.Contains(m.View(), "Rollback retained") || !strings.Contains(m.View(), "Skipped after rollback: 2.0.0") || strings.Contains(m.View(), "Status: Up to date") {
		t.Fatal("rollback hold was hidden or mislabeled as the latest version")
	}
	m.snapshot.AdapterUpdate.BlockedVersion = ""
	m.snapshot.AdapterUpdate.LatestVersion = "1.0.0"
	if !strings.Contains(m.View(), "Status: Up to date") || strings.Contains(m.View(), "Skipped after rollback") {
		t.Fatal("released rollback hold remained visible")
	}
}

func TestAdapterUpdateUsesProviderNameAndScheduling(t *testing.T) {
	for _, name := range []string{"Codex CLI", "Fictional CLI", ""} {
		m, _ := adapterUpdateModel()
		if !strings.Contains(m.View(), "Runtime updates") {
			t.Fatal("settings did not expose the shared runtime update action")
		}
		m.snapshot.AdapterUpdate.DisplayName = name
		m, _ = press(m, "o")
		want := name + " updates"
		if name == "" {
			want = "Runtime updates"
		}
		if m.screenName() != want || !strings.Contains(m.View(), want) {
			t.Fatal("update screen lost the adapter display name")
		}
		details := strings.Join(m.adapterUpdateDetails(), " ")
		if !strings.Contains(details, "runtime adapter manages") || strings.Contains(details, "24 hours") || strings.Contains(details, "stable") {
			t.Fatal("shared screen imposed a provider's release policy")
		}
	}
}

func TestAdapterUpdateRollbackUsesCapability(t *testing.T) {
	for _, canRollback := range []bool{false, true} {
		m, b := adapterUpdateModel()
		m.snapshot.AdapterUpdate.CanRollback = canRollback
		// A provider may expose rollback without publishing a previous version;
		// conversely version metadata is not permission to invoke rollback.
		if canRollback {
			m.snapshot.AdapterUpdate.PreviousVersion = ""
		}
		m, _ = press(m, "o")
		if strings.Contains(m.View(), "Roll back") != canRollback {
			t.Fatal("rollback visibility ignored the adapter capability")
		}
		m, cmd := press(m, "b")
		if canRollback {
			m = execute(m, cmd)
			if b.rollbacks != 1 || m.failure != "" {
				t.Fatal("adapter rollback required Codex-specific version metadata")
			}
		} else if cmd != nil || b.rollbacks != 0 || !strings.Contains(m.failure, "unavailable") {
			t.Fatal("check-only adapter accepted rollback")
		}
		m, cmd = press(m, "c")
		m = execute(m, cmd)
		if b.checks != 1 || m.failure != "" {
			t.Fatal("adapter rollback capability blocked update checks")
		}
	}
}
