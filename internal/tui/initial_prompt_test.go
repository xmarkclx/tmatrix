package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"github.com/muesli/termenv"
	"tmatrix/internal/backend"
)

func TestInitialPromptPreservesCapturedInputWithoutVersionLabels(t *testing.T) {
	m, _ := testModel()
	m.snapshot.Workers[0].Title = "This title is not the prompt"
	m.snapshot.Workers[0].InputRevision = 9
	m.snapshot.Workers[0].InitialPrompt = &backend.InitialPrompt{
		Text: "Original task instructions 👩🏽‍💻", InputRevision: 2, Truncated: true, Redacted: true,
	}
	m.syncActivity()
	m, _ = press(m, "home")
	frame := ansi.Strip(m.viewport.View())
	for _, wanted := range []string{"INITIAL PROMPT", "Prepared input · receipt shown in activity", "Original task instructions", "Excerpt:", "Credential-like values redacted.", "╔", "║"} {
		if !strings.Contains(frame, wanted) {
			t.Fatalf("missing prompt evidence %q: %s", wanted, frame)
		}
	}
	if strings.Contains(frame, "Prepared input v") || strings.Contains(frame, m.worker().Title) {
		t.Fatal("prompt exposed internal counters or was synthesized from current metadata")
	}
}

func TestMissingInitialPromptIsExplicit(t *testing.T) {
	m, _ := testModel()
	m, _ = press(m, "home")
	if !strings.Contains(ansi.Strip(m.viewport.View()), "Not captured for this run") {
		t.Fatal("missing capture disguised as an initial prompt")
	}
}

func TestPromptFramesPaintEveryCellAndFilterTerminalControls(t *testing.T) {
	original := lipgloss.ColorProfile()
	t.Cleanup(func() { lipgloss.SetColorProfile(original) })
	for _, profile := range []termenv.Profile{termenv.TrueColor, termenv.ANSI256, termenv.ANSI, termenv.Ascii} {
		lipgloss.SetColorProfile(profile)
		for _, size := range [][2]int{{40, 16}, {60, 24}, {110, 40}} {
			m, _ := testModel()
			m.snapshot.Workers[0].InitialPrompt = &backend.InitialPrompt{Text: strings.Repeat("界 👩🏽‍💻 e\u0301 initial input ", 200) + "\x1b]52;c;UNSAFE\x07\x1b[2J", InputRevision: 1}
			next, _ := m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
			m = next.(Model)
			m, _ = press(m, "home")
			frame := m.View()
			if strings.Contains(frame, "UNSAFE") || strings.Contains(m.activity(), "\x1b[2J") {
				t.Fatal("prompt passed untrusted terminal controls")
			}
			if profile == termenv.Ascii {
				if strings.ContainsRune(frame, '\x1b') {
					t.Fatal("NO_COLOR prompt contains ANSI")
				}
			} else {
				assertPaintedFrame(t, frame, size[0], size[1])
			}
		}
	}
}

func TestInitialPromptAndLatestBarClicksMatchLabelsWhileComposing(t *testing.T) {
	m := scrollModel(20)
	m, _ = press(m, "enter")
	m.composer.SetValue("Keep this draft 👩🏽‍💻")
	m, _ = clickTarget(t, m, "key", "home", "", 0)
	if m.following || !m.viewport.AtTop() || !strings.Contains(ansi.Strip(m.viewport.View()), "INITIAL PROMPT") {
		t.Fatal("initial prompt bar did not reach initial prompt")
	}
	if !m.composing || m.composer.Value() != "Keep this draft 👩🏽‍💻" {
		t.Fatal("prompt click changed draft")
	}
	m, _ = clickTarget(t, m, "key", "f", "", 0)
	if !m.following || !m.viewport.AtBottom() {
		t.Fatal("latest bar did not return to latest")
	}
	m = scrollKey(m, tea.KeyCtrlHome)
	if m.following || !m.viewport.AtTop() {
		t.Fatal("Ctrl+Home did not reach prompt while composing")
	}
	m = scrollKey(m, tea.KeyCtrlEnd)
	if !m.following || !m.viewport.AtBottom() || m.composer.Value() != "Keep this draft 👩🏽‍💻" {
		t.Fatal("Ctrl+End did not follow without changing draft")
	}
}
