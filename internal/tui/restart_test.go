package tui

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

type fakeRestarter struct {
	fakeBackend
	calls int
}

func (b *fakeRestarter) Restart(ctx context.Context) error {
	if _, bounded := ctx.Deadline(); bounded {
		return errors.New("drain must not time out")
	}
	b.calls++
	return b.err
}

func TestRestartControls(t *testing.T) {
	for _, width := range []int{40, 60, 100} {
		b := &fakeRestarter{}
		m := New(b, Options{})
		m.width, m.height = width, 16
		m.openForm(settingsScreen)
		m.form[0].SetValue("7")
		if !strings.Contains(m.View(), "Restart engine") {
			t.Fatal("restart missing from Settings")
		}
		m, _ = clickTarget(t, m, "key", "r", "", 0)
		if m.serviceConfirmation != "restart" || b.calls != 0 {
			t.Fatal("missing confirmation")
		}
		if !strings.Contains(m.View(), "Restart engine?") {
			t.Fatal("confirmation invisible")
		}
		m, _ = serviceKey(m, "n")
		if m.screen != settingsScreen || m.form[0].Value() != "7" {
			t.Fatal("cancel lost draft")
		}
		m, _ = serviceKey(m, "r")
		pasted, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("y"), Paste: true})
		m = pasted.(Model)
		if cmd != nil || m.serviceConfirmation != "restart" {
			t.Fatal("paste confirmed restart")
		}
		m, cmd = serviceKey(m, "y")
		if cmd == nil || !m.busy || !m.restarting {
			t.Fatal("restart not pending")
		}
		for _, key := range []string{"r", "y", "esc", "q", "ctrl+c"} {
			_, duplicate := serviceKey(m, key)
			if duplicate != nil {
				t.Fatalf("pending restart allows %s", key)
			}
		}
		m = execute(m, cmd)
		if b.calls != 1 || m.busy || m.restarting || m.failure != "" || !strings.Contains(m.notice, "ready") || m.form[0].Value() != "7" {
			t.Fatal("restart completion failed")
		}
	}
}

func TestRestartErrorsDemoAndEditing(t *testing.T) {
	b := &fakeRestarter{fakeBackend: fakeBackend{err: errors.New("engine unavailable")}}
	m := New(b, Options{})
	m.openForm(settingsScreen)
	m, _ = serviceKey(m, "enter")
	before := m.form[0].Value()
	m, _ = serviceKey(m, "r")
	if m.form[0].Value() != before+"r" || m.serviceConfirmation != "" {
		t.Fatal("restart intercepted editing")
	}
	m, _ = clickTarget(t, m, "key", "r", "", 0)
	m, cmd := serviceKey(m, "y")
	m = execute(m, cmd)
	if m.restarting || m.busy || !strings.Contains(m.failure, "engine unavailable") {
		t.Fatal("restart failure hidden")
	}
	m.options.Demo = true
	m, cmd = serviceKey(m, "r")
	if cmd != nil || m.serviceConfirmation != "" || b.calls != 1 {
		t.Fatal("demo restarted engine")
	}
	m = New(&fakeBackend{}, Options{})
	m.openForm(settingsScreen)
	m, cmd = serviceKey(m, "r")
	if cmd != nil || m.serviceConfirmation != "" || m.failure == "" {
		t.Fatal("unsupported backend accepted restart")
	}
}

func TestHeaderShowsSharedRestartDuringDrainAndReconnect(t *testing.T) {
	for _, width := range []int{40, 100} {
		m, b := testModel()
		m.width = width
		b.snapshot.IntakePaused = false
		b.snapshot.RestartPending = true
		updated, _ := m.Update(snapshotMsg{snapshot: b.snapshot})
		m = updated.(Model)
		if !strings.Contains(m.View(), "RESTART PENDING") || strings.Contains(m.View(), "Accepting New Tasks") {
			t.Fatal("pending restart hidden by intake status")
		}
		updated, _ = m.Update(snapshotMsg{snapshot: b.snapshot, err: fmt.Errorf("reconnecting")})
		m = updated.(Model)
		if !strings.Contains(m.View(), "RESTART PENDING") {
			t.Fatal("restart lost during reconnect")
		}
		b.snapshot.RestartPending = false
		b.snapshot.Poller.Status = "stopped"
		updated, _ = m.Update(snapshotMsg{snapshot: b.snapshot})
		m = updated.(Model)
		if strings.Contains(m.View(), "RESTART PENDING") || strings.Contains(m.View(), "Accepting New Tasks") {
			t.Fatal("stopped engine status misleading")
		}
	}
}
