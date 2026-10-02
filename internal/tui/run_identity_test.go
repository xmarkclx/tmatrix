package tui

import (
	"fmt"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
	"tmatrix/internal/backend"
)

func TestRunLabelsUseExplicitMetadataAndKeepStopStates(t *testing.T) {
	for _, tc := range []struct{ status, kind, want string }{
		{"running", "initial", "initial run"},
		{"running", "resumed", "resumed run"},
		{"running", "", "running"},
		{"running", "future", "running"},
		{"stopping", "resumed", "stopping"},
		{"stop_unverified", "initial", "stop_unverified"},
		{"completed", "initial", "completed"},
	} {
		worker := backend.Worker{Status: tc.status, RunKind: tc.kind, ThreadID: "present-id", InputRevision: 99}
		if got := workerStateLabel(worker); got != tc.want {
			t.Fatalf("status %q, kind %q: got %q, want %q", tc.status, tc.kind, got, tc.want)
		}
	}
}

func TestWorkerCardsShowRunAndConversationRowsAcrossSizes(t *testing.T) {
	for _, size := range [][2]int{{40, 16}, {60, 24}, {140, 40}} {
		for _, portable := range []bool{false, true} {
			t.Run(fmt.Sprintf("%dx%d/portable=%t", size[0], size[1], portable), func(t *testing.T) {
				m, _ := testModel()
				m.options.Portable = portable
				m.now = time.Date(2026, 9, 29, 10, 0, 45, 0, time.UTC)
				for i := range m.snapshot.Workers {
					m.snapshot.Workers[i].StartedAt = "2026-09-29T10:00:00Z"
				}
				m.snapshot.Workers[0].RunKind = "initial"
				m.snapshot.Workers[1].RunKind = "resumed"
				m.snapshot.Workers[1].ThreadID = "thread-b\x1b]52;c;UNSAFE\x07"
				width := size[0]
				if portable {
					width++ // portable mode reserves the last terminal column
				}
				next, _ := m.Update(tea.WindowSizeMsg{Width: width, Height: size[1]})
				m = next.(Model)
				for i, label := range []string{"initial run: 45s elapsed", "resumed run: 45s elapsed"} {
					m.selectWorker(i)
					cards := m.workerCards()
					text := ansi.Strip(strings.Join(cards.lines, "\n"))
					if !strings.Contains(text, label) || len(cards.lines) != m.workerCardHeight() {
						t.Fatalf("missing run row or incorrect card geometry:\n%s", text)
					}
					id := []string{"thread-a", "thread-b"}[i]
					if size[1] >= 20 && !strings.Contains(text, "Conversation · "+id) {
						t.Fatalf("missing card conversation row:\n%s", text)
					}
					frame := ansi.Strip(m.View())
					if !strings.Contains(frame, id) || strings.Contains(frame, "UNSAFE") {
						t.Fatal("conversation missing or unsafe")
					}
					m, _ = clickTarget(t, m, "key", "enter", "", 0)
					m, _ = press(m, "esc")
					m, _ = clickTarget(t, m, "key", "x", "", 0)
					m, _ = press(m, "n")
					if len(strings.Split(m.View(), "\n")) != size[1] {
						t.Fatal("metadata displaced controls or overflowed frame")
					}
				}
			})
		}
	}
}
