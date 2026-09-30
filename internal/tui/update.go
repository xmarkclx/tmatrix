package tui

import (
	"context"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

func (m Model) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := message.(type) {
	case matrixTick:
		if !m.matrix.active || msg.generation != m.matrix.generation {
			return m, nil
		}
		m.continueMatrix(msg.at)
		m.matrix.advance(msg.at, m.width, m.height)
		return m, matrixNext(m.matrix.generation)
	case tea.WindowSizeMsg:
		m.width = max(1, msg.Width)
		if m.options.Portable {
			m.width = max(1, msg.Width-1)
		}
		m.height = max(1, msg.Height)
		m.syncActivity()
		return m, tea.ClearScreen
	case tickMsg:
		m.now = time.Time(msg)
		return m, m.refresh()
	case snapshotMsg:
		m.snapshot.RestartPending = msg.snapshot.RestartPending
		m.now = time.Now()
		m.loaded = true
		if msg.err != nil {
			m.connectionError = single(msg.err.Error())
		} else {
			m.connectionError = ""
			if m.matrix.active {
				found := false
				for _, worker := range msg.snapshot.Workers {
					if worker.ID == m.matrix.workerID {
						m.matrix.ingest(worker, m.width, m.now)
						found = true
						break
					}
				}
				if !found {
					m.matrix.status = "worker no longer active"
					m.matrix.finished = true
				}
			}
			m.snapshot = msg.snapshot
			// Older engines may still return finished workers.
			m.snapshot.Workers = nil
			active := make(map[string]bool)
			for _, worker := range msg.snapshot.Workers {
				if worker.Pinned || worker.Status == "running" || worker.Status == "stopping" || worker.Status == "stop_unverified" {
					m.snapshot.Workers = append(m.snapshot.Workers, worker)
					active[worker.ID] = true
				}
			}
			if worker := m.worker(); worker == nil || worker.Status != "running" {
				m.composing = false
				m.composer.Blur()
				m.composer.SetValue("")
				m.confirmation = ""
			}
			for id := range m.drafts {
				if !active[id] {
					delete(m.drafts, id)
				}
			}
			if m.worker() == nil {
				m.selectWorker(0)
			}
			m.syncActivity()
		}
		return m, nextRefresh()
	case resultMsg:
		m.busy = false
		if msg.kind == "service" || msg.kind == "restart" {
			m.restarting = false
			m.screen = settingsScreen
		}
		if msg.err != nil {
			m.failure = single(msg.err.Error())
			m.notice = ""
			return m, nil
		}
		m.failure = ""
		m.notice = msg.text
		switch msg.kind {
		case "pin":
			return m, m.refresh()
		case "steer":
			delete(m.drafts, msg.workerID)
			if m.selected == msg.workerID {
				m.composer.SetValue("")
				m.composing = false
				m.composer.Blur()
			}
		case "connect":
			if len(m.form) > 1 {
				m.form[1].SetValue("")
			}
			m.form = nil
			m.screen = pollersScreen
		case "settings":
			m.form = nil
			m.screen = workersScreen
		}
		return m, nil
	case tea.MouseMsg:
		if m.mouseDisabled || m.matrix.active {
			return m, nil
		}
		return m.handleMouse(msg)
	case tea.KeyMsg:
		if !msg.Paste && msg.String() == "ctrl+l" {
			return m, tea.ClearScreen
		}
		return m.handleKey(msg)
	}
	var cmd tea.Cmd
	if m.composing {
		m.composer, cmd = updateComposer(m.composer, message)
	} else if (m.screen == settingsScreen || m.screen == connectScreen) && len(m.form) > 0 {
		m.form[m.field], cmd = m.form[m.field].Update(message)
	}
	return m, cmd
}
func (m Model) handleKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	// Bracketed paste is data, never a navigation or confirmation shortcut.
	if key.Paste {
		var cmd tea.Cmd
		if m.busy || m.confirmation != "" {
			return m, nil
		}
		if m.composing {
			m.composer, cmd = updateComposer(m.composer, key)
			m.drafts[m.selected] = m.composer.Value()
		} else if (m.screen == settingsScreen || m.screen == connectScreen) && len(m.form) > 0 && m.form[m.field].Focused() {
			m.form[m.field], cmd = m.form[m.field].Update(key)
		}
		return m, cmd
	}
	name := key.String()
	if m.matrix.active {
		switch name {
		case "esc", "m":
			m.matrix = matrixPlayback{generation: m.matrix.generation}
			return m, tea.ClearScreen
		case "q", "ctrl+c":
			return m, tea.Quit
		}
		return m, nil
	}
	if name == "f2" {
		m.mouseDisabled = !m.mouseDisabled
		if m.mouseDisabled {
			m.notice = "Select text with the mouse; use terminal Copy/Paste. F2 restores mouse navigation."
			return m, tea.DisableMouse
		}
		m.notice = "Mouse navigation on. F2 enables terminal text selection."
		return m, tea.EnableMouseCellMotion
	}
	if name == "ctrl+c" {
		if m.restarting {
			return m, nil
		}
		return m, tea.Quit
	}
	if m.screen == serviceScreen {
		return m.handleServiceKey(name)
	}
	if m.confirmation != "" {
		switch name {
		case "esc", "n":
			m.confirmation = ""
		case "y":
			id := m.confirmation
			m.confirmation = ""
			m.busy = true
			m.failure = ""
			m.notice = "Sending stop request…"
			return m, m.operation("stop", id, func(ctx context.Context) (string, error) {
				return "Stop request submitted. Watch runtime status for confirmation.", m.backend.Stop(ctx, id)
			})
		}
		return m, nil
	}
	if m.composing {
		switch name {
		case "ctrl+home":
			m.showInitialPrompt()
			return m, nil
		case "ctrl+end":
			m.followLatest()
			return m, nil
		case "pgup", "pgdown", "ctrl+u", "ctrl+d":
			m.scrollActivity(key)
			return m, nil
		case "alt+left", "alt+right":
			if m.busy {
				return m, nil
			}
			step := 1
			if name == "alt+left" {
				step = -1
			}
			m.selectWorker(m.selectedIndex() + step)
			return m, nil
		case "esc":
			m.drafts[m.selected] = m.composer.Value()
			m.composing = false
			m.composer.Blur()
			return m, nil
		case "enter":
			text := strings.TrimSpace(m.composer.Value())
			if text == "" || m.busy {
				return m, nil
			}
			id := m.selected
			m.drafts[id] = m.composer.Value()
			m.busy = true
			m.failure = ""
			m.notice = "Sending message…"
			return m, m.operation("steer", id, func(ctx context.Context) (string, error) {
				steering, err := m.backend.Steer(ctx, id, text)
				if err != nil {
					return "", err
				}
				if steering.Status == "queued" {
					return "Message queued; follow runtime delivery in activity.", nil
				}
				return steeringLabel(steering.Status), nil
			})
		}
		if m.busy {
			return m, nil
		}
		var cmd tea.Cmd
		m.composer, cmd = updateComposer(m.composer, key)
		m.drafts[m.selected] = m.composer.Value()
		return m, cmd
	}
	if m.screen == settingsScreen || m.screen == connectScreen {
		switch name {
		case "esc":
			if !m.busy {
				if m.form[m.field].Focused() {
					m.form[m.field].Blur()
					return m, nil
				}
				m.form = nil
				m.screen = workersScreen
				m.failure = ""
			}
			return m, nil
		case "tab", "down":
			if !m.busy {
				return m, m.focusField(m.field + 1)
			}
			return m, nil
		case "shift+tab", "up":
			if !m.busy {
				return m, m.focusField(m.field - 1)
			}
			return m, nil
		case "ctrl+s":
			return m, m.submitForm()
		case "enter":
			if m.busy {
				return m, nil
			}
			if m.form[m.field].Focused() {
				m.form[m.field].Blur()
				return m, nil
			}
			return m, m.form[m.field].Focus()
		}
		if m.busy {
			return m, nil
		}
		if !m.form[m.field].Focused() {
			if m.screen == settingsScreen && (name == "i" || name == "u" || name == "r") {
				return m.handleServiceKey(name)
			}
			_, cmd := m.navigateForm(name)
			return m, cmd
		}
		var cmd tea.Cmd
		m.form[m.field], cmd = m.form[m.field].Update(key)
		return m, cmd
	}
	switch name {
	case "q":
		return m, tea.Quit
	case "w", "esc":
		m.pageOffset = 0
		m.screen = workersScreen
	case "p":
		m.pageOffset = 0
		m.screen = pollersScreen
	case "s":
		return m, m.openForm(settingsScreen)
	case "c":
		return m, m.openForm(connectScreen)
	case "?":
		m.pageOffset = 0
		if m.screen == helpScreen {
			m.screen = workersScreen
		} else {
			m.screen = helpScreen
		}
	case " ":
		if m.screen == workersScreen || m.screen == pollersScreen {
			return m, m.toggleIntake()
		}
	}
	if m.screen != workersScreen {
		if m.screen == helpScreen || m.screen == pollersScreen {
			content := m.helpView()
			if m.screen == pollersScreen {
				content = m.pollersView()
			}
			maximum := max(0, len(strings.Split(content, "\n"))-max(1, m.bodyHeight()-2))
			switch name {
			case "down", "j":
				m.pageOffset++
			case "up", "k":
				m.pageOffset--
			case "pgdown":
				m.pageOffset += max(1, m.bodyHeight()-3)
			case "pgup":
				m.pageOffset -= max(1, m.bodyHeight()-3)
			case "home":
				m.pageOffset = 0
			case "end":
				m.pageOffset = maximum
			}
			m.pageOffset = max(0, min(maximum, m.pageOffset))
		}
		return m, nil
	}
	switch name {
	case "P":
		if worker := m.worker(); worker != nil && !m.busy {
			id, pinned := worker.ID, !worker.Pinned
			m.busy = true
			m.failure = ""
			m.notice = "Updating worker pin…"
			return m, m.operation("pin", id, func(ctx context.Context) (string, error) {
				label := "Worker unpinned; normal removal checks apply."
				if pinned {
					label = "Worker pinned; kept until unpinned or engine restart."
				}
				return label, m.backend.Pin(ctx, id, pinned)
			})
		}
	case "m":
		return m, m.enterMatrix()
	case "right", "tab", "l":
		m.selectWorker(m.selectedIndex() + 1)
	case "left", "shift+tab", "h":
		m.selectWorker(m.selectedIndex() - 1)
	case "1", "2", "3", "4", "5", "6", "7", "8", "9":
		index := int(name[0] - '1')
		if index < len(m.snapshot.Workers) {
			m.selectWorker(index)
		}
	case "enter", "i":
		if m.worker() != nil && m.worker().Status != "running" {
			m.failure = "Only running workers accept in-app messages."
			return m, nil
		}
		if m.worker() != nil && !m.busy {
			m.composing = true
			m.composer.SetValue(m.drafts[m.selected])
			m.failure = ""
			return m, m.composer.Focus()
		}
	case "x":
		if worker := m.worker(); worker != nil && !m.busy && worker.Status == "running" {
			m.confirmation = worker.ID
		}
	case "f", "end", "G":
		m.followLatest()
	case "home", "g":
		m.showInitialPrompt()
	case "up", "down", "k", "j", "pgup", "pgdown", "ctrl+u", "ctrl+d":
		m.scrollActivity(key)
		return m, nil
	}
	return m, nil
}
func steeringLabel(status string) string {
	switch status {
	case "received", "runtime_received", "delivered":
		return "Message received by runtime. Waiting for a visible response."
	case "responded", "response_observed":
		return "Message response observed."
	case "queued":
		return "Message queued for this conversation's next turn; not yet received by runtime."
	case "failed":
		return "Message delivery failed; no runtime receipt is confirmed."
	default:
		return "Message status unavailable; no delivery confirmation."
	}
}
