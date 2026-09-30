package tui

import (
	"fmt"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"tmatrix/internal/backend"
)

func TestActivityCategoriesRecognizeNodeBridgeEvents(t *testing.T) {
	// observeRuntimeEvent in src/runner.ts sends event.type + item.type to
	// the console, unlike the short category names used by the demo fixtures.
	categories := []struct {
		item, label string
		bg, ink     lipgloss.CompleteColor
	}{
		{"agent_message", "💬 MESSAGE", matrixPalette.MessageBG, matrixPalette.Message},
		{"command_execution", "⚙ COMMAND", matrixPalette.ToolBG, matrixPalette.Tool},
		{"file_change", "⚙ FILES", matrixPalette.ToolBG, matrixPalette.Tool},
		{"web_search", "⚙ SEARCH", matrixPalette.ToolBG, matrixPalette.Tool},
		{"mcp_tool_call", "⚙ TOOL", matrixPalette.ToolBG, matrixPalette.Tool},
		{"error", "! ERROR", matrixPalette.ErrorBG, matrixPalette.ErrorText},
	}
	for _, category := range categories {
		for _, phase := range []string{"started", "updated", "completed"} {
			kind := "item." + phase + "." + category.item
			t.Run(kind, func(t *testing.T) {
				label, bg, ink := activityStyle(kind)
				if label != category.label || bg != category.bg || ink != category.ink {
					t.Fatalf("bridge event %s has wrong category/colors: %q %v %v", kind, label, bg, ink)
				}
				m, _ := testModel()
				m.snapshot.Workers[0].Activity = []backend.Activity{{
					At: "2026-09-29T10:01:00Z", Kind: kind, Text: "Fictional local activity.",
				}}
				if rendered := ansi.Strip(m.activity()); !strings.Contains(rendered, category.label) || !strings.Contains(rendered, "Fictional local activity.") {
					t.Fatalf("bridge event did not reach visible activity card: %q", rendered)
				}
			})
		}
	}
}

func TestActivityFailuresOverrideMessageAndToolCategories(t *testing.T) {
	for _, kind := range []string{"error", "item.completed.error", "turn.failed", "worker.failed", "tool.failed", "assistant.failed", "steering.failed", "item.failed.agent_message", "item.failed.command_execution"} {
		label, bg, ink := activityStyle(kind)
		if label != "! ERROR" || bg != matrixPalette.ErrorBG || ink != matrixPalette.ErrorText {
			t.Fatalf("failure %q rendered as ordinary activity: %q %v %v", kind, label, bg, ink)
		}
	}
}

func TestCompactWorkerStateRemainsVisible(t *testing.T) {
	for _, size := range [][2]int{{40, 16}, {60, 24}} {
		for _, status := range []string{"running", "stopping", "failed", "stopped", "completed", "stop_unverified"} {
			t.Run(fmt.Sprintf("%dx%d/%s", size[0], size[1], status), func(t *testing.T) {
				m, _ := testModel()
				m.now = time.Date(2026, 9, 29, 10, 4, 32, 0, time.UTC)
				m.snapshot.Workers[0].Status = status
				m.snapshot.Workers[0].Title = "Inspect fictional activity"
				m.snapshot.Workers[0].StartedAt = "2026-09-29T10:00:00Z"
				m.snapshot.Workers[0].Activity = []backend.Activity{{Text: "Fictional local activity."}}
				if status == "failed" || status == "stopped" || status == "completed" {
					m.snapshot.Workers[0].EndedAt = "2026-09-29T10:02:00Z"
				}
				resized, _ := m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
				m = resized.(Model)
				frame := ansi.Strip(m.View())
				if !strings.Contains(frame, " "+status+" · ") {
					t.Fatalf("compact frame hides execution status %q:\n%s", status, frame)
				}
				timing := "2m 00s total"
				if status == "running" || status == "stopping" {
					timing = "4m 32s elapsed"
				} else if status == "stop_unverified" {
					timing = "Runtime unknown"
				}
				if !strings.Contains(frame, timing) {
					t.Fatalf("compact frame hides runtime %q:\n%s", timing, frame)
				}
				if status != "running" && (strings.Contains(frame, "[Enter] Message") || strings.Contains(frame, "[x] Stop")) {
					t.Fatalf("compact frame offers running-worker actions for %s", status)
				}
				if lines := strings.Split(frame, "\n"); len(lines) != size[1] {
					t.Fatalf("compact state exceeds terminal height: %d", len(lines))
				}
			})
		}
	}
}
