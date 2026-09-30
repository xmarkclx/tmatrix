package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

func (m Model) workerCards() layoutBlock {
	height := 4
	if m.compact() {
		height = 3
	}
	if len(m.snapshot.Workers) == 0 {
		result := controls([]control{{"[c] Connect with Tzu Do", "c"}}, m.width)
		for len(result.lines) < height {
			result.lines = append(result.lines, "")
		}
		return result
	}
	// Whole cards only. Paging keeps the selected worker visible at every width.
	count := min(len(m.snapshot.Workers), max(1, (m.width-8)/27))
	start := m.selectedIndex() / count * count
	end := min(len(m.snapshot.Workers), start+count)
	cardWidth := (m.width - 8) / count
	var parts []string
	targets := []hitTarget{}
	left := "   "
	if m.selectedIndex() > 0 {
		left = " ‹ "
		targets = append(targets, hitTarget{x: 0, y: 0, width: 3, height: height, action: "key", key: "left"})
	}
	parts = append(parts, mutedStyle.Height(height).Render(left))
	x := 3
	for i := start; i < end; i++ {
		worker := m.snapshot.Workers[i]
		selected := worker.ID == m.selected
		border := matrixPalette.Border
		bg := matrixPalette.Card
		ink := matrixPalette.CardText
		marker := "○"
		switch worker.Status {
		case "running":
			marker = "●"
		case "stopping":
			marker = "◐"
		case "completed", "done", "ready_for_review":
			marker = "✓"
		case "failed":
			marker = "!"
		case "stop_unverified":
			marker = "?"
		}
		if selected {
			border = matrixPalette.Accent
			bg = matrixPalette.ActiveCard
			ink = matrixPalette.ActiveCardText
		}
		inner := cardWidth - 4
		pin := ""
		if worker.Pinned {
			pin = "📌 PIN "
			if m.options.Portable {
				pin = "PIN "
			}
		}
		title := fmt.Sprintf("%d %s %s%s", i+1, marker, pin, single(worker.Title))
		lines := []string{ellipsis(title, inner)}
		if !m.compact() {
			lines = append(lines, ellipsis(single(worker.Status)+" · "+elapsedLabel(worker, m.now), inner))
		}
		style := lipgloss.NewStyle().Width(cardWidth-2).Padding(0, 1).Border(lipgloss.RoundedBorder()).BorderForeground(border).Foreground(ink).Background(bg)
		// Some 16-color terminals brighten dark ink when bold is enabled,
		// making an inverse green selection difficult to read.
		if selected && lipgloss.ColorProfile() != termenv.ANSI {
			style = style.Bold(true)
		}
		card := style.Render(strings.Join(lines, "\n"))
		parts = append(parts, card)
		targets = append(targets, hitTarget{x: x, y: 0, width: cardWidth, height: height, action: "worker", workerID: worker.ID})
		x += cardWidth
	}
	if m.selectedIndex() < len(m.snapshot.Workers)-1 {
		parts = append(parts, mutedStyle.Height(height).Render(" › "))
		targets = append(targets, hitTarget{x: x, y: 0, width: 3, height: height, action: "key", key: "right"})
	}
	return layoutBlock{lines: strings.Split(lipgloss.JoinHorizontal(lipgloss.Top, parts...), "\n"), targets: targets}
}

func (m Model) workerContent() layoutBlock {
	if !m.loaded {
		return layoutBlock{lines: []string{mutedStyle.Render(" Reading local engine state…")}}
	}
	worker := m.worker()
	if worker == nil {
		return layoutBlock{lines: strings.Split(strings.Join([]string{
			accentStyle.Render(" Your workers, within reach."), "",
			mutedStyle.Render("  ┌───┐    ┌───┐    ┌───┐"),
			mutedStyle.Render("  │ > │    │ > │    │ > │"),
			mutedStyle.Render("  └─┬─┘    └─┬─┘    └─┬─┘"), "",
			textBlock("Connect Tzu Do below, then resume intake. Each worker gets its own activity tab.", m.width-4),
		}, "\n"), "\n")}
	}
	width := m.width - 4
	runtime := single(worker.WorkerType)
	if runtime == "" {
		runtime = "codex"
	}
	state := single(worker.Status)
	if state == "" {
		state = "unknown"
	}
	if worker.Pinned {
		state = "📌 PIN · " + state
		if m.options.Portable {
			state = "PIN · " + single(worker.Status)
		}
	}
	meta := state + " · " + elapsedLabel(*worker, m.now) + " · " + runtime
	conversation := "Conversation ID unavailable"
	if id := single(worker.ThreadID); strings.TrimSpace(id) != "" {
		conversation = "Conversation · " + id
	}
	b := layoutBlock{lines: []string{accentStyle.Render(ellipsis(worker.Title, width)), mutedStyle.Render(ellipsis(meta, width))}}
	b.lines = append(b.lines, mutedStyle.Render(ellipsis(conversation, width)))
	// The viewport dimensions use this same geometry in syncActivity.
	y := len(b.lines)
	for _, line := range strings.Split(m.viewport.View(), "\n") {
		b.lines = append(b.lines, line)
	}
	b.targets = append(b.targets, hitTarget{x: 0, y: y, width: width, height: m.activityHeight(), action: "scroll"})
	follow := m.followLabel()
	b.lines = append(b.lines, mutedStyle.Render(fit(follow+strings.Repeat("─", width), width)))
	barAction := "f"
	if m.following {
		barAction = "home"
	}
	b.targets = append(b.targets, hitTarget{x: 0, y: len(b.lines) - 1, width: width, height: 1, action: "key", key: barAction})

	if m.confirmation != "" {
		b.lines = append(b.lines, warningStyle.Render(" Stop this worker? Confirmation required."))
		if !m.compact() {
			b.lines = append(b.lines, mutedStyle.Render(" Local stop can be recovered on engine restart."))
		}
	} else if m.composing {
		if !m.compact() {
			b.lines = append(b.lines, accentStyle.Render(" Message · same conversation · queues next turn"))
		}
		b.targets = append(b.targets, hitTarget{x: 0, y: len(b.lines), width: width, height: 1, action: "composer"})
		b.lines = append(b.lines, composerView(m.composer))
	} else {
		messageLabel, previousLabel := "[Enter] Message", "[←] Previous"
		if m.compact() {
			messageLabel, previousLabel = "[Enter] Msg", "[←] Prev"
		}
		items := []control{{messageLabel, "enter"}, {"[x] Stop", "x"}}
		if worker.Status != "running" {
			items = []control{{previousLabel, "left"}, {"[→] Next", "right"}}
		}
		pinLabel := "[P] Pin"
		if worker.Pinned {
			pinLabel = "[P] Unpin"
		}
		items = append(items, control{pinLabel, "P"})
		b.append(controls(items, width))
		if !m.compact() {
			hint := "Messages queue for the next turn; receipt is separate."
			if m.drafts[m.selected] != "" {
				hint = "Draft saved for this conversation · Enter to continue."
			}
			b.lines = append(b.lines, mutedStyle.Render(" "+ellipsis(hint, width)))
		}
	}
	return b
}
