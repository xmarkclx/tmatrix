package tui

import (
	"errors"
	tea "github.com/charmbracelet/bubbletea"
	"strings"
	"testing"
)

type fakeServiceManager struct {
	fakeBackend
	actions []string
}

func (b *fakeServiceManager) ManageService(action string) error {
	b.actions = append(b.actions, action)
	return b.err
}
func serviceKey(m Model, key string) (Model, tea.Cmd) {
	next, cmd := m.Update(mouseKey(key))
	return next.(Model), cmd
}
func TestServiceControls(t *testing.T) {
	for _, action := range []string{"install", "uninstall"} {
		t.Run(action, func(t *testing.T) {
			b := &fakeServiceManager{}
			m := New(b, Options{})
			m.openForm(settingsScreen)
			m.form[0].SetValue("7")
			key := "i"
			if action == "uninstall" {
				key = "u"
			}
			m, cmd := serviceKey(m, key)
			if cmd != nil || len(b.actions) != 0 || m.serviceConfirmation != action {
				t.Fatal("action ran without confirmation")
			}
			m, _ = serviceKey(m, "n")
			if m.serviceConfirmation != "" {
				t.Fatal("cancel failed")
			}
			m, _ = serviceKey(m, key)
			m, cmd = serviceKey(m, "y")
			if !m.busy || cmd == nil {
				t.Fatal("operation not pending")
			}
			_, duplicate := serviceKey(m, key)
			if duplicate != nil {
				t.Fatal("duplicate operation")
			}
			m = execute(m, cmd)
			if m.busy || m.failure != "" || len(b.actions) != 1 || b.actions[0] != action {
				t.Fatal("operation did not complete")
			}
			if m.screen != settingsScreen || m.form[0].Value() != "7" {
				t.Fatal("lost unsaved settings")
			}
		})
	}
}
func TestServiceErrorsAndDemo(t *testing.T) {
	b := &fakeServiceManager{fakeBackend: fakeBackend{err: errors.New("systemd unavailable")}}
	m := New(b, Options{})
	m.openForm(settingsScreen)
	m, _ = serviceKey(m, "i")
	m, cmd := serviceKey(m, "y")
	m = execute(m, cmd)
	if m.busy || !strings.Contains(m.failure, "systemd unavailable") {
		t.Fatal("error not displayed")
	}
	m.options.Demo = true
	m, cmd = serviceKey(m, "u")
	if cmd != nil || m.serviceConfirmation != "" || len(b.actions) != 1 {
		t.Fatal("demo changed service")
	}
}
func TestServiceMouseAndCompactLayout(t *testing.T) {
	for _, width := range []int{40, 60, 100} {
		m := New(&fakeServiceManager{}, Options{})
		m.width, m.height = width, 16
		m.openForm(settingsScreen)
		if !strings.Contains(m.View(), "Install service") || !strings.Contains(m.View(), "Uninstall service") {
			t.Fatal("service actions missing from Settings at compact size")
		}
		_, targets := m.renderLayout()
		found := false
		for _, target := range targets {
			if target.key == "u" {
				next, _ := m.activateTarget(target)
				m = next.(Model)
				found = true
				break
			}
		}
		if !found || m.serviceConfirmation != "uninstall" {
			t.Fatal("uninstall not clickable")
		}
		if !strings.Contains(m.View(), "Uninstall TMatrix service?") || !strings.Contains(m.View(), "standalone engine.") {
			t.Fatal("confirmation missing")
		}
		next, _ := m.activateTarget(hitTarget{action: "key", key: "esc"})
		if next.(Model).serviceConfirmation != "" {
			t.Fatal("mouse cancel failed")
		}
	}
}

func TestSettingsServiceActionsPreserveEditingAndBlockClickThrough(t *testing.T) {
	m := New(&fakeServiceManager{}, Options{})
	m.openForm(settingsScreen)
	m, _ = serviceKey(m, "enter")
	before := m.form[0].Value()
	m, _ = serviceKey(m, "i")
	m, _ = serviceKey(m, "u")
	if m.screen != settingsScreen || m.serviceConfirmation != "" || m.form[0].Value() != before+"iu" {
		t.Fatal("service shortcuts intercepted field editing")
	}
	m, _ = clickTarget(t, m, "key", "i", "", 0)
	if m.serviceConfirmation != "install" || m.form[0].Focused() {
		t.Fatal("click did not end editing and open confirmation")
	}
	m, _ = clickTarget(t, m, "key", "w", "", 0)
	if m.screen != serviceScreen || m.serviceConfirmation != "install" {
		t.Fatal("navigation clicked through service confirmation")
	}
	m, _ = serviceKey(m, "esc")
	if m.screen != settingsScreen || m.form[0].Value() != before+"iu" {
		t.Fatal("cancel discarded settings draft")
	}
}

func TestSettingsServiceActionsStayVisibleWhileNavigatingCompactFields(t *testing.T) {
	m := New(&fakeServiceManager{}, Options{})
	m.width, m.height = 40, 16
	m.openForm(settingsScreen)
	for index := range m.form {
		m.focusField(index)
		view := m.View()
		if !strings.Contains(view, m.form[index].Value()) {
			t.Fatalf("selected field %d value is clipped", index)
		}
		targetFor(t, m, "field", "", "", index)
		targetFor(t, m, "key", "i", "", 0)
		targetFor(t, m, "key", "u", "", 0)
	}
}
