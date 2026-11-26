package tui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
	"tmatrix/internal/backend"
)

func terminalModel(terminal *backend.Terminal) Model {
	m, b := testModel()
	b.snapshot.Workers[0].Terminal = terminal
	result, _ := m.Update(snapshotMsg{snapshot: b.snapshot})
	return result.(Model)
}

func TestTerminalWorkerShowsMirroredScreenAndToggles(t *testing.T) {
	m := terminalModel(&backend.Terminal{Socket: "tmx-0123456789ab", Session: "claude"})
	if !m.screenLoop {
		t.Fatal("expected screen mirroring to start for a terminal worker")
	}
	result, _ := m.Update(screenMsg{workerID: "a", text: "\x1b[32m● Fixing the footer\x1b[0m\n❯ "})
	m = result.(Model)
	frame := ansi.Strip(m.View())
	for _, want := range []string{"● Fixing the footer", "[v] Activity", "[a] Attach"} {
		if !strings.Contains(frame, want) {
			t.Fatalf("terminal view missing %q:\n%s", want, frame)
		}
	}
	if strings.Contains(frame, "Inspecting the project.") {
		t.Fatalf("activity shown instead of the screen:\n%s", frame)
	}
	m, _ = press(m, "v")
	frame = ansi.Strip(m.View())
	if !strings.Contains(frame, "Inspecting the project.") || !strings.Contains(frame, "[v] Screen") {
		t.Fatalf("v did not switch back to activity:\n%s", frame)
	}
}

func TestTerminalReferencesAreValidatedBeforeUse(t *testing.T) {
	for _, terminal := range []*backend.Terminal{
		nil, {Socket: "../../tmp/x", Session: "claude"}, {Socket: "tmx-0123456789ab", Session: "-t evil"},
	} {
		m := terminalModel(terminal)
		if m.showingTerminal() || m.screenLoop {
			t.Fatalf("unexpected terminal mirroring for %+v", terminal)
		}
		if _, cmd := press(m, "a"); cmd != nil {
			t.Fatalf("attach offered for invalid terminal %+v", terminal)
		}
	}
}
