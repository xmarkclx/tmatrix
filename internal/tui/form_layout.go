package tui

import "strings"

func (m Model) formContent() layoutBlock {
	labels := []string{"Max workers", "Poll interval (milliseconds)", "Worker type", "Poller type"}
	title := "Execution settings"
	intro := "Max workers limits how many tasks run at once. Lowering it won't stop tasks already running."
	if m.screen == connectScreen {
		labels = []string{"Source name", "Server or full poll URL", "Worker API key"}
		title = "Add source"
		intro = "Adds a source while existing workers keep running. Key stays on this machine."
		if m.editingSource != "" {
			title = "Edit source"
			intro = "Saves after active workers finish. Key stays on this machine."
		}
		if m.options.Demo {
			intro = "Simulated setup · no network or settings writes."
		}
	}
	b := layoutBlock{lines: []string{accentStyle.Render(" " + title)}}
	b.lines = append(b.lines, strings.Split(mutedStyle.Render(textBlock(" "+intro, m.width-4)), "\n")...)
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
		if m.hasRuntimePolicy() && i == runtimePolicyField {
			b.lines = append(b.lines, style.Render(fit(marker+"Routing policy [←/→]", m.width-4)))
			label := runtimePolicyChoices[m.runtimePolicyIndex()].label
			b.targets = append(b.targets, hitTarget{x: 0, y: len(b.lines) - 1, width: m.width - 2, height: 2, action: "field", field: i})
			selector := controls([]control{{"‹", "left"}, {label, ""}, {"›", "right"}}, m.width-4)
			for j := range selector.targets {
				selector.targets[j].action = "runtime-policy"
			}
			b.append(selector)
			b.lines = append(b.lines, "")
			continue
		}
		input.Width = max(4, m.width-8)
		b.targets = append(b.targets, hitTarget{x: 0, y: len(b.lines), width: m.width - 2, height: 2, action: "field", field: i})
		label := labels[i]
		if input.Focused() {
			label += " [editing]"
		}
		b.lines = append(b.lines, style.Render(fit(marker+label, m.width-4)), " "+input.View(), "")
	}
	if m.screen == settingsScreen && !m.hasRuntimePolicy() {
		b.lines = append(b.lines, strings.Split(mutedStyle.Render(textBlock(" Set worker_type to codex, claude, or gemini in config.json, then restart the engine.", m.width-4)), "\n")...)
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
