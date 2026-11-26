package tui

import (
	"context"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"tmatrix/internal/backend"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
)

// A worker's live screen is a private tmux session owned by the engine. The
// console mirrors it in the activity panel and can hand the terminal over with
// `tmux attach`; it never sends keys itself, so messages still go through steering.

const screenInterval = 250 * time.Millisecond

var (
	terminalSocket  = regexp.MustCompile(`^tmx-[0-9a-f]{8,32}$`)
	terminalSession = regexp.MustCompile(`^[a-z]{1,16}$`)
)

type screenTickMsg struct{}
type screenMsg struct {
	workerID string
	text     string
	err      error
}

func validTerminal(terminal *backend.Terminal) bool {
	return terminal != nil && terminalSocket.MatchString(terminal.Socket) && terminalSession.MatchString(terminal.Session)
}

// showingTerminal reports whether the activity panel shows the selected worker's screen.
func (m Model) showingTerminal() bool {
	worker := m.worker()
	return worker != nil && worker.Status == "running" && validTerminal(worker.Terminal) && !m.hideTerminal[worker.ID]
}

// startScreenLoop begins mirroring when a screen becomes visible; one loop runs at a time.
func (m *Model) startScreenLoop() tea.Cmd {
	if m.screenLoop || !m.showingTerminal() {
		return nil
	}
	m.screenLoop = true
	return m.captureScreen()
}

func (m Model) captureScreen() tea.Cmd {
	worker := m.worker()
	if worker == nil || !validTerminal(worker.Terminal) {
		return nil
	}
	id, terminal := worker.ID, *worker.Terminal
	width, height := max(20, m.viewport.Width), max(5, m.viewport.Height)
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		// Fit Claude's layout to the panel; attaching switches back to the attached terminal's size.
		_ = exec.CommandContext(ctx, "tmux", "-L", terminal.Socket, "resize-window", "-t", terminal.Session,
			"-x", strconv.Itoa(width), "-y", strconv.Itoa(height)).Run()
		output, err := exec.CommandContext(ctx, "tmux", "-L", terminal.Socket, "capture-pane", "-p", "-e", "-t", terminal.Session).Output()
		return screenMsg{workerID: id, text: string(output), err: err}
	}
}

func (m Model) handleScreen(msg screenMsg) (tea.Model, tea.Cmd) {
	if m.screens == nil {
		m.screens = map[string]string{}
	}
	if msg.err != nil {
		m.screens[msg.workerID] = mutedStyle.Render("This worker's terminal is not reachable from this console.")
	} else {
		m.screens[msg.workerID] = msg.text
	}
	m.syncActivity()
	if !m.showingTerminal() {
		m.screenLoop = false
		return m, nil
	}
	return m, tea.Tick(screenInterval, func(time.Time) tea.Msg { return screenTickMsg{} })
}

func (m Model) handleScreenTick() (tea.Model, tea.Cmd) {
	if !m.showingTerminal() {
		m.screenLoop = false
		return m, nil
	}
	return m, m.captureScreen()
}

// screenContent fits the captured screen to the panel without breaking escape sequences.
func (m Model) screenContent() string {
	worker := m.worker()
	if worker == nil {
		return ""
	}
	text, ok := m.screens[worker.ID]
	if !ok {
		return mutedStyle.Render("Connecting to this worker's terminal…")
	}
	lines := strings.Split(strings.TrimRight(text, "\n"), "\n")
	width := max(1, m.viewport.Width)
	for index, line := range lines {
		lines[index] = ansi.Truncate(line, width, "") + "\x1b[0m"
	}
	return strings.Join(lines, "\n")
}

func (m Model) toggleTerminal() (tea.Model, tea.Cmd) {
	worker := m.worker()
	if worker == nil || !validTerminal(worker.Terminal) {
		m.notice = "This worker has no live terminal."
		return m, nil
	}
	if m.hideTerminal == nil {
		m.hideTerminal = map[string]bool{}
	}
	m.hideTerminal[worker.ID] = !m.hideTerminal[worker.ID]
	m.syncActivity()
	return m, m.startScreenLoop()
}

// attachTerminal suspends the console and gives the terminal to tmux until the user detaches.
func (m Model) attachTerminal() (tea.Model, tea.Cmd) {
	worker := m.worker()
	if worker == nil || worker.Status != "running" || !validTerminal(worker.Terminal) {
		m.notice = "This worker has no live terminal."
		return m, nil
	}
	id, terminal := worker.ID, *worker.Terminal
	command := exec.Command("tmux", "-L", terminal.Socket,
		"set-option", "-w", "-t", terminal.Session, "window-size", "latest", ";",
		"attach-session", "-t", terminal.Session)
	m.notice = "Attached to Claude. Detach with Ctrl+B then D."
	return m, tea.ExecProcess(command, func(err error) tea.Msg {
		return resultMsg{kind: "attach", workerID: id, text: "Detached from Claude's terminal.", err: err}
	})
}
