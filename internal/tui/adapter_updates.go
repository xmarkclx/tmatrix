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

func (m Model) selectedRuntimeUpdate() *backend.AdapterUpdate {
	for i, entry := range m.snapshot.AdapterUpdates {
		if entry.AdapterID == m.updateAdapterID {
			return &m.snapshot.AdapterUpdates[i]
		}
	}
	if len(m.snapshot.AdapterUpdates) > 0 {
		return &m.snapshot.AdapterUpdates[0]
	}
	return m.snapshot.AdapterUpdate
}

func (m *Model) cycleRuntimeUpdate(direction int) {
	entries := m.snapshot.AdapterUpdates
	if len(entries) < 2 {
		return
	}
	for i, entry := range entries {
		if entry.AdapterID == m.selectedRuntimeUpdate().AdapterID {
			m.updateAdapterID = entries[(i+direction+len(entries))%len(entries)].AdapterID
			break
		}
	}
	m.pageOffset, m.notice, m.failure = 0, "", ""
}

func (m Model) adapterUpdateActions() (check, rollback func(context.Context) error) {
	if len(m.snapshot.AdapterUpdates) > 0 {
		if updater, ok := m.backend.(backend.RuntimeUpdater); ok {
			id := m.selectedRuntimeUpdate().AdapterID
			return func(ctx context.Context) error { return updater.CheckRuntimeUpdate(ctx, id) },
				func(ctx context.Context) error { return updater.RollbackRuntimeUpdate(ctx, id) }
		}
	} else if updater, ok := m.backend.(backend.AdapterUpdater); ok {
		return updater.CheckAdapterUpdate, updater.RollbackAdapterUpdate
	}
	return nil, nil
}

func (m Model) adapterUpdateAvailable() bool {
	check, _ := m.adapterUpdateActions()
	update := m.selectedRuntimeUpdate()
	if check == nil || m.options.Demo || update == nil {
		return false
	}
	switch update.Status {
	case "idle", "checking", "installing", "verifying", "updated", "up_to_date", "failed":
		return true
	default:
		return false
	}
}

func (m Model) adapterUpdateRunning() bool {
	if update := m.selectedRuntimeUpdate(); update != nil {
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
	case "left":
		m.cycleRuntimeUpdate(-1)
		return m, nil
	case "right":
		m.cycleRuntimeUpdate(1)
		return m, nil
	case "c", "b":
		if !m.adapterUpdateAvailable() {
			m.failure = "Runtime updates are unavailable for this connection."
			return m, nil
		}
		if m.adapterUpdateRunning() {
			m.notice = "Runtime update already in progress. Workers continue."
			return m, nil
		}
		check, rollback := m.adapterUpdateActions()
		if key == "b" && !m.selectedRuntimeUpdate().CanRollback {
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
				return "Rollback requested; watch status for completion. Active workers keep their version.", rollback(ctx)
			}
			return "Check requested; watch status for completion. Workers continue.", check(ctx)
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

func (m Model) adapterUpdateDetailHeight() int {
	height := m.bodyHeight() - 5
	if len(m.snapshot.AdapterUpdates) > 1 {
		height--
	}
	return max(1, height)
}

func (m Model) adapterUpdateContent() layoutBlock {
	b := layoutBlock{}
	version, status := "Unavailable", "Unavailable"
	if update := m.selectedRuntimeUpdate(); update != nil {
		version = single(update.CurrentVersion)
		status = adapterUpdateStatus(update.Status)
		if update.Status == "up_to_date" && update.BlockedVersion != "" && update.LatestVersion == update.BlockedVersion {
			status = "Rollback retained"
		}
	}
	if len(m.snapshot.AdapterUpdates) > 1 {
		b.append(controls([]control{{"[←/→] Switch runtime", "right"}}, m.width-4))
	}
	b.lines = append(b.lines, accentStyle.Render("Current: "+version), bodyStyle.Render("Status: "+status))
	if m.adapterUpdateAvailable() && !m.adapterUpdateRunning() && !m.busy {
		items := []control{{"[c] Check now", "c"}}
		if m.selectedRuntimeUpdate().CanRollback {
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
	update := m.selectedRuntimeUpdate()
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
