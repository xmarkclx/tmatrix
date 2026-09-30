package tui

import (
	"fmt"
	"regexp"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
	"tmatrix/internal/backend"
)

func scrollEvents(worker string, first, last int) []backend.Activity {
	events := make([]backend.Activity, 0, max(0, last-first+1))
	for sequence := first; sequence <= last; sequence++ {
		events = append(events, backend.Activity{
			Sequence: int64(sequence), At: "2026-09-29T10:01:00Z", Kind: "message",
			Text: fmt.Sprintf("%s event %02d first line\n%s event %02d reading line\n%s event %02d last line", worker, sequence, worker, sequence, worker, sequence),
		})
	}
	return events
}

// Build fresh slices, as a decoded HTTP snapshot would, so refreshes cannot
// accidentally modify the model's previous snapshot before Update sees it.
func scrollSnapshot(m Model) backend.Snapshot {
	snapshot := m.snapshot
	snapshot.Workers = append([]backend.Worker(nil), snapshot.Workers...)
	for i := range snapshot.Workers {
		snapshot.Workers[i].Activity = append([]backend.Activity(nil), snapshot.Workers[i].Activity...)
		snapshot.Workers[i].Steering = append([]backend.Steering(nil), snapshot.Workers[i].Steering...)
	}
	return snapshot
}

func scrollRefresh(m Model, snapshot backend.Snapshot) Model {
	next, _ := m.Update(snapshotMsg{snapshot: snapshot})
	return next.(Model)
}

func scrollModel(count int) Model {
	m, _ := testModel()
	snapshot := scrollSnapshot(m)
	for i := range snapshot.Workers {
		snapshot.Workers[i].Activity = scrollEvents(snapshot.Workers[i].ID, 1, count)
	}
	return scrollRefresh(m, snapshot)
}

func scrollKey(m Model, key tea.KeyType) Model {
	next, _ := m.Update(tea.KeyMsg{Type: key})
	return next.(Model)
}

func scrollTop(m Model) string {
	line := strings.Split(ansi.Strip(m.viewport.View()), "\n")[0]
	return strings.Trim(line, " │║┃")
}

// Reach a real text row using navigation, without relying on card heights or
// any private anchor representation introduced by the scrolling implementation.
func scrollToLine(t *testing.T, m Model, text string) Model {
	t.Helper()
	index := -1
	for i, line := range strings.Split(ansi.Strip(m.activity()), "\n") {
		if strings.Contains(line, text) {
			index = i
			break
		}
	}
	if index < 0 {
		t.Fatalf("fixture row %q missing from activity", text)
	}
	m = scrollKey(m, tea.KeyHome)
	for range index {
		m = scrollKey(m, tea.KeyDown)
	}
	if scrollTop(m) != text || m.following {
		t.Fatalf("could not pause on fixture row %q: top=%q following=%t", text, scrollTop(m), m.following)
	}
	return m
}

func TestScrollAppendPreservesReadingPosition(t *testing.T) {
	for _, key := range []tea.KeyType{tea.KeyUp, tea.KeyPgUp, tea.KeyHome} {
		t.Run(tea.KeyMsg{Type: key}.String(), func(t *testing.T) {
			m := scrollModel(20)
			m = scrollKey(m, key)
			if m.following {
				t.Fatal("upward navigation did not pause following")
			}
			before := ansi.Strip(m.viewport.View())
			snapshot := scrollSnapshot(m)
			snapshot.Workers[0].Activity = append(snapshot.Workers[0].Activity, scrollEvents("a", 21, 23)...)
			m = scrollRefresh(m, snapshot)
			if m.following || ansi.Strip(m.viewport.View()) != before {
				t.Fatal("new activity pulled the reader away from the paused rows")
			}
		})
	}
}

func TestScrollRetainedWindowPreservesEventAndLine(t *testing.T) {
	m := scrollToLine(t, scrollModel(20), "a event 07 reading line")
	before := ansi.Strip(m.viewport.View())
	offset := m.viewport.YOffset
	snapshot := scrollSnapshot(m)
	snapshot.Workers[0].Activity = scrollEvents("a", 4, 23)
	m = scrollRefresh(m, snapshot)
	if m.following || ansi.Strip(m.viewport.View()) != before || m.viewport.YOffset >= offset {
		t.Fatalf("ring trimming moved the reader: top=%q offset=%d, previously %d", scrollTop(m), m.viewport.YOffset, offset)
	}
}

