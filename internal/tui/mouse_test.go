package tui

import (
	"fmt"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
	"tmatrix/internal/backend"
)

func targetFor(t *testing.T, m Model, action, key, worker string, field int) hitTarget {
	t.Helper()
	_, targets := m.renderLayout()
	for _, target := range targets {
		if target.action == action && (key == "" || target.key == key) && (worker == "" || target.workerID == worker) && (action != "field" || target.field == field) {
			if target.width <= 0 || target.height <= 0 || target.x < 0 || target.y < 0 || target.x+target.width > m.width || target.y+target.height > m.height {
				t.Fatalf("invisible or clipped target: %+v in %dx%d", target, m.width, m.height)
			}
			return target
		}
	}
	t.Fatalf("missing %s target (key %q, worker %q, field %d) in:\n%s", action, key, worker, field, ansi.Strip(m.View()))
	return hitTarget{}
}

func mouseAt(m Model, target hitTarget, button tea.MouseButton, action tea.MouseAction) (Model, tea.Cmd) {
	next, cmd := m.Update(tea.MouseMsg{X: target.x + target.width/2, Y: target.y + target.height/2, Button: button, Action: action})
	return next.(Model), cmd
}

func clickTarget(t *testing.T, m Model, action, key, worker string, field int) (Model, tea.Cmd) {
	t.Helper()
	return mouseAt(m, targetFor(t, m, action, key, worker, field), tea.MouseButtonLeft, tea.MouseActionPress)
}

// Locate text in the rendered view rather than assuming a fixed terminal row.
func clickText(t *testing.T, m Model, text string) (Model, tea.Cmd) {
	t.Helper()
	for row, line := range strings.Split(ansi.Strip(m.View()), "\n") {
		if index := strings.Index(line, text); index >= 0 {
			next, cmd := m.Update(tea.MouseMsg{X: ansi.StringWidth(line[:index]) + ansi.StringWidth(text)/2, Y: row, Button: tea.MouseButtonLeft, Action: tea.MouseActionPress})
			return next.(Model), cmd
		}
	}
	t.Fatalf("visible control %q missing", text)
	return m, nil
}

func TestMouseNavigationTracksVisibleLabelsAfterResize(t *testing.T) {
	for _, size := range [][2]int{{40, 16}, {60, 24}, {110, 34}} {
		for _, nav := range []struct {
			label string
			page  screen
		}{{"[p]", pollersScreen}, {"[s]", settingsScreen}, {"[?]", helpScreen}} {
			t.Run(fmt.Sprintf("%dx%d/%s", size[0], size[1], nav.label), func(t *testing.T) {
				m, _ := testModel()
				next, _ := m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
				m, _ = clickText(t, next.(Model), nav.label)
				if m.screen != nav.page {
					t.Fatalf("clicked %s, reached screen %d", nav.label, m.screen)
				}
			})
		}
	}
}

func TestMouseWorkerCardsPreserveEmojiDrafts(t *testing.T) {
	m, b := testModel()
	m.snapshot.Workers[0].Title = "👩🏽‍💻 Inspect activity"
	m.snapshot.Workers[1].Title = "🚀 Review behavior"
	next, _ := m.Update(tea.WindowSizeMsg{Width: 110, Height: 34})
	m = next.(Model)
	m, _ = clickText(t, m, "🚀")
	if m.selected != "b" {
		t.Fatal("wide emoji card click missed the second worker")
	}
	m, _ = clickTarget(t, m, "key", "enter", "", 0)
	m, _ = press(m, "Keep 👩🏽‍💻 together")
	m, _ = clickTarget(t, m, "worker", "", "a", 0)
	if m.selected != "a" || !m.composing || m.drafts["b"] != "Keep 👩🏽‍💻 together" {
		t.Fatal("clicking a worker lost its draft or editor state")
	}
	m, _ = press(m, "A second draft 🚀")
	m, _ = clickTarget(t, m, "worker", "", "b", 0)
	if m.composer.Value() != "Keep 👩🏽‍💻 together" || m.drafts["a"] != "A second draft 🚀" || b.message != "" {
		t.Fatal("worker switch changed draft content or submitted it")
	}
	// Busy sends pin the selected worker until the result returns.
	m.busy = true
	m, _ = clickTarget(t, m, "worker", "", "a", 0)
	if m.selected != "b" {
		t.Fatal("mouse switched workers during a pending operation")
	}
}

