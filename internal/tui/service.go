package tui

import (
	"context"
	"fmt"
	tea "github.com/charmbracelet/bubbletea"
	"strings"
)

// Optional local capability: remote adapters and demo mode cannot alter services.
type serviceManager interface{ ManageService(string) error }
type engineRestarter interface{ Restart(context.Context) error }

func (m Model) handleServiceKey(key string) (tea.Model, tea.Cmd) {
	if m.busy {
		return m, nil
	}
	if m.serviceConfirmation != "" {
		switch key {
		case "esc", "n":
			m.serviceConfirmation = ""
			m.screen = settingsScreen
		case "y":
			action := m.serviceConfirmation
			m.serviceConfirmation = ""
			if action == "restart" {
				restarter, ok := m.backend.(engineRestarter)
				if !ok || m.options.Demo {
					return m, nil
				}
				m.busy, m.restarting = true, true
				m.failure = ""
				m.notice = "Restarting: draining workers, then starting…"
				return m, func() tea.Msg {
					err := restarter.Restart(context.Background())
					if err != nil {
						err = fmt.Errorf("Restart incomplete; inspect engine status before retrying: %w", err)
					}
					return resultMsg{kind: "restart", text: "Engine restarted and ready. Saved intake preference restored.", err: err}
				}
			}
			manager, ok := m.backend.(serviceManager)
			if !ok || m.options.Demo {
				return m, nil
			}
			m.busy = true
			m.failure = ""
			m.notice = "Installing service: draining workers, then starting…"
			if action == "uninstall" {
				m.notice = "Draining workers and removing service…"
			}
			// Draining can take longer than ordinary API operations. Do not time it out
			// or claim cancellation while the service manager is still waiting for the workers.
			return m, func() tea.Msg {
				err := manager.ManageService(action)
				message := "Service enabled and started."
				if action == "uninstall" {
					message = "Service removed. Settings retained."
				}
				return resultMsg{kind: "service", text: message, err: err}
			}
		}
		return m, nil
	}
	switch key {
	case "esc":
		m.screen = settingsScreen
	case "r":
		if _, ok := m.backend.(engineRestarter); !ok || m.options.Demo {
			m.failure = "Engine restart requires a local live connection; unavailable in demo mode."
			return m, nil
		}
		m.screen = serviceScreen
		m.serviceConfirmation = "restart"
		m.notice, m.failure = "", ""
	case "i", "u":
		if _, ok := m.backend.(serviceManager); !ok || m.options.Demo {
			m.failure = "Service management requires the local app on macOS/launchd or Linux/systemd."
			return m, nil
		}
		m.screen = serviceScreen
		m.serviceConfirmation = "install"
		if key == "u" {
			m.serviceConfirmation = "uninstall"
		}
		m.notice, m.failure = "", ""
	}
	return m, nil
}

func (m Model) serviceContent() layoutBlock {
	b := layoutBlock{}
	add := func(text string) { b.lines = append(b.lines, strings.Split(textBlock(text, m.width-4), "\n")...) }
	if m.serviceConfirmation != "" {
		if m.serviceConfirmation == "restart" {
			add("Restart engine? Pauses intake and waits for active workers to finish. Restores saved settings; unsaved edits are kept here. Keep this app open until ready.")
		} else if m.serviceConfirmation == "install" {
			add("Install and start TMatrix service? Waits for existing TMatrix tasks to finish before starting the service. Settings changes must be saved separately.")
		} else {
			add("Uninstall TMatrix service? Waits for service workers to finish. Keeps settings and conversations. Does not stop a standalone engine.")
		}
		return b
	}
	if m.busy {
		add(m.notice)
		add("Keep this app open until the operation finishes.")
		if m.restarting {
			add(fmt.Sprintf("Active workers: %d. No forced stop or drain timeout.", m.snapshot.RunningWorkers))
		}
		return b
	}
	if _, ok := m.backend.(serviceManager); !ok || m.options.Demo {
		add("Service management is available in the local app on macOS/launchd or Linux/systemd. Demo and remote connections cannot change services.")
		return b
	}
	b.append(controls([]control{{"[i] Install service", "i"}}, m.width-4))
	b.append(controls([]control{{"[u] Uninstall service", "u"}}, m.width-4))
	add("Install: drain workers, then start; enable at login. Uninstall: drain workers; keep settings.")
	add("Guide: docs/service-cutover.md")
	return b
}
