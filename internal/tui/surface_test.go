package tui

import (
	"image/color"
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/cellbuf"
	"github.com/muesli/termenv"
)

// Inspect emitted SGR at a terminal cell, including blank cells. Looking only
// at the style declarations cannot catch a reset exposing the wrong surface.
func surfaceCell(t *testing.T, frame string, x, y int) cellbuf.Style {
	t.Helper()
	line := strings.Split(frame, "\n")[y]
	var pen cellbuf.Style
	var state byte
	parser := ansi.NewParser()
	column := 0
	for len(line) > 0 {
		sequence, cells, consumed, next := ansi.DecodeSequence(line, state, parser)
		if consumed == 0 {
			t.Fatal("unable to decode painted surface")
		}
		if cells > 0 {
			if x >= column && x < column+cells {
				return pen
			}
			column += cells
		} else if ansi.HasCsiPrefix(sequence) && parser.Command() == 'm' {
			cellbuf.ReadStyle(parser.Params(), &pen)
		}
		state = next
		line = line[consumed:]
	}
	t.Fatalf("surface cell (%d, %d) is absent", x, y)
	return pen
}

func sameSurfaceColor(a, b color.Color) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	ar, ag, ab, aa := a.RGBA()
	br, bg, bb, ba := b.RGBA()
	return ar == br && ag == bg && ab == bb && aa == ba
}

func TestNestedSurfacesRestoreTheirOwnPairs(t *testing.T) {
	original := lipgloss.ColorProfile()
	t.Cleanup(func() { lipgloss.SetColorProfile(original) })
	for _, profile := range []termenv.Profile{termenv.TrueColor, termenv.ANSI256, termenv.ANSI} {
		t.Run(profile.Name(), func(t *testing.T) {
			lipgloss.SetColorProfile(profile)
			cardStyle := lipgloss.NewStyle().Foreground(matrixPalette.Tool).Background(matrixPalette.ToolBG)
			wantCard := surfaceCell(t, cardStyle.Render("X"), 0, 0)
			wantPane := surfaceCell(t, panelStyle.Render("X"), 0, 0)
			card := paintSurface("A\x1b[0mB\x1b[49mC\x1b[39mD", cardStyle)
			frame := paintCanvas(paintSurface("L"+card+"R", panelStyle))
			for x := 0; x < 6; x++ {
				want := wantCard
				if x == 0 || x == 5 {
					want = wantPane
				}
				got := surfaceCell(t, frame, x, 0)
				if !sameSurfaceColor(got.Fg, want.Fg) || !sameSurfaceColor(got.Bg, want.Bg) {
					t.Fatalf("nested reset lost the owning surface at column %d", x)
				}
			}
		})
	}
}

func TestMainWindowPaintsMarginsAndBlankRows(t *testing.T) {
	original := lipgloss.ColorProfile()
	t.Cleanup(func() { lipgloss.SetColorProfile(original) })
	for _, profile := range []termenv.Profile{termenv.TrueColor, termenv.ANSI256, termenv.ANSI} {
		t.Run(profile.Name(), func(t *testing.T) {
			lipgloss.SetColorProfile(profile)
			m, _ := testModel()
			frame := m.View()
			wantPane := surfaceCell(t, panelStyle.Render("X"), 0, 0).Bg
			canvas := surfaceCell(t, frame, 0, 0).Bg
			if profile != termenv.ANSI && sameSurfaceColor(wantPane, canvas) {
				t.Fatal("main window collapses into the outer canvas")
			}
			for y := m.headerHeight(); y < m.headerHeight()+m.bodyHeight(); y++ {
				// This is the window's margin, outside the nested transcript cards.
				if got := surfaceCell(t, frame, 1, y).Bg; !sameSurfaceColor(got, wantPane) {
					t.Fatalf("main window margin exposes another surface at row %d", y)
				}
			}
		})
	}
}

func TestANSIDarkSelectionInkDoesNotBecomeBrightGrey(t *testing.T) {
	original := lipgloss.ColorProfile()
	t.Cleanup(func() { lipgloss.SetColorProfile(original) })
	lipgloss.SetColorProfile(termenv.ANSI)
	m, _ := testModel()
	for _, block := range []layoutBlock{m.navLayout(), m.workerCards()} {
		for y, line := range block.lines {
			plain := ansi.Strip(line)
			needle := "[w]"
			if !strings.Contains(plain, needle) {
				needle = "Inspect"
			}
			if index := strings.Index(plain, needle); index >= 0 {
				pen := surfaceCell(t, strings.Join(block.lines, "\n"), lipgloss.Width(plain[:index]), y)
				if pen.Attrs&cellbuf.BoldAttr != 0 {
					t.Fatal("inverse selection uses bold, which some terminals brighten to unreadable grey")
				}
			}
		}
	}
}
