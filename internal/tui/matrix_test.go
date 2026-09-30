package tui

import (
	"fmt"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"strings"
	"testing"
	"time"
	"tmatrix/internal/backend"
)

func TestMatrixReplayAndExit(t *testing.T) {
	m, b := testModel()
	m, _ = press(m, "home")
	offset := m.viewport.YOffset
	m, cmd := press(m, "m")
	if cmd == nil || !m.matrix.active {
		t.Fatal("did not start animation")
	}
	if strings.Contains(m.View(), "Inspecting the project.") {
		t.Fatal("history appeared instantly")
	}
	for i := 0; i < 200; i++ {
		m.matrix.advance(m.matrix.lastFrame.Add(50*time.Millisecond), m.width, m.height)
	}
	if !strings.Contains(m.View(), "Inspecting the project.") {
		t.Fatal("history did not replay")
	}
	pending := len(m.matrix.pending)
	m.matrix.ingest(b.snapshot.Workers[0], m.width, time.Now())
	if len(m.matrix.pending) != pending {
		t.Fatal("snapshot duplicated messages")
	}
	b.snapshot.Workers[0].Activity = append(b.snapshot.Workers[0].Activity, backend.Activity{Sequence: 9, Kind: "message", Text: "NEW MESSAGE"})
	result, _ := m.Update(snapshotMsg{snapshot: b.snapshot})
	m = result.(Model)
	if strings.Contains(m.View(), "NEW MESSAGE") || len(m.matrix.pending) == 0 {
		t.Fatal("new message bypassed queue")
	}
	generation := m.matrix.generation
	m, _ = press(m, "esc")
	if m.matrix.active || m.viewport.YOffset != offset {
		t.Fatal("exit did not restore view")
	}
	m, _ = press(m, "m")
	result, cmd = m.Update(matrixTick{generation, time.Now()})
	if cmd != nil || len(result.(Model).matrix.visible) != 0 {
		t.Fatal("stale timer advanced new replay")
	}
}
func TestMatrixPacingAndWrapping(t *testing.T) {
	now := time.Now()
	slow := matrixPlayback{rate: 2, lastFrame: now, pending: []string{"one", "two", "three"}}
	fast := matrixPlayback{rate: 2, lastFrame: now, pending: make([]string, 300)}
	for i := 1; i <= 20; i++ {
		at := now.Add(time.Duration(i) * 50 * time.Millisecond)
		slow.advance(at, 40, 20)
		fast.advance(at, 40, 20)
	}
	if fast.rate <= slow.rate || fast.rate > 30 {
		t.Fatal("pace does not adapt within bounds")
	}
	p := matrixPlayback{rate: 30, lastFrame: now, pending: []string{"abcdefghijk", "second"}}
	for i := 1; i <= 80; i++ {
		p.advance(now.Add(time.Duration(i)*50*time.Millisecond), 4, 20)
	}
	if strings.Join(p.visible, "") != "abcdefghijksecond" {
		t.Fatalf("wrapping lost content: %q", p.visible)
	}
}
func TestMatrixIsolatedWorkerAndCanvas(t *testing.T) {
	m, b := testModel()
	m, _ = press(m, "m")
	b.snapshot.Workers = b.snapshot.Workers[1:]
	result, _ := m.Update(snapshotMsg{snapshot: b.snapshot})
	m = result.(Model)
	if m.matrix.workerID != "a" || m.matrix.status != "worker no longer active" {
		t.Fatal("replay switched workers")
	}
	m, _ = press(m, "x")
	m, _ = press(m, " ")
	m, _ = press(m, "right")
	if b.stops != 0 || m.confirmation != "" || m.matrix.workerID != "a" {
		t.Fatal("hidden controls are active")
	}
	for _, size := range [][2]int{{80, 24}, {40, 16}, {12, 4}, {1, 1}} {
		result, _ = m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		m = result.(Model)
		view := ansi.Strip(m.View())
		lines := strings.Split(view, "\n")
		if len(lines) != size[1] {
			t.Fatal("wrong canvas height")
		}
		for _, line := range lines {
			if lipgloss.Width(line) != size[0] {
				t.Fatalf("wrong row width: %q", line)
			}
		}
		if strings.ContainsAny(view, "╭╮╰╯│─") {
			t.Fatal("borders in Matrix mode")
		}
	}
}

