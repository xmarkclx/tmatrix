package tui

// Matrix is an immersive, borderless transcript: phosphor-green rows rise from
// a black canvas, with a brighter leading row and a single exit hint. Real
// worker text supplies the motion; no fabricated code rain obscures messages.
import (
	"crypto/sha256"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"tmatrix/internal/backend"
)

type matrixTick struct {
	generation uint64
	at         time.Time
}
type matrixPlayback struct {
	finished                  bool
	backlogWidth, backlogRows int
	active                    bool
	generation                uint64
	workerID, title, status   string
	seen                      map[string]bool
	pending, visible          []string
	lastFrame, lastArrival    time.Time
	rate, incoming, credit    float64
}

func matrixNext(generation uint64) tea.Cmd {
	return tea.Tick(50*time.Millisecond, func(t time.Time) tea.Msg { return matrixTick{generation, t} })
}
func (m *Model) enterMatrix() tea.Cmd {
	w := m.worker()
	if w == nil {
		return nil
	}
	m.matrix = matrixPlayback{active: true, generation: m.matrix.generation + 1, workerID: w.ID, title: single(w.Title), seen: map[string]bool{}, rate: 2, lastFrame: time.Now()}
	m.matrix.ingest(*w, m.width, time.Now())
	return matrixNext(m.matrix.generation)
}

// Continue only after the previous worker's buffered output has been shown.
// Keep the same timer chain and visible rows so the transition scrolls naturally.
func (m *Model) continueMatrix(now time.Time) {
	p := &m.matrix
	if !p.active || !p.finished || len(p.pending) > 0 || m.connectionError != "" {
		return
	}
	for i, w := range m.snapshot.Workers {
		if w.ID == p.workerID || (w.Status != "running" && w.Status != "stopping" && w.Status != "stop_unverified") {
			continue
		}
		visible, generation, rate := p.visible, p.generation, p.rate
		m.selectWorker(i)
		m.matrix = matrixPlayback{active: true, generation: generation, workerID: w.ID,
			title: single(w.Title), seen: map[string]bool{}, visible: visible, rate: rate,
			lastFrame: now, pending: []string{"", "NEXT TASK / " + single(w.Title)}}
		m.matrix.ingest(w, m.width, now)
		return
	}
}

