package tui

import "strings"

func (m Model) formContent() layoutBlock {
	labels := []string{"Max workers", "Poll interval (milliseconds)", "Worker type", "Poller type"}
	title := "Execution settings"
	intro := "Max workers limits how many tasks run at once. Lowering it won't stop tasks already running."
	if m.screen == connectScreen {
		labels = []string{"Tzu Do server or full poll URL", "Worker API key"}
		title = "Connect with Tzu Do"
		intro = "Engine starts paused. Key stays on this machine."
		if m.options.Demo {
			intro = "Simulated setup · no network or settings writes."
		}
	}
	b := layoutBlock{lines: []string{accentStyle.Render(" " + title)}}
	b.lines = append(b.lines, strings.Split(mutedStyle.Render(textBlock(" "+intro+"\n Tab/click selects; Enter edits/finishes. Esc exits editing.", m.width-4)), "\n")...)
	b.lines = append(b.lines, "")
	focusLine := 0
	for i, input := range m.form {
		marker := "  "
		style := mutedStyle
		if i == m.field {
			marker = "> "
			style = accentStyle
			focusLine = len(b.lines)
		}
		input.Width = max(4, m.width-8)
		b.targets = append(b.targets, hitTarget{x: 0, y: len(b.lines), width: m.width - 2, height: 2, action: "field", field: i})
		label := labels[i]
		if input.Focused() {
			label += " [editing]"
		}
		b.lines = append(b.lines, style.Render(fit(marker+label, m.width-4)), " "+input.View(), "")
	}
	if m.screen == settingsScreen {
		b.lines = append(b.lines, mutedStyle.Render(" Adapters: configure in config.json, then restart. See README."))
	}
	prefix := layoutBlock{}
	if m.screen == settingsScreen {
		prefix.append(controls([]control{{"[o] Runtime updates", "o"}}, m.width-4))
		prefix.append(controls([]control{{"[r] Restart engine", "r"}}, m.width-4))
		prefix.append(controls([]control{{"[i] Install service", "i"}}, m.width-4))
		prefix.append(controls([]control{{"[u] Uninstall service", "u"}}, m.width-4))
	}
	available := max(1, m.bodyHeight()-2-len(prefix.lines))
	start := max(0, min(focusLine-1, len(b.lines)-available))
	if available < 3 {
		start = min(focusLine, len(b.lines)-available)
	}
	b.lines = b.lines[start:min(len(b.lines), start+available)]
	var targets []hitTarget
	for _, target := range b.targets {
		target.y -= start
		if target.y < 0 {
			target.height += target.y
			target.y = 0
		}
		if target.height > 0 && target.y >= 0 && target.y < available {
			target.height = min(target.height, available-target.y)
			targets = append(targets, target)
		}
	}
	b.targets = targets
	prefix.append(b)
	return prefix
}
