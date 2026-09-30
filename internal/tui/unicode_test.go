package tui

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

func TestUnicodeSurvivesTerminalSanitizingAndWrapping(t *testing.T) {
	for _, glyph := range []string{"👩🏽‍💻", "🇵🇭", "⌨️", "👨‍👩‍👧‍👦", "e\u0301", "1️⃣", "界"} {
		if got := clean("\x1b]52;c;unsafe\x07" + glyph + "\x1b[2J\x00"); got != glyph {
			t.Fatalf("sanitizer changed glyph %q: %q", glyph, got)
		}
		if got := single("\t " + glyph + "\n"); got != glyph {
			t.Fatalf("single-line text changed glyph %q: %q", glyph, got)
		}
		width := lipgloss.Width(glyph)
		if got := ellipsis(glyph+"x", width+1); got != glyph+"x" {
			t.Fatalf("truncation lost a complete glyph: %q", got)
		}
		if got := ellipsis(glyph+"xyz", width+1); got != glyph+"…" {
			t.Fatalf("truncation split a glyph: %q", got)
		}
		wrapped := ansi.Strip(textBlock(glyph+glyph, max(2, width)))
		if strings.ReplaceAll(wrapped, "\n", "") != glyph+glyph {
			t.Fatalf("wrapping changed glyph %q: %q", glyph, wrapped)
		}
		for _, line := range strings.Split(wrapped, "\n") {
			if lipgloss.Width(line) > max(2, width) {
				t.Fatalf("glyph overflowed: %q", line)
			}
		}
	}
}

func TestComposerMovesAndDeletesWholeEmoji(t *testing.T) {
	for _, glyph := range []string{"👩🏽‍💻", "🇵🇭", "⌨️", "👨‍👩‍👧‍👦", "e\u0301", "1️⃣"} {
		input := textinput.New()
		input.Focus()
		input, _ = updateComposer(input, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("a" + glyph + "b"), Paste: true})
		if input.Value() != "a"+glyph+"b" {
			t.Fatalf("paste changed %q: %q", glyph, input.Value())
		}
		input, _ = updateComposer(input, tea.KeyMsg{Type: tea.KeyLeft})
		input, _ = updateComposer(input, tea.KeyMsg{Type: tea.KeyLeft})
		if input.Position() != 1 {
			t.Fatalf("left landed inside %q: %d", glyph, input.Position())
		}
		input, _ = updateComposer(input, tea.KeyMsg{Type: tea.KeyRight})
		if input.Position() != 1+utf8.RuneCountInString(glyph) {
			t.Fatalf("right landed inside %q: %d", glyph, input.Position())
		}
		input, _ = updateComposer(input, tea.KeyMsg{Type: tea.KeyBackspace})
		if input.Value() != "ab" || input.Position() != 1 {
			t.Fatalf("backspace left half a glyph: %q", input.Value())
		}
		input.SetValue("a" + glyph + "b")
		input.SetCursor(1)
		input, _ = updateComposer(input, tea.KeyMsg{Type: tea.KeyDelete})
		if input.Value() != "ab" || input.Position() != 1 {
			t.Fatalf("delete left half a glyph: %q", input.Value())
		}
	}
}

func TestComposerViewportAndLimitKeepCompleteGraphemes(t *testing.T) {
	const glyph = "👩🏽‍💻"
	input := textinput.New()
	input.Focus()
	input.Width = 5
	input.SetValue("abc" + glyph + "de" + glyph)
	for _, pos := range []int{0, 3, 7, 9, 13} {
		input.SetCursor(pos)
		view := composerView(input)
		if lipgloss.Width(view) != lipgloss.Width(input.Prompt)+6 {
			t.Fatalf("composer width at %d: %d (%q)", pos, lipgloss.Width(view), view)
		}
		stripped := ansi.Strip(view)
		withoutGlyphs := strings.ReplaceAll(stripped, glyph, "")
		if strings.ContainsAny(withoutGlyphs, "👩🏽‍💻") {
			t.Fatalf("viewport split grapheme at %d: %q", pos, stripped)
		}
	}
	input.Reset()
	input.CharLimit = 3 // The four-rune emoji cannot fit, so omit it entirely.
	input, _ = updateComposer(input, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("a" + glyph), Paste: true})
	if input.Value() != "a" {
		t.Fatal("character limit split a grapheme:", input.Value())
	}
	input.CharLimit = 0
	input.SetValue("a" + glyph + "b")
	input.SetCursor(3) // A restored draft may inherit another worker's position.
	input, _ = updateComposer(input, tea.KeyMsg{Type: tea.KeyBackspace})
	if input.Value() != "ab" {
		t.Fatal("restored cursor split a grapheme:", input.Value())
	}
	input.CharLimit = 4
	input.SetValue("abcd")
	input.SetCursor(2)
	input, _ = updateComposer(input, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(glyph), Paste: true})
	if input.Value() != "abcd" || input.Position() != 2 {
		t.Fatal("full draft lost suffix on middle paste:", input.Value())
	}
	input.CharLimit = 7
	input.SetValue("abcd")
	input.SetCursor(2)
	input, _ = updateComposer(input, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("X" + glyph), Paste: true})
	if input.Value() != "abXcd" || input.Position() != 3 {
		t.Fatal("partial paste changed draft suffix or split glyph:", input.Value())
	}
}

func TestEmojiMessageRetainsExactContentThroughWorkerDraftAndSend(t *testing.T) {
	m, service := testModel()
	message := "👩🏽‍💻 Check 🇵🇭 support and e\u0301 labels ✅"
	m, _ = press(m, "enter")
	m, _ = press(m, message)
	m, _ = press(m, "esc")
	m, _ = press(m, "right")
	m, _ = press(m, "1")
	m, _ = press(m, "enter")
	if m.composer.Value() != message {
		t.Fatal("emoji draft changed")
	}
	var command tea.Cmd
	m, command = press(m, "enter")
	execute(m, command)
	if service.message != message {
		t.Fatal("emoji changed in backend payload")
	}
}
