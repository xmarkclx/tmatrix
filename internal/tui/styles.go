package tui

import (
	"strings"
	"unicode"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

var (
	canvasStyle   = lipgloss.NewStyle().Foreground(matrixPalette.Text).Background(matrixPalette.Background)
	panelStyle    = lipgloss.NewStyle().Foreground(matrixPalette.Text).Background(matrixPalette.Panel)
	bodyStyle     = lipgloss.NewStyle().Foreground(matrixPalette.Text)
	mutedStyle    = lipgloss.NewStyle().Foreground(matrixPalette.Muted)
	accentStyle   = lipgloss.NewStyle().Foreground(matrixPalette.Accent).Bold(true)
	selectedStyle = lipgloss.NewStyle().Foreground(matrixPalette.SelectionText).Background(matrixPalette.Selection).Bold(true)
	borderStyle   = lipgloss.NewStyle().Foreground(matrixPalette.Border)
	warningStyle  = lipgloss.NewStyle().Foreground(matrixPalette.Warning)
	errorStyle    = lipgloss.NewStyle().Foreground(matrixPalette.Error)
	// Bubbles reverses cursor colors to draw its block; use explicit palette colors.
	cursorStyle = lipgloss.NewStyle().Foreground(matrixPalette.Accent).Background(matrixPalette.Background)
)

// Runtime text is untrusted terminal input. Strip ANSI/OSC sequences and control
// characters before rendering so output cannot manipulate the operator's terminal.
func clean(value string) string {
	value = ansi.Strip(value)
	return strings.Map(func(r rune) rune {
		if r == '\n' {
			return r
		}
		if r == '\t' {
			return ' '
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, value)
}
func single(value string) string { return strings.Join(strings.Fields(clean(value)), " ") }
func fit(value string, width int) string {
	if width <= 0 {
		return ""
	}
	value = ansi.Truncate(value, width, "")
	return value + strings.Repeat(" ", max(0, width-lipgloss.Width(value)))
}
func ellipsis(value string, width int) string {
	return ansi.Truncate(single(value), max(0, width), "…")
}
func frameLine(value string, width int, style lipgloss.Style) string {
	return style.Render(fit(value, width))
}
func textBlock(value string, width int) string {
	return lipgloss.NewStyle().Width(max(1, width)).Render(clean(value))
}