func TestMatrixPausesWhenHiddenAndCountsWrappedBacklog(t *testing.T) {
	now := time.Now()
	p := matrixPlayback{rate: 2, lastFrame: now, pending: []string{strings.Repeat("a", 4000)}}
	p.advance(now.Add(50*time.Millisecond), 40, 1)
	if len(p.visible) != 0 || p.pending[0] != strings.Repeat("a", 4000) {
		t.Fatal("hidden history consumed")
	}
	p.advance(now.Add(100*time.Millisecond), 40, 20)
	if p.backlogRows < 99 || p.rate <= 2 {
		t.Fatal("wrapped backlog did not accelerate replay")
	}
}

func matrixFrames(m Model, count int) Model {
	for i := 0; i < count; i++ {
		updated, _ := m.Update(matrixTick{m.matrix.generation, m.matrix.lastFrame.Add(50 * time.Millisecond)})
		m = updated.(Model)
	}
	return m
}

func TestMatrixContinuesAfterFinalOutput(t *testing.T) {
	m, b := testModel()
	m, _ = press(m, "m")
	b.snapshot.Workers[0].Status = "completed"
	b.snapshot.Workers[0].Activity = append(b.snapshot.Workers[0].Activity, backend.Activity{Sequence: 22, Kind: "message", Text: "FINAL OUTPUT"})
	result, _ := m.Update(snapshotMsg{snapshot: b.snapshot})
	m = result.(Model)
	if m.matrix.workerID != "a" {
		t.Fatal("switched before queue drained")
	}
	for i := 0; i < 1000 && len(m.matrix.pending) > 0; i++ {
		m = matrixFrames(m, 1)
	}
	if m.matrix.workerID != "a" || !strings.Contains(m.View(), "FINAL OUTPUT") {
		t.Fatal("final output not presented before switching")
	}
	m = matrixFrames(m, 1)
	if !m.matrix.active || m.matrix.workerID != "b" || m.selected != "b" {
		t.Fatal("did not follow next task")
	}
	if !strings.Contains(m.View(), "FINAL OUTPUT") {
		t.Fatal("transition cleared previous rows")
	}
	m = matrixFrames(m, 100)
	if !strings.Contains(m.View(), "NEXT TASK") {
		t.Fatal("missing transition label")
	}
	m, _ = press(m, "esc")
	if m.matrix.active || m.selected != "b" {
		t.Fatal("exit did not return to current task")
	}
}

func TestMatrixWaitsAndResumesAfterEmptyQueue(t *testing.T) {
	m, b := testModel()
	m, _ = press(m, "m")
	next := b.snapshot.Workers[1]
	b.snapshot.Workers = nil
	result, _ := m.Update(snapshotMsg{snapshot: b.snapshot})
	m = result.(Model)
	m = matrixFrames(m, 200)
	if !m.matrix.active || m.matrix.workerID != "a" || !strings.Contains(m.matrixView(), "waiting for next task") {
		t.Fatal("did not wait in Matrix mode")
	}
	b.snapshot.Workers = []backend.Worker{next}
	result, _ = m.Update(snapshotMsg{snapshot: b.snapshot})
	m = result.(Model)
	m = matrixFrames(m, 1)
	if m.matrix.workerID != "b" {
		t.Fatal("did not resume with arriving task")
	}
}

func TestMatrixDoesNotSwitchOnConnectionFailureOrStopping(t *testing.T) {
	for _, status := range []string{"running", "stopping", "stop_unverified"} {
		m, b := testModel()
		m, _ = press(m, "m")
		b.snapshot.Workers[0].Status = status
		result, _ := m.Update(snapshotMsg{snapshot: b.snapshot})
		m = result.(Model)
		m = matrixFrames(m, 200)
		if m.matrix.workerID != "a" {
			t.Fatalf("switched from %s worker", status)
		}
		result, _ = m.Update(snapshotMsg{err: fmt.Errorf("offline")})
		m = result.(Model)
		m = matrixFrames(m, 100)
		if m.matrix.workerID != "a" {
			t.Fatal("switched on connection error")
		}
	}
}

