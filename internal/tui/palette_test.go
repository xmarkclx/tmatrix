package tui

import (
	"fmt"
	"math"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"github.com/muesli/termenv"
	"tmatrix/internal/backend"
)

type readablePair struct {
	name   string
	fg, bg lipgloss.CompleteColor
}

func palettePairs() []readablePair {
	return []readablePair{
		{"canvas", matrixPalette.Text, matrixPalette.Background},
		{"canvas muted", matrixPalette.Muted, matrixPalette.Background},
		{"canvas accent", matrixPalette.Accent, matrixPalette.Background},
		{"canvas warning", matrixPalette.Warning, matrixPalette.Background},
		{"canvas error", matrixPalette.Error, matrixPalette.Background},
		{"pane", matrixPalette.Text, matrixPalette.Panel},
		{"pane muted", matrixPalette.Muted, matrixPalette.Panel},
		{"pane accent", matrixPalette.Accent, matrixPalette.Panel},
		{"worker", matrixPalette.CardText, matrixPalette.Card},
		{"selected worker", matrixPalette.ActiveCardText, matrixPalette.ActiveCard},
		{"selection", matrixPalette.SelectionText, matrixPalette.Selection},
		{"message", matrixPalette.Message, matrixPalette.MessageBG},
		{"steering", matrixPalette.Steering, matrixPalette.SteeringBG},
		{"tool", matrixPalette.Tool, matrixPalette.ToolBG},
		{"output", matrixPalette.Output, matrixPalette.OutputBG},
		{"status", matrixPalette.Status, matrixPalette.StatusBG},
		{"error", matrixPalette.ErrorText, matrixPalette.ErrorBG},
		{"prompt", matrixPalette.Prompt, matrixPalette.PromptBG},
	}
}

func luminance(t *testing.T, hex string) float64 {
	t.Helper()
	value, err := strconv.ParseUint(strings.TrimPrefix(hex, "#"), 16, 24)
	if err != nil {
		t.Fatal(err)
	}
	var result float64
	for index, weight := range []float64{0.2126, 0.7152, 0.0722} {
		channel := float64((value>>uint(16-index*8))&255) / 255
		if channel <= 0.04045 {
			channel /= 12.92
		} else {
			channel = math.Pow((channel+0.055)/1.055, 2.4)
		}
		result += channel * weight
	}
	return result
}

func requireContrast(t *testing.T, name, fg, bg string) {
	t.Helper()
	a, b := luminance(t, fg), luminance(t, bg)
	if a < b {
		a, b = b, a
	}
	if ratio := (a + 0.05) / (b + 0.05); ratio < 4.5 {
		t.Errorf("%s: %s on %s has %.2f:1 text contrast", name, fg, bg, ratio)
	}
}

func TestPalettePairsKeepReadableContrastAcrossCapabilities(t *testing.T) {
	// ANSI slots are user-configurable. Test representative Windows Terminal
	// dark/light schemes; truecolor and fixed xterm256 roles do not use slots.
	schemes := map[string][]string{
		"Campbell":       {"0C0C0C", "C50F1F", "13A10E", "C19C00", "0037DA", "881798", "3A96DD", "CCCCCC", "767676", "E74856", "16C60C", "F9F1A5", "3B78FF", "B4009E", "61D6D6", "F2F2F2"},
		"One Half Light": {"383A42", "E45649", "50A14F", "C18301", "0184BC", "A626A4", "0997B3", "FAFAFA", "4F525D", "DF6C75", "98C379", "E4C07A", "61AFEF", "C577DD", "56B5C1", "FFFFFF"},
	}
	for _, pair := range palettePairs() {
		requireContrast(t, "truecolor/"+pair.name, pair.fg.TrueColor, pair.bg.TrueColor)
		requireContrast(t, "256/"+pair.name, termenv.ConvertToRGB(termenv.ANSI256.Color(pair.fg.ANSI256)).Hex(), termenv.ConvertToRGB(termenv.ANSI256.Color(pair.bg.ANSI256)).Hex())
		fg, fgErr := strconv.Atoi(pair.fg.ANSI)
		bg, bgErr := strconv.Atoi(pair.bg.ANSI)
		if fgErr != nil || bgErr != nil || fg < 0 || fg > 15 || bg < 0 || bg > 15 {
			t.Fatalf("invalid ANSI pair %s", pair.name)
		}
		for name, scheme := range schemes {
			requireContrast(t, name+"/"+pair.name, scheme[fg], scheme[bg])
		}
	}
}

func TestExtendedPaletteAvoidsTerminalThemeSlots(t *testing.T) {
	roles := reflect.ValueOf(matrixPalette)
	for index := range roles.NumField() {
		role := roles.Field(index).Interface().(lipgloss.CompleteColor)
		value, err := strconv.Atoi(role.ANSI256)
		if err != nil || value < 16 || value > 255 {
			t.Errorf("%s uses a mutable terminal theme slot", roles.Type().Field(index).Name)
		}
	}
	for _, profile := range []string{"TrueColor", "ANSI256"} {
		seen := map[string]string{}
		for _, pair := range palettePairs()[11:] {
			bg := reflect.ValueOf(pair.bg).FieldByName(profile).String()
			if earlier, exists := seen[bg]; exists {
				t.Errorf("%s merges %s and %s card surfaces", profile, earlier, pair.name)
			}
			seen[bg] = pair.name
		}
	}
}

func TestActivityBodyKeepsItsOwnForegroundAndBackground(t *testing.T) {
	original := lipgloss.ColorProfile()
	t.Cleanup(func() { lipgloss.SetColorProfile(original) })
	for _, profile := range []termenv.Profile{termenv.TrueColor, termenv.ANSI256, termenv.ANSI} {
		lipgloss.SetColorProfile(profile)
		for _, kind := range []string{"message", "steering", "tool", "output", "status", "error"} {
			t.Run(fmt.Sprintf("%s/%s", profile.Name(), kind), func(t *testing.T) {
				m, _ := testModel()
				m.snapshot.Workers[0].Activity = []backend.Activity{{Kind: kind, Text: "PAIR_BODY"}}
				_, bg, fg := activityStyle(kind)
				assertCategoryTextColors(t, m.activity(), "PAIR_BODY", fg, bg)
			})
		}
		m, _ := testModel()
		m.snapshot.Workers[0].InitialPrompt = &backend.InitialPrompt{Text: "PROMPT_BODY"}
		assertCategoryTextColors(t, m.initialPromptCard(106), "PROMPT_BODY", matrixPalette.Prompt, matrixPalette.PromptBG)
	}
}

func assertCategoryTextColors(t *testing.T, frame, text string, fg, bg lipgloss.CompleteColor) {
	t.Helper()
	for row, line := range strings.Split(frame, "\n") {
		plain := ansi.Strip(line)
		start := strings.Index(plain, text)
		if start < 0 {
			continue
		}
		got := surfaceCell(t, frame, ansi.StringWidth(plain[:start]), row)
		want := surfaceCell(t, lipgloss.NewStyle().Foreground(fg).Background(bg).Render("X"), 0, 0)
		if !sameSurfaceColor(got.Fg, want.Fg) || !sameSurfaceColor(got.Bg, want.Bg) {
			t.Fatal("category body lost its foreground/background pair")
		}
		return
	}
	t.Fatalf("body %q missing", text)
}
