package tui

import (
	"context"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

type engineForceStopper interface {
	CanForceStop() bool
	ForceStop(context.Context) error
}

type forceStopPhase uint8

const (
	forceStopClosed forceStopPhase = iota
	forceStopConfirm
	forceStopRunning
	forceStopSettling
)

func (p forceStopPhase) modal() bool { return p == forceStopConfirm || p == forceStopRunning }

type forceStopMsg struct{ err error }

func (m Model) forceStopAvailable() bool {
	stopper, local := m.backend.(engineForceStopper)
	return local && !m.options.Demo && stopper.CanForceStop()
}

func (m Model) handleForceStopKey(key string) (tea.Model, tea.Cmd) {
	switch m.forceStop {
	case forceStopClosed, forceStopSettling:
		m.forceStop = forceStopConfirm
	case forceStopConfirm:
		switch key {
		case "n", "esc":
			m.forceStop = forceStopClosed
		case "y":
			m.forceStop = forceStopRunning
			m.failure = ""
			m.notice = ""
			stopper := m.backend.(engineForceStopper)
			return m, func() tea.Msg {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				return forceStopMsg{err: stopper.ForceStop(ctx)}
			}
		}
	}
	return m, nil
}

func (m Model) forceStopContent() layoutBlock {
	message := "Force stopping the engine…"
	if m.forceStop == forceStopConfirm {
		message = "Interrupt active workers? Force stop ends the running engine immediately. Restart from Settings to recover unfinished tasks."
	}
	return layoutBlock{lines: strings.Split(textBlock(message, m.width-4), "\n")}
}
