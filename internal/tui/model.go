// Package tui presents TMatrix as a keyboard-first instrument for supervising workers.
// THESIS: one worker's actual activity occupies the instrument, with adjacent worker cards.
// OWN-WORLD: Matrix green canvas, bordered tabs/cards, role-colored message surfaces.
// STORY: see capacity, select a worker, read activity, then steer or request a stop.
// FIRST VIEWPORT: wordmark/capacity, bordered navigation/cards, status/timer, transcript, controls.
// FORM: terminal-native tabbed console, pinned by the human's Matrix palette brief.
package tui

import (
	"context"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"tmatrix/internal/backend"
)

type Options struct {
	Demo bool
	// NoMouse starts with terminal selection instead of application mouse capture.
	NoMouse bool
	// Portable uses stable-width symbols and leaves the terminal's last column free.
	Portable bool
}
type screen int

const (
	workersScreen screen = iota
	pollersScreen
	settingsScreen
	connectScreen
	helpScreen
	serviceScreen
)

type tickMsg time.Time
type snapshotMsg struct {
	snapshot backend.Snapshot
	err      error
}
type resultMsg struct {
	kind, workerID, text string
	err                  error
}

type Model struct {
	matrix              matrixPlayback
	mouseDisabled       bool
	backend             backend.Backend
	options             Options
	snapshot            backend.Snapshot
	width, height       int
	screen              screen
	selected            string
	pageOffset          int
	viewport            viewport.Model
	following           bool
	reading             map[string]readingPosition
	activitySpans       []activitySpan
	activityWorker      string
	composer            textinput.Model
	composing           bool
	drafts              map[string]string
	form                []textinput.Model
	field               int
	serviceConfirmation string
	confirmation        string
	busy                bool
	restarting          bool
	notice, failure     string
	connectionError     string
	loaded              bool
	now                 time.Time
}

func New(service backend.Backend, options Options) Model {
	input := textinput.New()
	input.Prompt = "> "
	input.Placeholder = "Message this worker..."
	input.CharLimit = 8000
	input.TextStyle = bodyStyle
	input.PromptStyle = accentStyle
	input.PlaceholderStyle = mutedStyle
	input.Cursor.Style = cursorStyle
	input.Cursor.TextStyle = bodyStyle
	return Model{mouseDisabled: options.NoMouse, now: time.Now(), backend: service, options: options, width: 100, height: 30, viewport: viewport.New(96, 18), following: true, composer: input, drafts: map[string]string{}, reading: map[string]readingPosition{}}
}

func (m Model) Init() tea.Cmd { return tea.Batch(tea.SetWindowTitle("TMatrix"), m.refresh()) }
func (m Model) refresh() tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		snapshot, err := m.backend.Snapshot(ctx)
		return snapshotMsg{snapshot: snapshot, err: err}
	}
}
func nextRefresh() tea.Cmd {
	return tea.Tick(time.Second, func(t time.Time) tea.Msg { return tickMsg(t) })
}
func (m Model) operation(kind, workerID string, fn func(context.Context) (string, error)) tea.Cmd {
	return func() tea.Msg {
		ctx := context.Background()
		// Connection changes wait for admitted workers to finish, however long
		// their tasks take. Individual bridge requests still have HTTP timeouts.
		if kind != "connect" {
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
		}
		text, err := fn(ctx)
		return resultMsg{kind: kind, workerID: workerID, text: text, err: err}
	}
}
func (m Model) worker() *backend.Worker {
	for i := range m.snapshot.Workers {
		if m.snapshot.Workers[i].ID == m.selected {
			return &m.snapshot.Workers[i]
		}
	}
	return nil
}
func (m *Model) selectWorker(index int) {
	m.saveReadingPosition()
	if len(m.snapshot.Workers) == 0 {
		m.selected = ""
		return
	}
	if index < 0 {
		index = len(m.snapshot.Workers) - 1
	}
	index %= len(m.snapshot.Workers)
	if m.composing {
		m.drafts[m.selected] = m.composer.Value()
	}
	m.selected = m.snapshot.Workers[index].ID
	m.composer.SetValue(m.drafts[m.selected])
	if m.composing && m.worker().Status != "running" {
		m.composing = false
		m.composer.Blur()
	}
	position, exists := m.reading[m.selected]
	m.following = !exists || position.following
	m.activityWorker = ""
	m.syncActivity()
}
func (m Model) selectedIndex() int {
	for i, w := range m.snapshot.Workers {
		if w.ID == m.selected {
			return i
		}
	}
	return 0
}