func TestScrollExpiredAnchorFallsToOldestRetainedActivity(t *testing.T) {
	m := scrollToLine(t, scrollModel(20), "a event 07 reading line")
	snapshot := scrollSnapshot(m)
	snapshot.Workers[0].Activity = scrollEvents("a", 10, 29)
	m = scrollRefresh(m, snapshot)
	visible := strings.Split(ansi.Strip(m.viewport.View()), "\n")
	if m.following || !strings.Contains(strings.Join(visible[:min(3, len(visible))], "\n"), "a event 10 first line") {
		t.Fatalf("expired anchor did not land on oldest retained activity: top=%q, offset=%d", scrollTop(m), m.viewport.YOffset)
	}
	if !strings.Contains(ansi.Strip(m.View()), "Earlier activity expired") {
		t.Fatal("reader was not told that the previous activity expired")
	}
	before := ansi.Strip(m.viewport.View())
	m = scrollRefresh(m, snapshot)
	if m.following || ansi.Strip(m.viewport.View()) != before {
		t.Fatal("identical snapshot moved reader after expiry fallback")
	}
}

func TestScrollWorkerStateSurvivesSwitchAndSnapshotReorder(t *testing.T) {
	m := scrollToLine(t, scrollModel(20), "a event 07 reading line")
	m, _ = clickTarget(t, m, "worker", "", "b", 0)
	if !m.following || !m.viewport.AtBottom() {
		t.Fatal("first visit to another worker did not follow its latest activity")
	}
	m = scrollToLine(t, m, "b event 05 reading line")
	snapshot := scrollSnapshot(m)
	for i := range snapshot.Workers {
		worker := &snapshot.Workers[i]
		worker.Activity = append(worker.Activity, scrollEvents(worker.ID, 21, 22)...)
		if worker.ID == "a" {
			worker.Activity = worker.Activity[3:]
		}
	}
	snapshot.Workers[0], snapshot.Workers[1] = snapshot.Workers[1], snapshot.Workers[0]
	m = scrollRefresh(m, snapshot)
	if m.selected != "b" || m.following || scrollTop(m) != "b event 05 reading line" {
		t.Fatal("reordering a snapshot moved the selected worker or its reading position")
	}
	m, _ = clickTarget(t, m, "worker", "", "a", 0)
	if m.following || scrollTop(m) != "a event 07 reading line" {
		t.Fatal("returning to a paused worker lost its reading position")
	}
	m, _ = press(m, "f")
	m, _ = clickTarget(t, m, "worker", "", "b", 0)
	if m.following || scrollTop(m) != "b event 05 reading line" {
		t.Fatal("resuming one worker changed another worker's paused state")
	}
	m, _ = clickTarget(t, m, "worker", "", "a", 0)
	if !m.following || !m.viewport.AtBottom() {
		t.Fatal("returning to a following worker failed to show latest activity")
	}
}

func TestScrollResizePreservesReadingLineWhenEarlierCardsRewrap(t *testing.T) {
	m := scrollModel(20)
	snapshot := scrollSnapshot(m)
	for i := 0; i < 6; i++ {
		snapshot.Workers[0].Activity[i].Text = strings.Repeat("Long earlier activity that must wrap differently. ", 3)
	}
	m = scrollRefresh(m, snapshot)
	m = scrollToLine(t, m, "a event 07 reading line")
	for _, size := range [][2]int{{60, 24}, {110, 38}, {80, 30}} {
		next, _ := m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		m = next.(Model)
		if m.following || scrollTop(m) != "a event 07 reading line" {
			t.Fatalf("resize to %dx%d lost the reading line: %q", size[0], size[1], scrollTop(m))
		}
	}
}

func TestScrollFollowControlsResumeAndTrackLaterActivity(t *testing.T) {
	for _, control := range []string{"f", "end", "click"} {
		t.Run(control, func(t *testing.T) {
			m := scrollToLine(t, scrollModel(20), "a event 07 reading line")
			switch control {
			case "f":
				m, _ = press(m, "f")
			case "end":
				m = scrollKey(m, tea.KeyEnd)
			case "click":
				m, _ = clickTarget(t, m, "key", "f", "", 0)
			}
			if !m.following || !m.viewport.AtBottom() {
				t.Fatal("follow control did not resume at the latest activity")
			}
			snapshot := scrollSnapshot(m)
			snapshot.Workers[0].Activity = append(snapshot.Workers[0].Activity, scrollEvents("a", 21, 22)...)
			m = scrollRefresh(m, snapshot)
			if !m.following || !m.viewport.AtBottom() || !strings.Contains(ansi.Strip(m.viewport.View()), "a event 22 last line") {
				t.Fatal("resumed following failed to track newly appended activity")
			}
		})
	}
}

