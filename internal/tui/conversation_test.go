package tui

import (
	"fmt"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
)

func TestConversationIdentitySurvivesInputUpdatesAtEverySize(t *testing.T) {
	for _, size := range [][2]int{{40, 16}, {60, 24}, {110, 40}} {
		t.Run(fmt.Sprintf("%dx%d", size[0], size[1]), func(t *testing.T) {
			m, b := testModel()
			next, _ := m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
			m = next.(Model)
			before := m.View()
			if !strings.Contains(ansi.Strip(before), "Conversation · thread-a") {
				t.Fatal("runtime conversation identity is hidden")
			}
			b.snapshot.Workers[0].InputRevision = 99
			next, _ = m.Update(snapshotMsg{snapshot: b.snapshot})
			m = next.(Model)
			if after := m.View(); after != before {
				t.Fatal("internal input update changed the displayed conversation")
			}
			// The extra metadata line must not push controls out of compact frames.
			m, _ = clickTarget(t, m, "key", "enter", "", 0)
			if !m.composing {
				t.Fatal("conversation metadata displaced the message control")
			}
		})
	}
}

func TestMissingConversationDoesNotBorrowAnotherWorkerIdentity(t *testing.T) {
	m, _ := testModel()
	m, _ = press(m, "right")
	frame := ansi.Strip(m.View())
	if !strings.Contains(frame, "Conversation ID unavailable") || strings.Contains(frame, "thread-a") {
		t.Fatal("worker with no runtime ID appears to have a conversation")
	}
	m.snapshot.Workers[1].ThreadID = "thread-b\x1b]52;c;UNSAFE\x07\n"
	frame = ansi.Strip(m.View())
	if !strings.Contains(frame, "Conversation · thread-b") || strings.Contains(frame, "UNSAFE") {
		t.Fatal("conversation identity is missing or has unsafe terminal controls")
	}
}
