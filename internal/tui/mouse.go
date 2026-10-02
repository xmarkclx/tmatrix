package tui

import tea "github.com/charmbracelet/bubbletea"

// Targets are built with the visible layout, in terminal cell coordinates.
// This keeps clicks aligned after wrapping, resizing, or wide emoji titles.
type hitTarget struct {
	x, y, width, height int
	action              string
	key                 string
	workerID            string
	field               int
}

func (h hitTarget) contains(x, y int) bool {
	return x >= h.x && x < h.x+h.width && y >= h.y && y < h.y+h.height
}

func (m Model) handleMouse(msg tea.MouseMsg) (tea.Model, tea.Cmd) {
	if msg.Action != tea.MouseActionPress {
		return m, nil
	}
	wheel := msg.Button == tea.MouseButtonWheelUp || msg.Button == tea.MouseButtonWheelDown
	if !wheel && msg.Button != tea.MouseButtonLeft {
		return m, nil
	}
	_, targets := m.renderLayout()
	for i := len(targets) - 1; i >= 0; i-- {
		target := targets[i]
		if !target.contains(msg.X, msg.Y) || (wheel && target.action != "scroll") {
			continue
		}
		if wheel {
			return m.scrollMouse(msg)
		}
		return m.activateTarget(target)
	}
	return m, nil
}

func (m Model) activateTarget(target hitTarget) (tea.Model, tea.Cmd) {
	if m.busy {
		return m, nil
	}
	// Confirmations cannot click through into another view.
	if m.confirmation != "" {
		if target.action == "key" && (target.key == "y" || target.key == "n" || target.key == "esc") {
			return m.handleKey(mouseKey(target.key))
		}
		return m, nil
	}
	if m.screen == connectScreen || m.screen == settingsScreen {
		switch target.action {
		case "field":
			if target.field >= 0 && target.field < len(m.form) {
				return m, m.focusField(target.field)
			}
		case "key":
			if handled, cmd := m.navigateForm(target.key); handled {
				return m, cmd
			}
			if m.screen == settingsScreen && target.key == "o" {
				m.form[m.field].Blur()
				return m.openAdapterUpdates()
			}
			if m.screen == settingsScreen && (target.key == "i" || target.key == "u" || target.key == "r") {
				m.form[m.field].Blur()
				return m.handleServiceKey(target.key)
			}
			if target.key == "ctrl+s" || target.key == "esc" || target.key == "enter" {
				return m.handleKey(mouseKey(target.key))
			}
		}
		return m, nil
	}
	if target.action == "worker" && m.screen == workersScreen {
		for index, worker := range m.snapshot.Workers {
			if worker.ID == target.workerID {
				m.selectWorker(index)
				break
			}
		}
		return m, nil
	}
	if target.action == "composer" && m.screen == workersScreen {
		if m.composing {
			return m, m.composer.Focus()
		}
		return m.handleKey(mouseKey("enter"))
	}
	if target.action != "key" {
		return m, nil
	}
	if m.composing {
		switch target.key {
		case "left", "right":
			key := mouseKey(target.key)
			key.Alt = true
			return m.handleKey(key)
		case "enter", "esc":
			return m.handleKey(mouseKey(target.key))
		case "f":
			m.followLatest()
		case "home":
			m.showInitialPrompt()
		}
		return m, nil
	}
	return m.handleKey(mouseKey(target.key))
}

func (m Model) scrollMouse(msg tea.MouseMsg) (tea.Model, tea.Cmd) {
	if m.confirmation != "" || m.screen == settingsScreen || m.screen == connectScreen {
		return m, nil
	}
	if m.screen == workersScreen {
		m.scrollActivity(msg)
		return m, nil
	}
	if m.screen == helpScreen || m.screen == pollersScreen || m.screen == adapterUpdatesScreen {
		key := "down"
		if msg.Button == tea.MouseButtonWheelUp {
			key = "up"
		}
		for range 3 {
			next, _ := m.handleKey(mouseKey(key))
			m = next.(Model)
		}
	}
	return m, nil
}

func mouseKey(name string) tea.KeyMsg {
	special := map[string]tea.KeyType{
		"f2": tea.KeyF2, "enter": tea.KeyEnter, "esc": tea.KeyEsc, "ctrl+s": tea.KeyCtrlS,
		"left": tea.KeyLeft, "right": tea.KeyRight,
		"up": tea.KeyUp, "down": tea.KeyDown,
	}
	if key, ok := special[name]; ok {
		return tea.KeyMsg{Type: key}
	}
	return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(name)}
}
