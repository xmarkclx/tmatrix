package tui

import (
	"context"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"tmatrix/internal/backend"
)

func (m Model) openCodexUpdates() (tea.Model, tea.Cmd) {
	m.screen = codexUpdatesScreen
	m.pageOffset = 0
	m.notice, m.failure = "", ""
	return m, nil
}

func (m Model) codexUpdateAvailable() bool {
	_, capable := m.backend.(backend.CodexUpdater)
	if !capable || m.options.Demo || m.snapshot.CodexUpdate == nil {
		return false
	}
	switch m.snapshot.CodexUpdate.Status {
	case "idle", "checking", "installing", "verifying", "updated", "up_to_date", "failed":
		return true
	default:
		return false
	}
}

func (m Model) codexUpdateRunning() bool {
	if update := m.snapshot.CodexUpdate; update != nil {
		return update.Status == "checking" || update.Status == "installing" || update.Status == "verifying"
	}
	return false
}

func (m Model) handleCodexUpdateKey(key string) (tea.Model, tea.Cmd) {
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
		if !m.codexUpdateAvailable() {
			m.failure = "Codex updates are unavailable for this connection."
			return m, nil
		}
		if m.codexUpdateRunning() {
			m.notice = "Codex update already in progress. Workers continue."
			return m, nil
		}
		updater := m.backend.(backend.CodexUpdater)
		if key == "b" && m.snapshot.CodexUpdate.PreviousVersion == "" {
			m.failure = "No previous Codex version is available for rollback."
			return m, nil
		}
		m.busy, m.failure = true, ""
		m.notice = "Requesting Codex update check…"
		if key == "b" {
			m.notice = "Requesting Codex rollback…"
		}
		return m, m.operation("codex-update", "", func(ctx context.Context) (string, error) {
			if key == "b" {
				return "Rollback requested; watch status for completion. Active workers keep their version.", updater.RollbackCodexUpdate(ctx)
			}
			return "Check requested; watch status for completion. Workers continue.", updater.CheckCodexUpdate(ctx)
		})
	}
	maximum := max(0, len(m.codexUpdateDetails())-m.codexUpdateDetailHeight())
	switch key {
	case "down", "j":
		m.pageOffset++
	case "up", "k":
		m.pageOffset--
	case "pgdown":
		m.pageOffset += m.codexUpdateDetailHeight()
	case "pgup":
		m.pageOffset -= m.codexUpdateDetailHeight()
	case "home":
		m.pageOffset = 0
	case "end":
		m.pageOffset = maximum
	}
	m.pageOffset = max(0, min(maximum, m.pageOffset))
	return m, nil
}

func (m Model) codexUpdateDetailHeight() int { return max(1, m.bodyHeight()-5) }

func (m Model) codexUpdateContent() layoutBlock {
	b := layoutBlock{}
	version, status := "Unavailable", "Unavailable"
	if update := m.snapshot.CodexUpdate; update != nil {
		version = single(update.CurrentVersion)
		status = codexUpdateStatus(update.Status)
		if update.Status == "up_to_date" && update.BlockedVersion != "" && update.LatestVersion == update.BlockedVersion {
			status = "Rollback retained"
		}
	}
	b.lines = append(b.lines, accentStyle.Render("Current: "+version), bodyStyle.Render("Status: "+status))
	if m.codexUpdateAvailable() && !m.codexUpdateRunning() && !m.busy {
		items := []control{{"[c] Check now", "c"}}
		if m.snapshot.CodexUpdate.PreviousVersion != "" {
			items = append(items, control{"[b] Roll back", "b"})
		}
		b.append(controls(items, m.width-4))
	} else {
		b.lines = append(b.lines, mutedStyle.Render("Workers continue with their version."))
	}
	details := m.codexUpdateDetails()
	available := m.codexUpdateDetailHeight()
	offset := min(m.pageOffset, max(0, len(details)-available))
	b.append(layoutBlock{
		lines:   details[offset:min(len(details), offset+available)],
		targets: []hitTarget{{x: 0, y: 0, width: m.width - 4, height: available, action: "scroll"}},
	})
	return b
}

func (m Model) codexUpdateDetails() []string {
	var lines []string
	add := func(text string) {
		lines = append(lines, strings.Split(textBlock(text, m.width-4), "\n")...)
	}
	update := m.snapshot.CodexUpdate
	if update == nil {
		add("Update status unavailable. Connect to an engine that supports bundled Codex updates.")
		return lines
	}
	if update.Error != "" {
		add("Last result: " + single(update.Error))
	}
	if update.Status == "disabled" {
		add("Automatic Codex updates are disabled for this runtime.")
		return lines
	}
	if update.PreviousVersion != "" {
		add("Previous: " + single(update.PreviousVersion))
	}
	if update.LatestVersion != "" {
		add("Latest stable: " + single(update.LatestVersion))
	}
	if update.BlockedVersion != "" {
		add("Skipped after rollback: " + single(update.BlockedVersion) + ". Checks continue for newer stable releases.")
	}
	lastCheck := "Not yet checked"
	if update.LastCheckedAt != "" {
		lastCheck = codexUpdateTime(update.LastCheckedAt)
	}
	add("Last check: " + lastCheck)
	add("Next check: " + codexUpdateTime(update.NextCheckAt))
	add("Stable releases checked at startup and every 24 hours. Updates are verified before new workers use them. Active workers keep their original version.")
	if update.PreviousVersion != "" {
		add("Roll back verifies the previous version before activating it for new workers.")
	}
	return lines
}

func codexUpdateTime(value string) string {
	if value == "" {
		return "Not scheduled"
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return "Unavailable"
	}
	return parsed.Local().Format("Jan 02 15:04 MST")
}

func codexUpdateStatus(status string) string {
	switch status {
	case "idle":
		return "Ready"
	case "checking":
		return "Checking stable releases…"
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
