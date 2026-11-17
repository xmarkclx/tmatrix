package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"tmatrix/internal/backend"
)

func TestSourceSelectionAddAndExplicitEdit(t *testing.T) {
	m, b := testModel()
	b.snapshot.Pollers = append(b.snapshot.Pollers, backend.Poller{ID: "mindmap", Name: "Mindmap", Type: "tzudo", URL: "https://mindmap.invalid/api/ai-chat/worker/poll", Status: "connected"})
	next, _ := m.Update(snapshotMsg{snapshot: b.snapshot})
	m = next.(Model)
	m, _ = press(m, "p")
	if !strings.Contains(m.View(), "TzuDo") || !strings.Contains(m.View(), "Mindmap") {
		t.Fatal("source list omitted a configured connection")
	}
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	m = next.(Model)
	if m.source().ID != "mindmap" {
		t.Fatal("down did not select the next source")
	}
	m, _ = press(m, "e")
	if m.editingSource != "mindmap" || m.form[0].Value() != "Mindmap" || m.form[1].Value() != "https://mindmap.invalid/api/ai-chat/worker/poll" || m.form[2].Value() != "" {
		t.Fatal("edit did not use only the selected source")
	}
	m.form[0].SetValue("LifeCCC chat")
	var cmd tea.Cmd
	m, cmd = press(m, "ctrl+s")
	m = execute(m, cmd)
	if b.connection.SourceID != "mindmap" || b.connection.Name != "LifeCCC chat" || b.connection.APIKey != "" {
		t.Fatal("edit lost source identity or reused another key")
	}
	m, _ = press(m, "c")
	if m.editingSource != "" || m.form[0].Value() != "" || m.form[2].Value() != "" {
		t.Fatal("add retained source identity or secret")
	}
	m.form[0].SetValue("Other source")
	m.form[1].SetValue("https://other.invalid/poll")
	m.form[2].SetValue("fixture-key")
	m, cmd = press(m, "ctrl+s")
	m = execute(m, cmd)
	if b.connection.SourceID != "" || b.connection.Name != "Other source" || b.connection.URL != "https://other.invalid/poll" || b.connection.APIKey != "fixture-key" || len(m.form) != 0 {
		t.Fatal("add replaced the previously selected source or retained its secret")
	}
}

func TestSourceRemovalRequiresConfirmationAndTargetsSelectedSource(t *testing.T) {
	m, b := testModel()
	b.snapshot.Pollers = append(b.snapshot.Pollers, backend.Poller{ID: "mindmap", Name: "Mindmap", Status: "connected"})
	next, _ := m.Update(snapshotMsg{snapshot: b.snapshot})
	m = next.(Model)
	m, _ = press(m, "p")
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	m = next.(Model)
	m, _ = press(m, "d")
	if m.removingSource != "mindmap" || b.removedSource != "" || !strings.Contains(m.notice, "Mindmap") {
		t.Fatal("removal did not require confirmation for selected source")
	}
	m, _ = press(m, "n")
	if m.removingSource != "" || b.removedSource != "" {
		t.Fatal("cancelled removal changed connection")
	}
	m, _ = press(m, "d")
	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("y"), Paste: true})
	m = next.(Model)
	if cmd != nil || m.removingSource != "mindmap" || b.removedSource != "" {
		t.Fatal("pasted text confirmed source removal")
	}
	m, cmd = press(m, "y")
	m = execute(m, cmd)
	if b.removedSource != "mindmap" || len(b.snapshot.Pollers) != 1 || b.snapshot.Pollers[0].ID != "test-tzudo" {
		t.Fatal("confirmed removal targeted another source")
	}
}

func TestOneSourceFailureDoesNotMarkHealthyEngineStopped(t *testing.T) {
	m, b := testModel()
	b.snapshot.IntakePaused = false
	b.snapshot.Pollers[0].Status = "stopped"
	b.snapshot.Pollers = append(b.snapshot.Pollers, backend.Poller{ID: "mindmap", Name: "Mindmap", Status: "connected"})
	next, _ := m.Update(snapshotMsg{snapshot: b.snapshot})
	m = next.(Model)
	if strings.Contains(m.View(), "Engine draining") || !strings.Contains(m.View(), "Accepting New Tasks") {
		t.Fatal("one failed source marked healthy engine stopped")
	}
	b.snapshot.Workers[0].SourceName = "Mindmap"
	next, _ = m.Update(snapshotMsg{snapshot: b.snapshot})
	m = next.(Model)
	if !strings.Contains(m.View(), "Mindmap") {
		t.Fatal("worker source attribution is absent")
	}
}
