package tui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

func TestPanelPaddingPreservesContentAndExcludesMouseTargets(t *testing.T) {
	for _, width := range []int{40, 60, 110} {
		m, _ := testModel()
		m.width = width
		content := strings.Repeat("界", (width-4)/2)
		body := layoutBlock{
			lines:   []string{content},
			targets: []hitTarget{{x: 0, y: 0, width: width, height: 1, action: "scroll"}},
		}
		frame := m.frameBody(body)
		if got := ansi.Strip(frame.lines[1]); got != "│ "+content+" │" {
			t.Fatalf("%d columns: content or padding changed: %q", width, got)
		}
		for _, line := range frame.lines {
			if lipgloss.Width(line) != width {
				t.Fatalf("%d columns: frame overflow: %q", width, line)
			}
		}
		if len(frame.targets) != 1 {
			t.Fatalf("expected one content target, got %d", len(frame.targets))
		}
		target := frame.targets[0]
		if !target.contains(2, 1) || !target.contains(width-3, 1) {
			t.Fatal("content edges are no longer clickable")
		}
		for _, x := range []int{0, 1, width - 2, width - 1} {
			if target.contains(x, 1) {
				t.Fatalf("border/padding at column %d activates content", x)
			}
		}
	}
}
