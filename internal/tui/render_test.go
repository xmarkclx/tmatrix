package tui

import (
	"fmt"
	"io"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/cellbuf"
	"github.com/muesli/termenv"
	"tmatrix/internal/backend"
)

// A terminal's default background may be grey, transparent, or user-defined.
// Track an unset background separately instead of pretending SGR resets return
// to the app's palette; that mistake concealed the original WSL rendering bug.
func assertPaintedFrame(t *testing.T, frame string, width, height int) {
	t.Helper()
	lines := strings.Split(frame, "\n")
	if len(lines) != height {
		t.Fatalf("frame has %d rows, want %d", len(lines), height)
	}
	for row, line := range lines {
		if got := lipgloss.Width(line); got != width {
			t.Fatalf("row %d has %d cells, want %d", row, got, width)
		}
		// Bubble Tea can redraw a single row. Each row must paint correctly
		// without inheriting the previous row's last active style.
		var pen cellbuf.Style
		var state byte
		parser := ansi.NewParser()
		column := 0
		for len(line) > 0 {
			sequence, cells, consumed, next := ansi.DecodeSequence(line, state, parser)
			if consumed == 0 {
				t.Fatalf("cannot decode terminal output at row %d column %d", row, column)
			}
			// The decoder can emit an ASCII base and its combining mark in
			// separate steps. Zero-width Unicode still inherits the current pen;
			// it is not a terminal control sequence.
			zeroWidthText := cells == 0 && sequence != "" && utf8.ValidString(sequence)
			for _, character := range sequence {
				if unicode.IsControl(character) {
					zeroWidthText = false
				}
			}
			if cells > 0 || zeroWidthText {
				background := pen.Bg
				if pen.Attrs&cellbuf.ReverseAttr != 0 {
					background = pen.Fg
				}
				if background == nil {
					t.Fatalf("terminal default background leaks at row %d column %d (%q)", row, column, sequence)
				}
				column += cells
			} else if ansi.HasCsiPrefix(sequence) && parser.Command() == 'm' {
				cellbuf.ReadStyle(parser.Params(), &pen)
			} else {
				t.Fatalf("unexpected terminal control in frame: %q", sequence)
			}
			state = next
			line = line[consumed:]
		}
		if column != width {
			t.Fatalf("decoded row %d has %d cells, want %d", row, column, width)
		}
	}
}

func TestFramesPaintEveryCellAcrossColorProfiles(t *testing.T) {
	original := lipgloss.ColorProfile()
	t.Cleanup(func() { lipgloss.SetColorProfile(original) })
	states := []string{"workers", "compose", "stop", "empty", "pollers", "settings", "connect", "help", "error"}
	for _, profile := range []termenv.Profile{termenv.TrueColor, termenv.ANSI256, termenv.ANSI} {
		for _, size := range [][2]int{{40, 16}, {60, 24}, {110, 34}} {
			for _, screen := range states {
				name := fmt.Sprintf("%s/%dx%d/%s", profile.Name(), size[0], size[1], screen)
				t.Run(name, func(t *testing.T) {
					lipgloss.SetColorProfile(profile)
					m, _ := testModel()
					m.snapshot.Workers[0].Title = "👩🏽‍💻 Inspect 界界 worker activity 🇵🇭"
					m.snapshot.Workers[0].Activity = []backend.Activity{{
						At: "2026-09-29T10:01:00Z", Kind: "tool",
						Text: strings.Repeat("Unicode 界界 👩🏽‍💻 🇵🇭 e\u0301 and wrapped activity. ", 9) + "\n\nA second paragraph 👨‍👩‍👧‍👦.",
					}}
					resized, _ := m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
					m = resized.(Model)
					switch screen {
					case "compose":
						m, _ = press(m, "enter")
						m.composer.SetValue("Please 👩🏽‍💻 inspect 界界 🇵🇭 focus")
						m.composer.SetCursor(7) // Cursor covers a whole compound emoji.
					case "stop":
						m, _ = press(m, "x")
					case "empty":
						m.snapshot.Workers = nil
					case "pollers":
						m.screen = pollersScreen
					case "settings":
						m.openForm(settingsScreen)
					case "connect":
						m.openForm(connectScreen)
						m.focusField(1)
						m.form[1].SetValue("fictional-key")
					case "help":
						m.screen = helpScreen
					case "error":
						m.failure = "Sample connection failed; retry is available."
					}
					assertPaintedFrame(t, m.View(), size[0], size[1])
				})
			}
		}
	}
}

func TestNoColorFramesRemainReadable(t *testing.T) {
	// Detect the actual NO_COLOR preference in a color-capable terminal, then
	// render with that profile using the renderer held by the shared styles.
	t.Setenv("NO_COLOR", "1")
	t.Setenv("COLORTERM", "truecolor")
	t.Setenv("TERM", "xterm-256color")
	t.Setenv("CLICOLOR_FORCE", "1")
	profile := lipgloss.NewRenderer(io.Discard, termenv.WithTTY(true)).ColorProfile()
	if profile != termenv.Ascii {
		t.Fatal("NO_COLOR did not take precedence over color capability")
	}
	original := lipgloss.ColorProfile()
	t.Cleanup(func() { lipgloss.SetColorProfile(original) })
	lipgloss.SetColorProfile(profile)
	m, _ := testModel()
	for _, key := range []string{"w", "enter", "esc", "s", "esc", "c", "esc", "?"} {
		m, _ = press(m, key)
		frame := m.View()
		if strings.ContainsRune(frame, '\x1b') {
			t.Fatalf("NO_COLOR frame after %q contains ANSI escapes", key)
		}
		if !strings.Contains(frame, "TMATRIX") || !strings.Contains(frame, "DEMO") || !strings.Contains(frame, "Workers") {
			t.Fatalf("NO_COLOR frame after %q lost navigation or sample labels", key)
		}
	}
}

func TestUndersizedTerminalPaintsResizeNotice(t *testing.T) {
	original := lipgloss.ColorProfile()
	t.Cleanup(func() { lipgloss.SetColorProfile(original) })
	lipgloss.SetColorProfile(termenv.TrueColor)
	m, _ := testModel()
	resized, _ := m.Update(tea.WindowSizeMsg{Width: 32, Height: 12})
	frame := resized.(Model).View()
	assertPaintedFrame(t, frame, 32, 12)
	if !strings.Contains(ansi.Strip(frame), "resize") {
		t.Fatal("undersized terminal lost resize notice")
	}
}