func TestScrollUpPausesEvenWhenAllCurrentActivityFits(t *testing.T) {
	for _, control := range []string{"up", "pgup", "wheel"} {
		t.Run(control, func(t *testing.T) {
			m := scrollModel(1)
			next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 40})
			m = next.(Model)
			if !m.viewport.AtTop() || !m.viewport.AtBottom() {
				t.Fatal("fixture must fit inside the viewport")
			}
			switch control {
			case "up":
				m = scrollKey(m, tea.KeyUp)
			case "pgup":
				m = scrollKey(m, tea.KeyPgUp)
			case "wheel":
				m, _ = mouseAt(m, targetFor(t, m, "scroll", "", "", 0), tea.MouseButtonWheelUp, tea.MouseActionPress)
			}
			if m.following {
				t.Fatal("upward reading intent was ignored because the content fits")
			}
			snapshot := scrollSnapshot(m)
			snapshot.Workers[0].Activity = append(snapshot.Workers[0].Activity, scrollEvents("a", 2, 20)...)
			m = scrollRefresh(m, snapshot)
			if m.following || !m.viewport.AtTop() || !strings.Contains(ansi.Strip(m.viewport.View()), "a event 01 first line") {
				t.Fatal("new activity pulled the reader from the previously fitting transcript")
			}
		})
	}
}

func TestScrollPagingDuringCompositionPreservesDraft(t *testing.T) {
	m := scrollModel(20)
	m, _ = press(m, "enter")
	draft := "Keep this draft 👩🏽‍💻 while I check previous output"
	m, _ = press(m, draft)
	bottom := m.viewport.YOffset
	m = scrollKey(m, tea.KeyPgUp)
	if !m.composing || m.following || m.viewport.YOffset >= bottom || m.composer.Value() != draft {
		t.Fatal("Page Up did not scroll the transcript independently of the draft")
	}
	before := ansi.Strip(m.viewport.View())
	snapshot := scrollSnapshot(m)
	snapshot.Workers[0].Activity = append(snapshot.Workers[0].Activity, scrollEvents("a", 21, 24)...)
	m = scrollRefresh(m, snapshot)
	if !m.composing || m.composer.Value() != draft || ansi.Strip(m.viewport.View()) != before {
		t.Fatal("snapshot moved the composer reader or lost the draft")
	}
	offset := m.viewport.YOffset
	m = scrollKey(m, tea.KeyPgDown)
	if !m.composing || m.viewport.YOffset <= offset || m.composer.Value() != draft {
		t.Fatal("Page Down did not scroll independently of the draft")
	}
	m, _ = clickTarget(t, m, "key", "f", "", 0)
	if !m.composing || !m.following || !m.viewport.AtBottom() || m.composer.Value() != draft {
		t.Fatal("clicking Follow latest during composition lost editor state")
	}
	m, _ = press(m, "esc")
	if m.drafts[m.selected] != draft {
		t.Fatal("scroll navigation changed the saved draft")
	}
}

func TestScrollNewActivityCountSurvivesRepeatedSnapshots(t *testing.T) {
	m := scrollToLine(t, scrollModel(20), "a event 07 reading line")
	snapshot := scrollSnapshot(m)
	snapshot.Workers[0].Activity = append(snapshot.Workers[0].Activity, scrollEvents("a", 21, 22)...)
	for range 3 {
		m = scrollRefresh(m, snapshot)
		if !regexp.MustCompile(`\b2 new\b`).MatchString(ansi.Strip(m.View())) {
			t.Fatalf("paused view should show exactly two new activity entries:\n%s", ansi.Strip(m.View()))
		}
	}
	snapshot.Workers[0].Activity = append(append([]backend.Activity(nil), snapshot.Workers[0].Activity...), scrollEvents("a", 23, 23)...)
	m = scrollRefresh(m, snapshot)
	if !regexp.MustCompile(`\b3 new\b`).MatchString(ansi.Strip(m.View())) {
		t.Fatal("new activity count did not advance with a new sequence")
	}
	m, _ = press(m, "f")
	if !m.following || regexp.MustCompile(`\b[1-9][0-9]* new\b`).MatchString(ansi.Strip(m.View())) {
		t.Fatal("resuming following did not clear the new activity count")
	}
}
