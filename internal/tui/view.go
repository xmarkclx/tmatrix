package tui

import (
	"fmt"
	"strings"
)

func (m Model) pollersView() string {
	lines := []string{accentStyle.Render("Sources"), ""}
	if len(m.snapshot.Pollers) == 0 {
		return strings.Join(append(lines, "No sources connected. Press c to add one."), "\n")
	}
	for i, source := range m.snapshot.Pollers {
		marker := "  "
		if i == m.sourceIndex() {
			marker = "> "
		}
		lines = append(lines, bodyStyle.Render(fmt.Sprintf("%s%s  [%s]", marker, single(source.Name), single(source.Status))))
	}
	source := m.source()
	intake := "Accepting work"
	if m.snapshot.IntakePaused {
		intake = "Paused; active workers continue"
	}
	lines = append(lines, "", bodyStyle.Render("Server       "+single(source.URL)), bodyStyle.Render("Source ID    "+single(source.ID)), bodyStyle.Render("Intake       "+intake), bodyStyle.Render(fmt.Sprintf("Interval     %d ms", m.snapshot.PollIntervalMS)), bodyStyle.Render("Last poll    "+single(source.LastPollAt)))
	if source.ReservedSlots > 0 {
		lines = append(lines, warningStyle.Render(fmt.Sprintf("Reserved     %d slots awaiting a poll reply", source.ReservedSlots)))
	}
	if source.Error != "" {
		lines = append(lines, "", errorStyle.Render(textBlock(source.Error, m.width-6)))
	}
	return strings.Join(lines, "\n")
}

func (m Model) helpView() string {
	return strings.Join([]string{accentStyle.Render("Keyboard guide"), "", bodyStyle.Render("w / p / s    Workers / Pollers / Settings"), bodyStyle.Render("m            Matrix replay; Esc / m exits"), bodyStyle.Render("c            Add a source"), bodyStyle.Render("Settings: o Runtime updates; r restarts engine"), bodyStyle.Render("Settings: i installs service; u uninstalls"), bodyStyle.Render("← → / Tab    Switch worker; 1–9 select directly"), bodyStyle.Render("Enter / i    Message selected conversation"), bodyStyle.Render("Esc          Close editor; preserve its draft"), bodyStyle.Render("Alt+← / →    Switch worker while composing"), bodyStyle.Render("P            Pin / unpin worker (until engine restart)"), bodyStyle.Render("x            Request stop (y confirms, n cancels)"), bodyStyle.Render("↑ ↓ / j k    Scroll activity; PgUp/PgDn page"), bodyStyle.Render("Home / End   Initial prompt / latest activity"), bodyStyle.Render("f            Follow latest activity (or click bar)"), bodyStyle.Render("Space        Pause / resume new task intake"), bodyStyle.Render("Form: Tab selects; Enter edits/finishes; Ctrl+S saves"), bodyStyle.Render("F2           Toggle terminal text selection / mouse"), bodyStyle.Render("Ctrl+L       Redraw terminal; preserve draft"), bodyStyle.Render("q / Ctrl+C   Detach; background workers continue")}, "\n")
}
