package tui

import (
	"strings"

	"github.com/charmbracelet/x/ansi"
	"github.com/rivo/uniseg"
)

// Convert only the displayed frame, never worker data or submitted drafts.
// Preserve the measured cell count so wrapping, viewport anchors, and mouse
// targets still agree. SSH does not communicate the client's emoji/font width
// rules; compound emoji in particular can occupy more cells than Go predicts.
func portableFrame(frame string) string {
	var out strings.Builder
	var state byte
	for len(frame) > 0 {
		sequence, width, consumed, next := ansi.DecodeSequence(frame, state, nil)
		if width > 0 {
			// The ANSI decoder fast-paths ASCII bases, so a keycap such as
			// 1 + variation selector + enclosing keycap needs clustering here.
			sequence, _, width, _ = uniseg.FirstGraphemeClusterInString(frame, -1)
			consumed = len(sequence)
		}
		state = next
		frame = frame[consumed:]
		replacement := ""
		if width > 0 {
			for _, r := range sequence {
				switch {
				case strings.ContainsRune("─━═", r):
					replacement = "-"
				case strings.ContainsRune("│┃║", r):
					replacement = "|"
				case r >= 0x2500 && r <= 0x257f:
					replacement = "+"
				case strings.ContainsRune("←‹", r):
					replacement = "<"
				case strings.ContainsRune("→›↳", r):
					replacement = ">"
				case r == '…':
					replacement = "."
				case strings.ContainsRune("○●◐•", r):
					replacement = "*"
				case r == '·':
					replacement = ":"
				case r >= 0x1f000 && r <= 0x1faff || r >= 0x2600 && r <= 0x27ff || r == 0xfe0f || r == 0x20e3 || r == 0x200d:
					replacement = "*"
				}
			}
		}
		if replacement != "" {
			out.WriteString(replacement + strings.Repeat(" ", width-1))
		} else {
			// Keep international text, combining accents, and ANSI styling intact.
			out.WriteString(sequence)
		}
	}
	return out.String()
}
