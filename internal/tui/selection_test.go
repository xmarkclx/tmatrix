package tui

import (
	"reflect"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestSelectionTogglePreservesEditorAndControlsMouse(t *testing.T) {
	m, b := testModel()
	m, _ = press(m, "enter")
	m, _ = press(m, "draft")
	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyF2})
	m = next.(Model)
	if !m.mouseDisabled || cmd == nil || reflect.TypeOf(cmd()) != reflect.TypeOf(tea.DisableMouse()) {
		t.Fatal("F2 did not release mouse capture")
	}
	if !m.composing || m.composer.Value() != "draft" || b.message != "" {
		t.Fatal("selection toggle changed or sent draft")
	}
	m, _ = clickText(t, m, "[p]")
	if m.screen != workersScreen {
		t.Fatal("disabled mouse still navigates")
	}
	next, cmd = m.Update(tea.KeyMsg{Type: tea.KeyF2})
	m = next.(Model)
	if m.mouseDisabled || cmd == nil || reflect.TypeOf(cmd()) != reflect.TypeOf(tea.EnableMouseCellMotion()) {
		t.Fatal("F2 did not restore capture")
	}
	m, _ = press(m, "esc")
	m, _ = clickText(t, m, "[p]")
	if m.screen != pollersScreen {
		t.Fatal("restored mouse cannot navigate")
	}
	m = New(b, Options{NoMouse: true})
	next, cmd = m.Update(tea.KeyMsg{Type: tea.KeyF2})
	if next.(Model).mouseDisabled || reflect.TypeOf(cmd()) != reflect.TypeOf(tea.EnableMouseCellMotion()) {
		t.Fatal("--no-mouse initial state not respected")
	}
}

func TestBracketedPasteRequiresEditorAndExplicitSend(t *testing.T) {
	paste := func(m Model, text string) (Model, tea.Cmd) {
		next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(text), Paste: true})
		return next.(Model), cmd
	}
	for _, text := range []string{"q", "s", " ", "x", "f2"} {
		m, _ := testModel()
		m, cmd := paste(m, text)
		if cmd != nil || m.screen != workersScreen || m.confirmation != "" || m.mouseDisabled {
			t.Fatalf("paste %q triggered action", text)
		}
	}
	m, b := testModel()
	m, _ = press(m, "x")
	m, cmd := paste(m, "y")
	if cmd != nil || m.confirmation == "" || b.stops != 0 {
		t.Fatal("paste confirmed stop")
	}
	m, _ = press(m, "esc")
	m, _ = press(m, "enter")
	m, _ = paste(m, "hello 👩🏽‍💻\nworld")
	if m.composer.Value() != "hello 👩🏽‍💻 world" || b.message != "" || m.busy {
		t.Fatalf("paste lost text or sent automatically: %q", m.composer.Value())
	}
	m, cmd = press(m, "enter")
	execute(m, cmd)
	if b.message != "hello 👩🏽‍💻 world" {
		t.Fatal("explicit send lost paste")
	}

	m, _ = testModel()
	m.openForm(connectScreen)
	m, cmd = paste(m, "q")
	if cmd != nil || m.form[m.field].Value() == "q" {
		t.Fatal("paste edited unfocused form")
	}
	m.form[m.field].Focus()
	m.form[m.field].SetValue("")
	m, _ = paste(m, "https://example.test")
	if m.form[m.field].Value() != "https://example.test" {
		t.Fatal("active field rejected paste")
	}
}
