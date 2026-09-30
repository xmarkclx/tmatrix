package main

import (
	"fmt"

	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

func terminalSettings(mode, color string, getenv func(string) string) (bool, termenv.Profile, error) {
	portable := false
	switch mode {
	case "auto":
		portable = getenv("SSH_CONNECTION") != "" || getenv("SSH_CLIENT") != "" || getenv("SSH_TTY") != ""
	case "portable":
		portable = true
	case "rich":
	default:
		return false, 0, fmt.Errorf("invalid --terminal %q: use auto, portable, or rich", mode)
	}
	profile := lipgloss.ColorProfile()
	switch color {
	case "auto": // Honor advertised capability; SSH alone does not imply truecolor.
	case "16":
		profile = termenv.ANSI
	case "256":
		profile = termenv.ANSI256
	case "truecolor":
		profile = termenv.TrueColor
	case "none":
		profile = termenv.Ascii
	default:
		return false, 0, fmt.Errorf("invalid --color %q: use auto, 16, 256, truecolor, or none", color)
	}
	if getenv("NO_COLOR") != "" {
		profile = termenv.Ascii
	}
	return portable, profile, nil
}
