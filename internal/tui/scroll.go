package tui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// A reading position belongs to a worker and a stable card, not an absolute row.
// Earlier entries may leave the engine's bounded history between snapshots.
type readingPosition struct {
	following bool
	key       string
	sequence  int64
	line      int
	seen      int64
	expired   bool
}

type activitySpan struct {
	key           string
	sequence      int64
	start, height int
}

func (m *Model) saveReadingPosition() {
	if m.activityWorker == "" || m.activityWorker != m.selected {
		return
	}
	position := m.reading[m.selected]
	position.following = m.following
	if m.following {
		position.seen = newestSequence(m.activitySpans)
		position.expired = false
	}
	for _, span := range m.activitySpans {
		if m.viewport.YOffset >= span.start && m.viewport.YOffset < span.start+span.height {
			position.key, position.sequence = span.key, span.sequence
			position.line = m.viewport.YOffset - span.start
			break
		}
	}
	m.reading[m.selected] = position
}

func newestSequence(spans []activitySpan) int64 {
	var latest int64
	for _, span := range spans {
		latest = max(latest, span.sequence)
	}
	return latest
}

func (m *Model) syncActivity() {
	m.saveReadingPosition()
	position := m.reading[m.selected]
	m.viewport.Width = max(1, m.width-4)
	m.viewport.Height = m.activityHeight()
	m.composer.Width = max(1, m.width-6)
	content, spans := m.renderActivity()
	m.viewport.SetContent(content)
	if m.following {
		m.viewport.GotoBottom()
	} else {
		offset, found := 0, false
		for _, span := range spans {
			if span.key == position.key {
				offset = span.start + min(position.line, span.height-1)
				found = true
				break
			}
		}
		if !found && position.key != "" {
			// If the card itself expired, select the oldest surviving activity rather
			// than jumping to live output or pretending its original content remains.
			for _, span := range spans {
				if span.sequence > 0 {
					offset = span.start
					break
				}
			}
			position.expired = true
		}
		m.viewport.SetYOffset(offset)
	}
	m.activitySpans, m.activityWorker = spans, m.selected
	m.reading[m.selected] = position
	m.saveReadingPosition()
	// The engine retains a bounded set of workers; do not keep orphan UI state.
	for id := range m.reading {
		found := false
		for _, worker := range m.snapshot.Workers {
			if worker.ID == id {
				found = true
				break
			}
		}
		if !found {
			delete(m.reading, id)
		}
	}
}

func (m *Model) followLatest() {
	m.following = true
	m.viewport.GotoBottom()
	m.saveReadingPosition()
}

func (m *Model) showInitialPrompt() {
	m.following = false
	m.viewport.GotoTop()
	m.saveReadingPosition()
}

func (m *Model) scrollActivity(message tea.Msg) {
	upward := false
	switch msg := message.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "up", "k", "pgup", "ctrl+u":
			upward = true
		}
	case tea.MouseMsg:
		upward = msg.Button == tea.MouseButtonWheelUp
	}
	m.viewport, _ = m.viewport.Update(message)
	// An upward gesture always means "let me read", even before overflow.
	// Scrolling down to the bottom deliberately resumes the live stream.
	m.following = !upward && m.viewport.AtBottom()
	m.saveReadingPosition()
}

func (m Model) followLabel() string {
	if m.following {
		if m.composing {
			return " Live · [Ctrl+Home] Initial prompt "
		}
		if m.compact() {
			return " Live · [Home] Prompt"
		}
		return " Following latest · [Home] Initial prompt "
	}
	position := m.reading[m.selected]
	count := 0
	for _, span := range m.activitySpans {
		if span.sequence > position.seen {
			count++
		}
	}
	label := " Reading history"
	if position.expired {
		label = " Earlier activity expired"
	}
	if count > 0 {
		label += fmt.Sprintf(" · %d new", count)
	}
	label += " · [f] Latest"
	if m.composing {
		label = strings.Replace(label, "[f]", "[Ctrl+End]", 1)
	}
	if m.compact() {
		label = " [f] Latest · position held"
		if count > 0 {
			label = fmt.Sprintf(" [f] Latest · %d new", count)
		}
		if position.expired {
			label = strings.Replace(label, " · position held", "", 1) + " · expired"
		}
		if m.composing {
			label = strings.Replace(label, "[f]", "[Ctrl+End]", 1)
		}
	}
	return label + " "
}