func (p *matrixPlayback) ingest(w backend.Worker, width int, now time.Time) {
	p.status = single(w.Status)
	p.finished = w.Status != "running" && w.Status != "stopping" && w.Status != "stop_unverified"
	before := len(p.pending)
	add := func(key, text string) {
		if p.seen[key] {
			return
		}
		p.seen[key] = true
		p.pending = append(p.pending, strings.Split(clean(text), "\n")...)
	}
	// Matrix starts near live output; prompts remain available in the normal view.
	initial := p.lastArrival.IsZero()
	duplicates := map[string]int{}
	for index, event := range w.Activity {
		key := fmt.Sprintf("event:%d", event.Sequence)
		if event.Sequence <= 0 {
			hash := sha256.Sum256([]byte(event.At + "\x00" + event.Kind + "\x00" + event.Text))
			base := fmt.Sprintf("legacy:%x", hash[:12])
			duplicates[base]++
			key = fmt.Sprintf("%s:%d", base, duplicates[base])
		}
		if initial && index != len(w.Activity)-1 {
			p.seen[key] = true
			continue
		}
		text := strings.ToUpper(single(event.Kind)) + "  " + single(event.At) + "\n" + event.Text
		if initial {
			// Even a huge latest tool result must not create a historical backlog.
			rows := strings.Split(ansi.Hardwrap(clean(text), max(2, width), true), "\n")
			if len(rows) > 8 {
				rows = append([]string{"[Latest output / last 8 rows]"}, rows[len(rows)-8:]...)
			}
			text = strings.Join(rows, "\n")
		}
		add(key, text)
	}
	for _, s := range w.Steering {
		key := "steer:" + s.ID + ":" + s.Status
		if initial {
			p.seen[key] = true
		} else {
			add(key, steeringLabel(s.Status))
		}
	}
	// Smooth arrival volume in screen rows/sec. Initial replay isn't live traffic.
	if !p.lastArrival.IsZero() {
		seconds := now.Sub(p.lastArrival).Seconds()
		if seconds > 0 {
			rows := 0
			for _, line := range p.pending[before:] {
				rows += max(1, (lipgloss.Width(line)+max(1, width)-1)/max(1, width))
			}
			p.incoming = .75*p.incoming + .25*float64(rows)/seconds
		}
	}
	p.lastArrival = now
	if len(p.pending) != before {
		p.backlogWidth = 0
	}
}
func (p *matrixPlayback) advance(now time.Time, width, height int) {
	elapsed := min(.25, max(0, now.Sub(p.lastFrame).Seconds()))
	p.lastFrame = now
	if width < 2 || height < 2 {
		p.credit = 0
		return
	}
	if len(p.pending) == 0 {
		p.credit = 0
		return
	}
	if p.backlogWidth != width {
		p.backlogRows = 0
		for _, line := range p.pending {
			p.backlogRows += len(strings.Split(ansi.Hardwrap(line, max(2, width), true), "\n"))
		}
		p.backlogWidth = width
	}
	// An eight-second catch-up horizon absorbs bursts; smoothing prevents jumps.
	target := min(30, max(2, p.incoming+float64(p.backlogRows)/8))
	p.rate += (target - p.rate) * min(1, elapsed*2)
	p.credit += p.rate * elapsed
	for p.credit >= 1 && len(p.pending) > 0 {
		lines := strings.Split(ansi.Hardwrap(p.pending[0], max(2, width), true), "\n")
		p.visible = append(p.visible, lines[0])
		if len(lines) > 1 {
			p.pending[0] = strings.Join(lines[1:], "\n")
		} else {
			p.pending[0] = ""
			p.pending = p.pending[1:]
		}
		p.credit--
		p.backlogRows--
	}
	// Only screen history is needed once rows have been presented.
	if len(p.visible) > max(1, height) {
		p.visible = append([]string(nil), p.visible[len(p.visible)-max(1, height):]...)
	}
}
func (m Model) matrixView() string {
	black := lipgloss.CompleteColor{TrueColor: "#000000", ANSI256: "16", ANSI: "0"}
	green := lipgloss.CompleteColor{TrueColor: "#00CC44", ANSI256: "41", ANSI: "2"}
	bright := lipgloss.CompleteColor{TrueColor: "#66FF88", ANSI256: "84", ANSI: "10"}
	style := lipgloss.NewStyle().Foreground(green).Background(black)
	lines := make([]string, max(1, m.height))
	available := max(0, m.height-1)
	visible := m.matrix.visible[max(0, len(m.matrix.visible)-available):]
	for i := range lines {
		lines[i] = style.Render(fit("", m.width))
	}
	for i, line := range visible {
		rowStyle := style
		if i == len(visible)-1 {
			rowStyle = rowStyle.Foreground(bright)
		}
		lines[available-len(visible)+i] = rowStyle.Render(fit(line, m.width))
	}
	status := m.matrix.status
	if m.connectionError != "" {
		status = "connection lost; retrying"
	} else if m.matrix.finished && len(m.matrix.pending) == 0 {
		status = "waiting for next task"
	} else if len(m.matrix.pending) == 0 {
		status += " / waiting"
	}
	hint := "[Esc/m] Exit Matrix | " + m.matrix.title + " | " + status
	if m.options.Demo {
		hint = "[Esc/m] Exit Matrix | DEMO | " + m.matrix.title + " | " + status
	}
	lines[len(lines)-1] = style.Render(fit(hint, m.width))
	return strings.Join(lines, "\n")
}