func TestMouseCompletedCardRetainsDraftWithoutOfferingSend(t *testing.T) {
	m, b := testModel()
	m.snapshot.Workers[1].Status = "completed"
	m, _ = clickTarget(t, m, "key", "enter", "", 0)
	m, _ = press(m, "Still editing ✅")
	m, _ = clickTarget(t, m, "worker", "", "b", 0)
	if m.selected != "b" || m.composing || m.drafts["a"] != "Still editing ✅" || b.message != "" {
		t.Fatal("completed worker kept an active sender or discarded the previous draft")
	}
	_, targets := m.renderLayout()
	for _, target := range targets {
		if target.action == "key" && (target.key == "enter" || target.key == "x") {
			t.Fatal("completed worker exposed an unsupported message or stop control")
		}
	}
}

func TestMouseFooterIntakeAndDetachDoNotStopWorkers(t *testing.T) {
	m, b := testModel()
	m, cmd := clickTarget(t, m, "key", " ", "", 0)
	m = execute(m, cmd)
	if b.settings.IntakePaused == nil || *b.settings.IntakePaused || b.stops != 0 {
		t.Fatal("mouse intake toggle changed a worker")
	}
	_, cmd = clickTarget(t, m, "key", "q", "", 0)
	if cmd == nil {
		t.Fatal("mouse detach did not return a command")
	}
	if _, ok := cmd().(tea.QuitMsg); !ok || b.stops != 0 {
		t.Fatal("mouse detach failed or stopped a worker")
	}
}

func TestMouseSendCancelAndStopRequireExplicitActions(t *testing.T) {
	m, b := testModel()
	m, _ = clickTarget(t, m, "key", "enter", "", 0)
	m, _ = press(m, "Please check emoji ✅")
	m, _ = clickTarget(t, m, "key", "esc", "", 0)
	if m.composing || m.drafts["a"] != "Please check emoji ✅" || b.message != "" {
		t.Fatal("cancel did not preserve unsent draft")
	}
	m, _ = clickTarget(t, m, "key", "enter", "", 0)
	var cmd tea.Cmd
	m, cmd = clickTarget(t, m, "key", "enter", "", 0)
	if !m.busy || b.message != "" || cmd == nil {
		t.Fatal("send was not queued through the normal operation")
	}
	m = execute(m, cmd)
	if b.message != "Please check emoji ✅" || b.worker != "a" || m.composing {
		t.Fatal("mouse send lost text or conversation")
	}
	m, _ = clickTarget(t, m, "key", "x", "", 0)
	if m.confirmation != "a" || b.stops != 0 {
		t.Fatal("stop skipped confirmation")
	}
	// Worker cards remain visible behind confirmation but cannot change its target.
	m, _ = clickTarget(t, m, "worker", "", "b", 0)
	if m.selected != "a" || m.confirmation != "a" {
		t.Fatal("confirmation allowed a click through")
	}
	m, _ = clickTarget(t, m, "key", "n", "", 0)
	if m.confirmation != "" || b.stops != 0 {
		t.Fatal("cancel requested a stop")
	}
	m, _ = clickTarget(t, m, "key", "x", "", 0)
	m, cmd = clickTarget(t, m, "key", "y", "", 0)
	m = execute(m, cmd)
	if b.stops != 1 || b.worker != "a" || m.worker().Status != "running" {
		t.Fatal("stop did not use original worker or invented a stopped receipt")
	}
}

func TestMouseFormsFocusValidateSaveAndCancel(t *testing.T) {
	m, b := testModel()
	m, _ = clickTarget(t, m, "key", "s", "", 0)
	m.form[0].SetValue("8")
	m, _ = clickTarget(t, m, "field", "", "", 1)
	if m.field != 1 || m.form[1].Focused() || m.form[0].Focused() {
		t.Fatal("field click should select without editing")
	}
	m.form[1].SetValue("0")
	m, _ = clickTarget(t, m, "key", "ctrl+s", "", 0)
	if m.failure == "" || b.settings.MaxWorkers != nil {
		t.Fatal("mouse save bypassed form validation")
	}
	m.form[1].SetValue("500")
	var cmd tea.Cmd
	m, cmd = clickTarget(t, m, "key", "ctrl+s", "", 0)
	m = execute(m, cmd)
	if m.screen != workersScreen || b.settings.MaxWorkers == nil || *b.settings.MaxWorkers != 8 || *b.settings.PollIntervalMS != 500 {
		t.Fatal("saved settings did not reach the existing backend")
	}
	m, _ = clickTarget(t, m, "key", "c", "", 0)
	m, _ = clickTarget(t, m, "field", "", "", 1)
	m.form[1].SetValue("fictional-test-key")
	m, _ = clickTarget(t, m, "key", "esc", "", 0)
	if m.screen != workersScreen || len(m.form) != 0 || b.connection.URL != "" {
		t.Fatal("connection cancel retained credential or submitted it")
	}
}

