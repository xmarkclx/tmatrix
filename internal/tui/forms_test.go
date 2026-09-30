package tui

import (
	"fmt"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestFormsRequireEnterToEditEachSelectedField(t *testing.T) {
	for _, screen := range []screen{settingsScreen, connectScreen} {
		m, b := testModel()
		m.openForm(screen)
		for index := range m.form {
			if m.field != index {
				t.Fatal("Tab did not select the next field")
			}
			before := m.form[index].Value()
			m, _ = press(m, "9")
			if m.form[index].Focused() || m.form[index].Value() != before {
				t.Fatal("selection captured text before Enter")
			}
			m, _ = press(m, "enter")
			m, _ = press(m, "9")
			if !m.form[index].Focused() || m.form[index].Value() == before {
				t.Fatal("Enter did not enable editing")
			}
			m, _ = press(m, "enter")
			if m.form[index].Focused() || m.busy || m.screen != screen {
				t.Fatal("Enter should finish editing without submitting")
			}
			m, _ = press(m, "enter")
			m, _ = press(m, "esc")
			if m.form[index].Focused() || m.screen != screen {
				t.Fatal("Escape should leave editing before closing the form")
			}
			m, _ = press(m, "enter")
			m, _ = press(m, "tab")
			for _, input := range m.form {
				if input.Focused() {
					t.Fatal("Tab should select without starting another editor")
				}
			}
		}
		if b.settings.MaxWorkers != nil || b.connection.URL != "" {
			t.Fatal("editing unexpectedly saved the form")
		}
	}
}

func TestFormNavigationWorksBeforeAndDuringEditing(t *testing.T) {
	for _, size := range [][2]int{{40, 16}, {60, 24}, {110, 34}} {
		for _, page := range []screen{settingsScreen, connectScreen} {
			for _, editing := range []bool{false, true} {
				for _, nav := range []struct {
					label string
					page  screen
				}{{"[w]", workersScreen}, {"[p]", pollersScreen}, {"[?]", helpScreen}} {
					t.Run(fmt.Sprintf("%v/%d/%t/%s", size, page, editing, nav.label), func(t *testing.T) {
						m, b := testModel()
						next, _ := m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
						m = next.(Model)
						m.openForm(page)
						if editing {
							m, _ = press(m, "enter")
							m, _ = press(m, "9")
						}
						m, _ = clickText(t, m, nav.label)
						if m.screen != nav.page || len(m.form) != 0 {
							t.Fatal("tab click was trapped by the form")
						}
						if b.settings.MaxWorkers != nil || b.connection.URL != "" {
							t.Fatal("navigation submitted unsaved changes")
						}
					})
				}
			}
		}
	}
}

func TestFieldClickEndsEditingWithoutStartingAnotherEditor(t *testing.T) {
	m, _ := testModel()
	m.openForm(settingsScreen)
	m, _ = press(m, "enter")
	m, _ = clickTarget(t, m, "field", "", "", 1)
	m, _ = press(m, "9")
	if m.field != 1 || m.form[0].Focused() || m.form[1].Focused() || m.form[1].Value() != "5000" {
		t.Fatal("field click should only change selection")
	}
	m, _ = press(m, "p")
	if m.screen != pollersScreen {
		t.Fatal("navigation shortcut was captured outside editing")
	}
}
