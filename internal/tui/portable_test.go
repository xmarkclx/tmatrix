package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"github.com/muesli/termenv"
)

func TestPortableFramePreservesCellsAndInternationalText(t *testing.T) {
	for _, input := range []string{
		"👩🏽‍💻 🇵🇭 👨‍👩‍👧‍👦 1️⃣ ⚙️ 💬 ⌨️ ✅",
		"╭──╮│ ═║╯ ○●◐• ←→‹›↳ …",
		"\x1b[32m日本語 café e\u0301\x1b[0m",
	} {
		got := portableFrame(input)
		if ansi.StringWidth(got) != ansi.StringWidth(input) {
			t.Fatalf("cell geometry changed: %q -> %q", input, got)
		}
		if strings.ContainsAny(got, "👩🇵👨⚙💬⌨✅\u200d\ufe0f\u20e3") {
			t.Fatalf("unstable emoji remains: %q", got)
		}
	}
	text := "日本語 café e\u0301"
	if portableFrame(text) != text {
		t.Fatal("portable rendering altered international text")
	}
}

func TestPortableResizeScreensAndDraftSubmission(t *testing.T) {
	original := lipgloss.ColorProfile()
	t.Cleanup(func() { lipgloss.SetColorProfile(original) })
	for _, profile := range []termenv.Profile{termenv.ANSI, termenv.ANSI256, termenv.TrueColor, termenv.Ascii} {
		lipgloss.SetColorProfile(profile)
		m, backend := testModel()
		m.options.Portable = true
		m.snapshot.Workers[0].Title = "👩🏽‍💻 Inspect 日本語 🇵🇭"
		for _, size := range [][2]int{{160, 54}, {80, 24}, {41, 16}, {120, 40}} {
			resized, cmd := m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
			m = resized.(Model)
			if cmd == nil {
				t.Fatal("resize must invalidate stale terminal rows")
			}
			for _, key := range []string{"w", "s", "esc", "c", "esc", "?", "esc", "w"} {
				m, _ = press(m, key)
				frame := m.View()
				if profile != termenv.Ascii {
					assertPaintedFrame(t, frame, size[0]-1, size[1])
				} else {
					if len(strings.Split(frame, "\n")) != size[1] || strings.ContainsRune(frame, '\x1b') {
						t.Fatal("invalid no-color portable frame")
					}
				}
				for _, line := range strings.Split(frame, "\n") {
					if ansi.StringWidth(line) != size[0]-1 {
						t.Fatal("portable frame occupies rightmost column")
					}
				}
			}
		}
		m, _ = press(m, "enter")
		message := "Keep 👩🏽‍💻 and 日本語 intact"
		m.composer.SetValue(message)
		_ = m.View()
		redrawn, repaint := m.Update(tea.KeyMsg{Type: tea.KeyCtrlL})
		m = redrawn.(Model)
		if repaint == nil || m.composer.Value() != message {
			t.Fatal("manual redraw changed the draft")
		}
		_, send := press(m, "enter")
		if send == nil {
			t.Fatal("missing send command")
		}
		send()
		if backend.message != message {
			t.Fatalf("portable mode changed submitted text: %q", backend.message)
		}
	}
}
