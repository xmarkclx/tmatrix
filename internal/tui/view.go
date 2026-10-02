package tui

import (
	"fmt"
	"strings"
)

func (m Model) pollersView() string {
	poller := m.snapshot.Poller
	state := single(poller.Status)
	if state == "" {
		state = "not connected"
	}
	intake := "Accepting work"
	if m.snapshot.IntakePaused {
		intake = "Paused · active workers continue"
	}
	lines := []string{accentStyle.Render("Tzu Do  /  included poller"), "", bodyStyle.Render("Status       " + state), bodyStyle.Render("Server       " + single(poller.URL)), bodyStyle.Render("Intake       " + intake), bodyStyle.Render(fmt.Sprintf("Interval     %d ms", m.snapshot.PollIntervalMS)), bodyStyle.Render("Last poll    " + single(poller.LastPollAt)), ""}
	if poller.Error != "" {
		lines = append(lines, errorStyle.Render(textBlock(poller.Error, m.width-6)), "")
	}
	lines = append(lines, textBlock("The poller finds eligible tasks. Available slots run them with the configured worker type. Pausing intake leaves active work running.", m.width-6), "", mutedStyle.Render("Additional poller types can be added through the engine adapter."))
	return strings.Join(lines, "\n")
}
func (m Model) helpView() string {
	return strings.Join([]string{accentStyle.Render("Keyboard guide"), "", bodyStyle.Render("w / p / s    Workers / Pollers / Settings"), bodyStyle.Render("m            Matrix replay; Esc / m exits"), bodyStyle.Render("c            Connect with Tzu Do"), bodyStyle.Render("Settings: o Runtime updates; r restarts engine"), bodyStyle.Render("Settings: i installs service; u uninstalls"), bodyStyle.Render("← → / Tab    Switch worker; 1–9 select directly"), bodyStyle.Render("Enter / i    Message selected conversation"), bodyStyle.Render("Esc          Close editor; preserve its draft"), bodyStyle.Render("Alt+← / →    Switch worker while composing"), bodyStyle.Render("P            Pin / unpin worker (until engine restart)"), bodyStyle.Render("x            Request stop (y confirms, n cancels)"), bodyStyle.Render("↑ ↓ / j k    Scroll activity; PgUp/PgDn page"), bodyStyle.Render("Home / End   Initial prompt / latest activity"), bodyStyle.Render("f            Follow latest activity (or click bar)"), bodyStyle.Render("Space        Pause / resume new task intake"), bodyStyle.Render("Form: Tab selects; Enter edits/finishes; Ctrl+S saves"), bodyStyle.Render("F2           Toggle terminal text selection / mouse"), bodyStyle.Render("Ctrl+L       Redraw terminal; preserve draft"), bodyStyle.Render("q / Ctrl+C   Detach; background workers continue")}, "\n")
}
