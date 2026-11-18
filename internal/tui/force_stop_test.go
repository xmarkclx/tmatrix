package tui

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"tmatrix/internal/backend"
)

type forceStopBackend struct {
	fakeRestarter
	calls int
}

func (b *forceStopBackend) CanForceStop() bool { return true }

func (b *forceStopBackend) ForceStop(ctx context.Context) error {
	b.calls++
	if _, ok := ctx.Deadline(); !ok {
		return errors.New("force stop requires a deadline")
	}
	return nil
}

func TestForceStopDuringDrain(t *testing.T) {
	b := &forceStopBackend{}
	m := New(b, Options{})
	m.width, m.height = 40, 16
	m.openForm(settingsScreen)
	if !strings.Contains(m.View(), "[F8] Force stop") {
		t.Fatal("force stop missing from Settings")
	}
	m, _ = serviceKey(m, "r")
	m, _ = serviceKey(m, "y")
	m, _ = serviceKey(m, "f8")
	if !strings.Contains(m.View(), "Interrupt active workers?") {
		t.Fatal("force stop confirmation is unavailable during a drain")
	}
	updated, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("y"), Paste: true})
	if cmd != nil || b.calls != 0 {
		t.Fatal("paste accepted as confirmation")
	}
	m, _ = serviceKey(updated.(Model), "n")
	if b.calls != 0 || !strings.Contains(m.View(), "RESTART PENDING") {
		t.Fatal("cancel changed the ongoing restart")
	}
	m, _ = serviceKey(m, "f8")
	m, cmd = clickTarget(t, m, "key", "y", "", 0)
	if cmd == nil {
		t.Fatal("force stop confirmation did not start the operation")
	}
	m, duplicate := serviceKey(m, "y")
	if duplicate != nil {
		t.Fatal("force stop can be submitted twice")
	}
	m = execute(m, cmd)
	if b.calls != 1 || !strings.Contains(m.View(), "Engine stopped") {
		t.Fatal("force stop completion was not shown")
	}
	model, _ := m.Update(resultMsg{kind: "restart", err: fmt.Errorf("restart incomplete: %w", backend.ErrDrainInterrupted)})
	m = model.(Model)
	if m.busy || !strings.Contains(m.View(), "Engine stopped") || m.screen != settingsScreen {
		t.Fatal("the interrupted restart hid the force stop completion")
	}
}
