package tui

import (
	"errors"
	tea "github.com/charmbracelet/bubbletea"
	"strings"
	"testing"
	"tmatrix/internal/backend"
)

func TestFinishedWorkerClosesComposerAndReleasesState(t *testing.T) {
	m, b := testModel()
	m, _ = press(m, "enter")
	m.composer.SetValue("unsent")
	m.drafts["a"] = "unsent"
	m.confirmation = "a"
	b.snapshot.Workers[0].Status = "completed"
	updated, _ := m.Update(snapshotMsg{snapshot: b.snapshot})
	m = updated.(Model)
	if len(m.snapshot.Workers) != 1 || m.selected != "b" || m.composing || m.confirmation != "" {
		t.Fatalf("finished worker remains selected or actionable: %q", m.selected)
	}
	if _, ok := m.drafts["a"]; ok {
		t.Fatal("finished draft retained")
	}
	if _, ok := m.reading["a"]; ok {
		t.Fatal("finished reading state retained")
	}
	b.snapshot.Workers[1].Status = "failed"
	updated, _ = m.Update(snapshotMsg{snapshot: b.snapshot})
	m = updated.(Model)
	if m.selected != "" || len(m.snapshot.Workers) != 0 || m.composing {
		t.Fatal("last worker did not close")
	}
}

func TestUnverifiedAndStoppingWorkersRemainVisible(t *testing.T) {
	m, _ := testModel()
	updated, _ := m.Update(snapshotMsg{snapshot: backend.Snapshot{Workers: []backend.Worker{
		{ID: "stopping", Status: "stopping"}, {ID: "unknown", Status: "stop_unverified"}, {ID: "done", Status: "stopped"},
	}}})
	m = updated.(Model)
	if len(m.snapshot.Workers) != 2 {
		t.Fatal("teardown uncertainty hidden")
	}
}

func TestPinLifecycle(t *testing.T) {
	for _, status := range []string{"completed", "failed", "stopped"} {
		t.Run(status, func(t *testing.T) {
			m, b := testModel()
			m, cmd := press(m, "P")
			if cmd == nil || !m.busy {
				t.Fatal("pin did not start")
			}
			updated, refresh := m.Update(cmd())
			m = updated.(Model)
			if refresh == nil {
				t.Fatal("pin must refresh confirmed state")
			}
			updated, _ = m.Update(refresh())
			m = updated.(Model)
			if !m.worker().Pinned {
				t.Fatal("pin not confirmed")
			}
			m, _ = press(m, "enter")
			b.snapshot.Workers[0].Status = status
			updated, _ = m.Update(snapshotMsg{snapshot: b.snapshot})
			m = updated.(Model)
			if m.selected != "a" || m.composing || len(m.snapshot.Workers) != 2 {
				t.Fatal("finished pin lost or composer still active")
			}
			if !strings.Contains(m.View(), "PIN") {
				t.Fatal("missing pin marker")
			}
			m, cmd = press(m, "P")
			updated, refresh = m.Update(cmd())
			m = updated.(Model)
			updated, _ = m.Update(refresh())
			m = updated.(Model)
			if m.selected != "b" || len(m.snapshot.Workers) != 1 {
				t.Fatal("unpin did not apply removal checks")
			}
		})
	}
}

func TestPinFailureAndEditorIsolation(t *testing.T) {
	m, b := testModel()
	b.err = errors.New("pin rejected")
	m, cmd := press(m, "P")
	updated, _ := m.Update(cmd())
	m = updated.(Model)
	if m.worker().Pinned || m.failure == "" || m.busy {
		t.Fatal("pin failure not surfaced")
	}
	m, _ = press(m, "enter")
	m, cmd = press(m, "P")
	if m.busy || m.worker().Pinned || m.composer.Value() != "P" {
		t.Fatal("typing toggled a pin")
	}
}

func TestPinControlVisibleAndClickableAtSupportedSizes(t *testing.T) {
	for _, width := range []int{40, 60, 100} {
		for _, status := range []string{"running", "completed"} {
			m, b := testModel()
			b.snapshot.Workers[0].Pinned = true
			b.snapshot.Workers[0].Status = status
			updated, _ := m.Update(snapshotMsg{snapshot: b.snapshot})
			m = updated.(Model)
			updated, _ = m.Update(tea.WindowSizeMsg{Width: width, Height: 24})
			m = updated.(Model)
			_, cmd := clickTarget(t, m, "key", "P", "", 0)
			if cmd == nil {
				t.Fatal("pin click did not dispatch")
			}
		}
	}
}

func TestPinnedIndicatorRichAndPortable(t *testing.T) {
	for _, portable := range []bool{false, true} {
		m, _ := testModel()
		m.options.Portable = portable
		m.snapshot.Workers[0].Pinned = true
		marker := "📌 PIN"
		if portable {
			marker = "PIN"
		}
		for _, block := range []layoutBlock{m.workerCards(), m.workerContent()} {
			text := strings.Join(block.lines, "\n")
			if !strings.Contains(text, marker) {
				t.Fatalf("missing marker %q", marker)
			}
			if portable && strings.Contains(text, "📌") {
				t.Fatal("emoji in portable indicator")
			}
		}
	}
}
