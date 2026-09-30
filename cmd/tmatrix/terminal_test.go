package main

import (
	"testing"

	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

func TestTerminalSettings(t *testing.T) {
	original := lipgloss.ColorProfile()
	t.Cleanup(func() { lipgloss.SetColorProfile(original) })
	lipgloss.SetColorProfile(termenv.ANSI)
	for _, tc := range []struct {
		name, mode, color string
		env               map[string]string
		portable          bool
		profile           termenv.Profile
	}{
		{"local", "auto", "auto", nil, false, termenv.ANSI},
		{"ssh", "auto", "auto", map[string]string{"SSH_CONNECTION": "sample"}, true, termenv.ANSI},
		{"ssh client", "auto", "256", map[string]string{"SSH_CLIENT": "sample"}, true, termenv.ANSI256},
		{"ssh tty", "auto", "16", map[string]string{"SSH_TTY": "/dev/pts/1"}, true, termenv.ANSI},
		{"rich override", "rich", "truecolor", map[string]string{"SSH_TTY": "/dev/pts/1"}, false, termenv.TrueColor},
		{"portable override", "portable", "none", nil, true, termenv.Ascii},
		{"no color wins", "auto", "truecolor", map[string]string{"NO_COLOR": "1"}, false, termenv.Ascii},
	} {
		t.Run(tc.name, func(t *testing.T) {
			portable, profile, err := terminalSettings(tc.mode, tc.color, func(k string) string { return tc.env[k] })
			if err != nil || portable != tc.portable || profile != tc.profile {
				t.Fatalf("got portable=%v profile=%v err=%v", portable, profile, err)
			}
		})
	}
	for _, args := range [][2]string{{"invalid", "auto"}, {"auto", "invalid"}} {
		if _, _, err := terminalSettings(args[0], args[1], func(string) string { return "" }); err == nil {
			t.Fatal("invalid terminal option accepted")
		}
	}
}
