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
	return strings.Join([]string{accentStyle.Render("Keyboard guide"), "", bodyStyle.Render("w / p / s    Workers / Pollers / Settings"), bodyStyle.Render("m            Matrix replay; Esc / m exits"), bodyStyle.Render("c            Connect with Tzu Do"), bodyStyle.Render("Settings: r restarts engine; i installs service; u uninstalls"), bodyStyle.Render("← → / Tab    Switch worker; 1–9 select directly"), bodyStyle.Render("Enter / i    Message selected conversation"), bodyStyle.Render("Esc          Close editor; preserve its draft"), bodyStyle.Render("Alt+← / →    Switch worker while composing"), bodyStyle.Render("P            Pin / unpin worker (until engine restart)"), bodyStyle.Render("x            Request stop (y confirms, n cancels)"), bodyStyle.Render("↑ ↓ / j k    Scroll activity; PgUp/PgDn page"), bodyStyle.Render("Home / End   Initial prompt / latest activity"), bodyStyle.Render("f            Follow latest activity (or click bar)"), bodyStyle.Render("Space        Pause / resume new task intake"), bodyStyle.Render("Form: Tab selects; Enter edits/finishes; Ctrl+S saves"), bodyStyle.Render("F2           Toggle terminal text selection / mouse"), bodyStyle.Render("Ctrl+L       Redraw terminal; preserve draft"), bodyStyle.Render("q / Ctrl+C   Detach; background workers continue"), "", mutedStyle.Render(textBlock("Scrolling up holds your place as activity arrives. Each worker remembers its position. While composing, PgUp/PgDn scroll and Ctrl+Home/End open the prompt or follow latest. If the local history expires, the view moves to the oldest retained activity and says so.\n\nReplies in Tzu Do continue the conversation linked to their reply chain. Only confirmed conversation loss starts a replacement with saved context. The header shows the runtime conversation ID when available. A queued message is not a runtime receipt. A stop request is not a confirmed stop.", m.width-6)), "", mutedStyle.Render(textBlock("Mouse: click tabs, cards, buttons and form fields; wheel scrolls. Press F2 for terminal text selection; F2 again restores clicks and wheel scrolling. Use your terminal Copy/Paste shortcuts (often Ctrl+Shift+C/V; Windows Terminal also supports Ctrl+Shift+V). Ctrl+C still detaches. Paste into an active message or form editor; Enter sends a message. --no-mouse starts with selection enabled. Live output can move text while selecting.", m.width-6))}, "\n")
}
