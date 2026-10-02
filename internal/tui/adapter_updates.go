package tui

import (
	"context"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"tmatrix/internal/backend"
)

func (m Model) openAdapterUpdates() (tea.Model, tea.Cmd) {
	m.screen = adapterUpdatesScreen
	m.pageOffset = 0
	m.notice, m.failure = "", ""
	return m, nil
}

func (m Model) adapterUpdateAvailable() bool {
	_, capable := m.backend.(backend.AdapterUpdater)
	if !capable || m.options.Demo || m.snapshot.AdapterUpdate == nil {
		return false
	}
	switch m.snapshot.AdapterUpdate.Status {
	case "idle", "checking", "installing", "verifying", "updated", "up_to_date", "failed":
		return true
	default:
		return false
	}
}

func (m Model) adapterUpdateRunning() bool {
	if update := m.snapshot.AdapterUpdate; update != nil {
		return update.Status == "checking" || update.Status == "installing" || update.Status == "verifying"
	}
	return false
}

func (m Model) handleAdapterUpdateKey(key string) (tea.Model, tea.Cmd) {
	if m.busy {
		return m, nil
	}
	switch key {
	case "esc", "s":
		m.screen, m.pageOffset = settingsScreen, 0
		return m, nil
	case "w", "p", "?":
		_, cmd := m.navigateForm(key)
		return m, cmd
	case "q":
		return m, tea.Quit
	case "c", "b":
		if !m.adapterUpdateAvailable() {
			m.failure = "Runtime updates are unavailable for this connection."
			return m, nil
		}
		if m.adapterUpdateRunning() {
			m.notice = "Runtime update already in progress. Workers continue."
			return m, nil
		}
		updater := m.backend.(backend.AdapterUpdater)
		if key == "b" && !m.snapshot.AdapterUpdate.CanRollback {
			m.failure = "Rollback is unavailable for this runtime."
			return m, nil
		}
		m.busy, m.failure = true, ""
		m.notice = "Requesting runtime update check…"
		if key == "b" {
			m.notice = "Requesting runtime rollback…"
		}
		return m, m.operation("adapter-update", "", func(ctx context.Context) (string, error) {
			if key == "b" {
				return "Rollback requested; watch status for completion. Active workers keep their version.", updater.RollbackAdapterUpdate(ctx)
			}
			return "Check requested; watch status for completion. Workers continue.", updater.CheckAdapterUpdate(ctx)
		})
	}
	maximum := max(0, len(m.adapterUpdateDetails())-m.adapterUpdateDetailHeight())
	switch key {
	case "down", "j":
		m.pageOffset++
	case "up", "k":
		m.pageOffset--
	case "pgdown":
		m.pageOffset += m.adapterUpdateDetailHeight()
	case "pgup":
		m.pageOffset -= m.adapterUpdateDetailHeight()
	case "home":
		m.pageOffset = 0
	case "end":
		m.pageOffset = maximum
	}
	m.pageOffset = max(0, min(maximum, m.pageOffset))
	return m, nil
}

func (m Model) adapterUpdateDetailHeight() int { return max(1, m.bodyHeight()-5) }

func (m Model) adapterUpdateContent() layoutBlock {
	b := layoutBlock{}
	version, status := "Unavailable", "Unavailable"
	if update := m.snapshot.AdapterUpdate; update != nil {
		version = single(update.CurrentVersion)
		status = adapterUpdateStatus(update.Status)
		if update.Status == "up_to_date" && update.BlockedVersion != "" && update.LatestVersion == update.BlockedVersion {
			status = "Rollback retained"
		}
	}
	b.lines = append(b.lines, accentStyle.Render("Current: "+version), bodyStyle.Render("Status: "+status))
	if m.adapterUpdateAvailable() && !m.adapterUpdateRunning() && !m.busy {
		items := []control{{"[c] Check now", "c"}}
		if m.snapshot.AdapterUpdate.CanRollback {
			items = append(items, control{"[b] Roll back", "b"})
		}
		b.append(controls(items, m.width-4))
	} else {
		b.lines = append(b.lines, mutedStyle.Render("Workers continue with their version."))
	}
	details := m.adapterUpdateDetails()
	available := m.adapterUpdateDetailHeight()
	offset := min(m.pageOffset, max(0, len(details)-available))
	b.append(layoutBlock{
		lines:   details[offset:min(len(details), offset+available)],
		targets: []hitTarget{{x: 0, y: 0, width: m.width - 4, height: available, action: "scroll"}},
	})
	return b
}

func (m Model) adapterUpdateDetails() []string {
	var lines []string
	add := func(text string) {
		lines = append(lines, strings.Split(textBlock(text, m.width-4), "\n")...)
	}
	update := m.snapshot.AdapterUpdate
	if update == nil {
		add("Update status unavailable. The connected engine and its runtime adapter must support updates.")
		return lines
	}
	if update.Error != "" {
		add("Last result: " + single(update.Error))
	}
	if update.Status == "disabled" {
		add("Automatic updates are disabled for this runtime.")
		return lines
	}
	if update.PreviousVersion != "" {
		add("Previous: " + single(update.PreviousVersion))
	}
	if update.LatestVersion != "" {
		add("Latest: " + single(update.LatestVersion))
	}
	if update.BlockedVersion != "" {
		add("Skipped after rollback: " + single(update.BlockedVersion) + ". Checks continue for newer releases.")
	}
	lastCheck := "Not yet checked"
	if update.LastCheckedAt != "" {
		lastCheck = adapterUpdateTime(update.LastCheckedAt)
	}
	add("Last check: " + lastCheck)
	add("Next check: " + adapterUpdateTime(update.NextCheckAt))
	add("The runtime adapter manages update checks, installation and verification. Active workers keep their original version.")
	if update.CanRollback {
		add("The runtime adapter verifies rollback before activating it for new workers.")
	}
	return lines
}

func adapterUpdateTime(value string) string {
	if value == "" {
		return "Not scheduled"
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return "Unavailable"
	}
	return parsed.Local().Format("Jan 02 15:04 MST")
}

func adapterUpdateStatus(status string) string {
	switch status {
	case "idle":
		return "Ready"
	case "checking":
		return "Checking releases…"
	case "installing":
		return "Installing candidate…"
	case "verifying":
		return "Verifying candidate…"
	case "updated":
		return "Activated for new workers"
	case "up_to_date":
		return "Up to date"
	case "failed":
		return "Failed; current version kept"
	case "disabled":
		return "Disabled"
	default:
		return "Unavailable"
	}
}
