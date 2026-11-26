package tui

import (
	"fmt"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
)

func TestWorkerCardsShowModelAcrossSizes(t *testing.T) {
	for _, size := range [][2]int{{40, 16}, {60, 19}, {60, 20}, {60, 24}, {60, 28}, {110, 40}} {
		for _, portable := range []bool{false, true} {
			t.Run(fmt.Sprintf("%dx%d/portable=%t", size[0], size[1], portable), func(t *testing.T) {
				m, _ := testModel()
				m.snapshot.Workers = m.snapshot.Workers[:1]
				m.snapshot.Workers[0].Model = "gpt-5.5"
				m.snapshot.Workers[0].StartedAt = "2026-09-29T10:00:00Z"
				m.now = time.Date(2026, 9, 29, 10, 0, 0, 0, time.UTC)
				m.options.Portable = portable
				width := size[0]
				if portable {
					width++
				}
				next, _ := m.Update(tea.WindowSizeMsg{Width: width, Height: size[1]})
				m = next.(Model)
				cards := m.workerCards()
				text := ansi.Strip(strings.Join(cards.lines, "\n"))
				want, rows := "Model · gpt-5.5", 6
				if size[1] < 20 {
					want, rows = "running · 0s elapsed · gpt-5.5", 4
					if size[0] == 40 {
						want = "running · 0s elapsed · gpt-"
					}
				} else if !strings.Contains(ansi.Strip(cards.lines[4]), "Conversation · thread-a") {
					t.Fatalf("model displaced conversation row:\n%s", text)
				}
				if len(cards.lines) != rows || !strings.Contains(text, want) {
					t.Fatalf("missing model or incorrect card height, want %q in %d rows:\n%s", want, rows, text)
				}
				frame := ansi.Strip(m.View())
				if portable {
					want = strings.ReplaceAll(want, "·", ":")
				}
				if !strings.Contains(frame, want) || len(strings.Split(frame, "\n")) != size[1] {
					t.Fatalf("model missing or frame height incorrect:\n%s", frame)
				}
				m.snapshot.Workers = nil
				if got := len(strings.Split(m.View(), "\n")); got != size[1] {
					t.Fatalf("empty frame has %d rows, want %d", got, size[1])
				}
			})
		}
	}
}

func TestWorkerCardModelIsSanitizedAndDoesNotBorrowAnotherModel(t *testing.T) {
	m, _ := testModel()
	m.snapshot.Workers[0].WorkerType = "gemini"
	m.snapshot.Workers[0].Model = "gemini-4-neon-high\x1b]52;c;UNSAFE\x07\n"
	cards := ansi.Strip(strings.Join(m.workerCards().lines, "\n"))
	if !strings.Contains(cards, "Model · gemini-4-neon-high") || !strings.Contains(cards, "Model unavailable") || strings.Contains(cards, "UNSAFE") {
		t.Fatalf("model missing, borrowed, or unsafe:\n%s", cards)
	}
	m.selectWorker(1)
	m.snapshot.Workers = m.snapshot.Workers[1:]
	next, _ := m.Update(tea.WindowSizeMsg{Width: 60, Height: 16})
	m = next.(Model)
	cards = ansi.Strip(strings.Join(m.workerCards().lines, "\n"))
	if !strings.Contains(cards, "running · Runtime unknown") || strings.Contains(cards, "unknown ·") || strings.Contains(cards, "Model") {
		t.Fatalf("empty model added a compact suffix:\n%s", cards)
	}
}