func TestMatrixStartsRecentWithoutRequeueingHistory(t *testing.T) {
	for _, sequence := range []int64{0, 1} {
		m, b := testModel()
		w := &b.snapshot.Workers[0]
		w.InitialPrompt = &backend.InitialPrompt{Text: "OLD PROMPT"}
		w.Activity = []backend.Activity{{Sequence: sequence, Kind: "message", Text: "OLD OUTPUT"}, {Sequence: sequence * 2, Kind: "message", Text: "RECENT OUTPUT"}}
		w.Steering = []backend.Steering{{ID: "old", Status: "queued"}}
		result, _ := m.Update(snapshotMsg{snapshot: b.snapshot})
		m = result.(Model)
		m, _ = press(m, "m")
		queued := strings.Join(m.matrix.pending, "\n")
		if strings.Contains(queued, "OLD") || !strings.Contains(queued, "RECENT OUTPUT") || strings.Contains(queued, "queued") {
			t.Fatalf("wrong starting point: %q", queued)
		}
		m = matrixFrames(m, 200)
		result, _ = m.Update(snapshotMsg{snapshot: b.snapshot})
		m = result.(Model)
		if len(m.matrix.pending) != 0 {
			t.Fatal("historical snapshot queued again")
		}
		w.Activity = append(w.Activity, backend.Activity{Sequence: sequence * 3, Kind: "message", Text: "LIVE OUTPUT"})
		result, _ = m.Update(snapshotMsg{snapshot: b.snapshot})
		m = result.(Model)
		if !strings.Contains(strings.Join(m.matrix.pending, "\n"), "LIVE OUTPUT") {
			t.Fatal("new output lost")
		}
		m, _ = press(m, "esc")
		m, _ = press(m, "m")
		queued = strings.Join(m.matrix.pending, "\n")
		if strings.Contains(queued, "RECENT OUTPUT") || !strings.Contains(queued, "LIVE OUTPUT") {
			t.Fatal("reentry replayed history")
		}
	}
}

func TestMatrixRecentOnAutomaticSwitchAndLargeOutput(t *testing.T) {
	m, b := testModel()
	b.snapshot.Workers[1].Activity = []backend.Activity{{Sequence: 1, Text: "OLD NEXT TASK"}, {Sequence: 2, Text: strings.Repeat("old line\n", 100) + "LATEST TAIL"}}
	result, _ := m.Update(snapshotMsg{snapshot: b.snapshot})
	m = result.(Model)
	m, _ = press(m, "m")
	b.snapshot.Workers = b.snapshot.Workers[1:]
	result, _ = m.Update(snapshotMsg{snapshot: b.snapshot})
	m = result.(Model)
	for i := 0; i < 500 && m.matrix.workerID == "a"; i++ {
		m = matrixFrames(m, 1)
	}
	queued := strings.Join(m.matrix.pending, "\n")
	if m.matrix.workerID != "b" || strings.Contains(queued, "OLD NEXT TASK") || !strings.Contains(queued, "LATEST TAIL") || len(m.matrix.pending) > 11 {
		t.Fatalf("next task not near live: %q", queued)
	}
}

func TestMatrixEmptyActivityWaitsForFirstOutput(t *testing.T) {
	m, b := testModel()
	b.snapshot.Workers[0].Activity = nil
	b.snapshot.Workers[0].InitialPrompt = &backend.InitialPrompt{Text: "HISTORICAL PROMPT"}
	result, _ := m.Update(snapshotMsg{snapshot: b.snapshot})
	m = result.(Model)
	m, _ = press(m, "m")
	if len(m.matrix.pending) != 0 {
		t.Fatal("empty activity replayed prompt")
	}
	b.snapshot.Workers[0].Activity = []backend.Activity{{Sequence: 1, Text: "FIRST LIVE"}}
	result, _ = m.Update(snapshotMsg{snapshot: b.snapshot})
	m = result.(Model)
	if !strings.Contains(strings.Join(m.matrix.pending, "\n"), "FIRST LIVE") {
		t.Fatal("first output missing")
	}
}

func TestMatrixSkipsFinishedPinsWhenContinuing(t *testing.T) {
	m, b := testModel()
	b.snapshot.Workers[0].Status = "completed"
	b.snapshot.Workers[0].Pinned = true
	b.snapshot.Workers[1].Status = "failed"
	b.snapshot.Workers[1].Pinned = true
	updated, _ := m.Update(snapshotMsg{snapshot: b.snapshot})
	m = updated.(Model)
	m, _ = press(m, "m")
	m = matrixFrames(m, 300)
	if m.matrix.workerID != "a" || !strings.Contains(m.matrixView(), "waiting for next task") {
		t.Fatal("playback cycled through finished pins")
	}
	b.snapshot.Workers = append(b.snapshot.Workers, backend.Worker{ID: "live", Title: "Active task", Status: "running"})
	updated, _ = m.Update(snapshotMsg{snapshot: b.snapshot})
	m = updated.(Model)
	m = matrixFrames(m, 1)
	if m.matrix.workerID != "live" {
		t.Fatal("finished pin prevented automatic playback of active task")
	}
}
