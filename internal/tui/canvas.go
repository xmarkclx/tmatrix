package tui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// paintCanvas runs after layout so even padding and blank rows own their colors.
// Lipgloss v1 does not restore an outer style after a nested ANSI reset. Without
// this step, styled spans and viewport wrapping expose the terminal's default
// background, which appears as grey patches in Windows Terminal.
func paintCanvas(value string) string {
	return paintSurface(value, canvasStyle)
}

// Each surface restores its own colors after nested styles, including blank
// cells. Applying this from the innermost card out to the pane and canvas keeps
// resets inside a card from exposing the pane, or the terminal's default theme.
func paintSurface(value string, surface lipgloss.Style) string {
	// Derive the sequences through Lipgloss to respect the detected color profile
	// (including NO_COLOR), rather than hardcoding truecolor escapes.
	base, _, _ := strings.Cut(surface.Render(" "), " ")
	if base == "" {
		return value
	}
	foreground, _, _ := strings.Cut(surface.UnsetBackground().Render(" "), " ")
	background, _, _ := strings.Cut(surface.UnsetForeground().Render(" "), " ")
	const reset = "\x1b[0m"
	restore := strings.NewReplacer(
		reset, reset+base,
		"\x1b[m", reset+base,
		"\x1b[39m", foreground,
		"\x1b[49m", background,
		"\n", reset+"\n"+base,
	)
	// Leave the shell's attributes alone when the console detaches.
	return base + restore.Replace(value) + reset
}