func TestMouseCompactFormCanFocusVisibleField(t *testing.T) {
	m, _ := testModel()
	next, _ := m.Update(tea.WindowSizeMsg{Width: 40, Height: 16})
	m = next.(Model)
	m.openForm(settingsScreen)
	m.focusField(3)
	m, _ = clickText(t, m, "tzudo")
	if m.field != 3 || m.form[3].Focused() {
		t.Fatal("a visible input row was not clickable after compact form scrolling")
	}
}

func TestMouseWheelOnlyScrollsVisibleContent(t *testing.T) {
	m, _ := testModel()
	for index := 0; index < 30; index++ {
		m.snapshot.Workers[0].Activity = append(m.snapshot.Workers[0].Activity, backend.Activity{Kind: "message", Text: fmt.Sprintf("Activity %d", index)})
	}
	m.syncActivity()
	before := m.viewport.YOffset
	nav := targetFor(t, m, "key", "p", "", 0)
	m, _ = mouseAt(m, nav, tea.MouseButtonWheelUp, tea.MouseActionPress)
	if m.viewport.YOffset != before || !m.following {
		t.Fatal("wheel over navigation scrolled the transcript")
	}
	content := targetFor(t, m, "scroll", "", "", 0)
	m, _ = mouseAt(m, content, tea.MouseButtonWheelUp, tea.MouseActionPress)
	if m.viewport.YOffset >= before || m.following {
		t.Fatal("wheel over transcript did not scroll/pause follow")
	}
	m, _ = clickTarget(t, m, "key", "f", "", 0)
	if !m.following || !m.viewport.AtBottom() {
		t.Fatal("follow button did not return to latest activity")
	}
	m, _ = press(m, "?")
	next, _ := m.Update(tea.WindowSizeMsg{Width: 40, Height: 16})
	m = next.(Model)
	content = targetFor(t, m, "scroll", "", "", 0)
	m, _ = mouseAt(m, content, tea.MouseButtonWheelDown, tea.MouseActionPress)
	if m.pageOffset == 0 {
		t.Fatal("wheel could not scroll compact help")
	}
}

func TestMouseIgnoresReleaseMotionRightClickAndPadding(t *testing.T) {
	for _, event := range []struct {
		button tea.MouseButton
		action tea.MouseAction
	}{{tea.MouseButtonLeft, tea.MouseActionRelease}, {tea.MouseButtonLeft, tea.MouseActionMotion}, {tea.MouseButtonRight, tea.MouseActionPress}} {
		m, _ := testModel()
		m, _ = mouseAt(m, targetFor(t, m, "key", "enter", "", 0), event.button, event.action)
		if m.composing {
			t.Fatalf("non-click event activated composer: %+v", event)
		}
	}
	m, _ := testModel()
	next, _ := m.Update(tea.MouseMsg{X: m.width + 1, Y: 2, Button: tea.MouseButtonLeft, Action: tea.MouseActionPress})
	m = next.(Model)
	if m.screen != workersScreen || m.composing {
		t.Fatal("outside click activated a control")
	}
}

func TestMouseOverflowKeepsSelectedWorkerReachable(t *testing.T) {
	m, _ := testModel()
	for index := 2; index < 12; index++ {
		m.snapshot.Workers = append(m.snapshot.Workers, backend.Worker{ID: fmt.Sprintf("worker-%d", index), Title: "👩🏽‍💻 Wide worker title", Status: "running"})
	}
	for _, width := range []int{40, 60, 110} {
		next, _ := m.Update(tea.WindowSizeMsg{Width: width, Height: 24})
		m = next.(Model)
		m.selectWorker(0)
		for index := 1; index < len(m.snapshot.Workers); index++ {
			m, _ = clickTarget(t, m, "key", "right", "", 0)
			if m.selected != m.snapshot.Workers[index].ID {
				t.Fatalf("%d-column overflow selected %s, want worker %d", width, m.selected, index)
			}
			selected := targetFor(t, m, "worker", "", m.selected, 0)
			m, _ = mouseAt(m, selected, tea.MouseButtonLeft, tea.MouseActionPress)
			if m.selected != m.snapshot.Workers[index].ID {
				t.Fatal("selected card is not clickable after overflow scroll")
			}
		}
	}
}
