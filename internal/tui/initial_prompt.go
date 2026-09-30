package tui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

// The double border distinguishes the execution's prepared input from all
// subsequent rounded activity cards, including in monochrome terminals.
func (m Model) initialPromptCard(width int) string {
	prompt := m.worker().InitialPrompt
	inner := width - 4
	title := "INITIAL PROMPT"
	detail := "Prepared input · receipt shown in activity"
	body := "Not captured for this run. New runs with an updated engine include their initial prompt here."
	if prompt != nil {
		body = prompt.Text
		var notes []string
		if prompt.Truncated {
			notes = append(notes, "Excerpt: initial prompt exceeds the local limit.")
		}
		if prompt.Redacted {
			notes = append(notes, "Credential-like values redacted.")
		}
		if len(notes) > 0 {
			body += "\n\n" + strings.Join(notes, " ")
		}
	}
	style := lipgloss.NewStyle().Width(width-2).Padding(0, 1).
		Border(lipgloss.DoubleBorder()).BorderForeground(matrixPalette.PromptBorder).
		Background(matrixPalette.PromptBG).Foreground(matrixPalette.Prompt)
	heading := lipgloss.NewStyle().Foreground(matrixPalette.Prompt).Background(matrixPalette.PromptBG).Bold(lipgloss.ColorProfile() != termenv.ANSI).Render(title)
	// Apply the surface to the entire block, including wrapped and blank cells.
	return paintSurface(style.Render(heading+"\n"+textBlock(detail, inner)+"\n\n"+textBlock(body, inner)), lipgloss.NewStyle().Foreground(matrixPalette.Prompt).Background(matrixPalette.PromptBG))
}
