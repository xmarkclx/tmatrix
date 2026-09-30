package tui

import (
	"context"
	"errors"
	"fmt"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"strings"
	"testing"
	"tmatrix/internal/backend"
)

type fakeBackend struct {
	snapshot        backend.Snapshot
	message, worker string
	stops           int
	settings        backend.Settings
	connection      backend.Connection
	err             error
}

func (b *fakeBackend) Snapshot(context.Context) (backend.Snapshot, error) { return b.snapshot, b.err }
func (b *fakeBackend) Steer(_ context.Context, id, message string) (backend.Steering, error) {
	b.worker = id
	b.message = message
	return backend.Steering{ID: "s1", Status: "queued"}, b.err
}
func (b *fakeBackend) Stop(_ context.Context, id string) error {
	b.stops++
	b.worker = id
	return b.err
}
func (b *fakeBackend) Pin(_ context.Context, id string, pinned bool) error {
	b.worker = id
	if b.err == nil {
		for i := range b.snapshot.Workers {
			if b.snapshot.Workers[i].ID == id {
				b.snapshot.Workers[i].Pinned = pinned
			}
		}
	}
	return b.err
}
func (b *fakeBackend) Configure(_ context.Context, s backend.Settings) error {
	b.settings = s
	return b.err
}
func (b *fakeBackend) Connect(_ context.Context, c backend.Connection) error {
	b.connection = c
	return b.err
}
func testModel() (Model, *fakeBackend) {
	b := &fakeBackend{snapshot: backend.Snapshot{MaxWorkers: 4, RunningWorkers: 2, PollIntervalMS: 5000, IntakePaused: true, Poller: backend.Poller{Type: "tzudo", Status: "paused", URL: "https://tzudo.app"}, Workers: []backend.Worker{{ID: "a", Title: "Inspect worker activity", Status: "running", WorkerType: "codex", ThreadID: "thread-a", InputRevision: 2, Activity: []backend.Activity{{At: "2026-09-29T10:01:00Z", Kind: "tool", Text: "Inspecting the project."}}}, {ID: "b", Title: "Review keyboard behavior", Status: "running", WorkerType: "codex"}}}}
	m := New(b, Options{Demo: true})
	result, _ := m.Update(snapshotMsg{snapshot: b.snapshot})
	return result.(Model), b
}
func press(m Model, key string) (Model, tea.Cmd) {
	var msg tea.KeyMsg
	switch key {
	case "enter":
		msg = tea.KeyMsg{Type: tea.KeyEnter}
	case "esc":
		msg = tea.KeyMsg{Type: tea.KeyEsc}
	case "tab":
		msg = tea.KeyMsg{Type: tea.KeyTab}
	case "right":
		msg = tea.KeyMsg{Type: tea.KeyRight}
	case "home":
		msg = tea.KeyMsg{Type: tea.KeyHome}
	case "ctrl+s":
		msg = tea.KeyMsg{Type: tea.KeyCtrlS}
	default:
		msg = tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(key)}
	}
	result, cmd := m.Update(msg)
	return result.(Model), cmd
}
func execute(m Model, cmd tea.Cmd) Model {
	if cmd == nil {
		return m
	}
	result, _ := m.Update(cmd())
	return result.(Model)
}
func TestDraftsSurviveSelectionAndRefresh(t *testing.T) {
	m, b := testModel()
	m, _ = press(m, "enter")
	m, _ = press(m, "Keep the original conversation")
	m, _ = press(m, "esc")
	m, _ = press(m, "right")
	m, _ = press(m, "enter")
	m, _ = press(m, "Different worker draft")
	m, _ = press(m, "esc")
	result, _ := m.Update(snapshotMsg{snapshot: b.snapshot})
	m = result.(Model)
	m, _ = press(m, "1")
	m, _ = press(m, "enter")
	if m.composer.Value() != "Keep the original conversation" || m.drafts["b"] != "Different worker draft" {
		t.Fatal("per-worker draft lost")
	}
}
func TestQueuedSteeringDoesNotInventReceiptOrRevision(t *testing.T) {
	m, b := testModel()
	m, _ = press(m, "enter")
	m, _ = press(m, "Please check keyboard focus")
	var cmd tea.Cmd
	m, cmd = press(m, "enter")
	if b.message != "" {
		t.Fatal("backend called synchronously")
	}
	m = execute(m, cmd)
	if b.worker != "a" || b.message != "Please check keyboard focus" {
		t.Fatal("wrong conversation/message")
	}
	if !strings.Contains(m.notice, "queued") || strings.Contains(m.notice, "received by runtime") || m.worker().InputRevision != 2 {
		t.Fatal("invented receipt/revision")
	}
	if m.composing || m.composer.Value() != "" {
		t.Fatal("successful send retained editor")
	}
}
func TestStopRequiresConfirmationAndRetainsRuntimeState(t *testing.T) {
	m, b := testModel()
	m, _ = press(m, "x")
	if b.stops != 0 {
		t.Fatal("stop sent without confirmation")
	}
	m, _ = press(m, "n")
	if m.confirmation != "" {
		t.Fatal("cancel failed")
	}
	m, _ = press(m, "x")
	var cmd tea.Cmd
	m, cmd = press(m, "y")
	if b.stops != 0 {
		t.Fatal("stop called synchronously")
	}
	m = execute(m, cmd)
	if b.stops != 1 || m.worker().Status != "running" || !strings.Contains(m.notice, "Watch runtime status for confirmation") {
		t.Fatal("request treated as stopped")
	}
}
func TestMessageErrorKeepsDraft(t *testing.T) {
	m, b := testModel()
	b.err = errors.New("bridge unavailable")
	m, _ = press(m, "enter")
	m, _ = press(m, "keep my message")
	var cmd tea.Cmd
	m, cmd = press(m, "enter")
	m = execute(m, cmd)
	if !m.composing || m.composer.Value() != "keep my message" || m.failure != "bridge unavailable" {
		t.Fatal("failed send discarded input")
	}
}
func TestSettingsValidateThenReachBackend(t *testing.T) {
	m, b := testModel()
	m, _ = press(m, "s")
	m.form[0].SetValue("0")
	m, _ = press(m, "ctrl+s")
	if b.settings.MaxWorkers != nil || m.failure == "" {
		t.Fatal("invalid setting submitted")
	}
	m.form[0].SetValue("7")
	m.form[1].SetValue("250")
	var cmd tea.Cmd
	m, cmd = press(m, "ctrl+s")
	m = execute(m, cmd)
	if b.settings.MaxWorkers == nil || *b.settings.MaxWorkers != 7 || *b.settings.PollIntervalMS != 250 || *b.settings.WorkerType != "codex" || *b.settings.PollerType != "tzudo" {
		t.Fatal("settings did not reach backend")
	}
	if m.screen != workersScreen {
		t.Fatal("settings did not close")
	}
}
func TestCredentialsMaskedAndErrorsRedacted(t *testing.T) {
	m, b := testModel()
	m, _ = press(m, "c")
	m.form[1].SetValue("unit-test-secret")
	m.form[1].Blur()
	if strings.Contains(m.View(), "unit-test-secret") {
		t.Fatal("credential leaked in form")
	}
	b.err = errors.New("rejected unit-test-secret token")
	var cmd tea.Cmd
	m, cmd = press(m, "ctrl+s")
	m = execute(m, cmd)
	if strings.Contains(m.View(), "unit-test-secret") || !strings.Contains(m.failure, "[redacted]") {
		t.Fatal("credential leaked in error")
	}
	b.err = nil
	m, cmd = press(m, "ctrl+s")
	m = execute(m, cmd)
	if len(m.form) != 0 || m.screen != pollersScreen {
		t.Fatal("key retained after connect")
	}
}
func TestRefreshPreservesScrollAndSelectionByID(t *testing.T) {
	m, b := testModel()
	for i := 0; i < 40; i++ {
		b.snapshot.Workers[0].Activity = append(b.snapshot.Workers[0].Activity, backend.Activity{Text: fmt.Sprintf("event %d", i)})
	}
	next, _ := m.Update(snapshotMsg{snapshot: b.snapshot})
	m = next.(Model)
	m, _ = press(m, "home")
	before := m.viewport.YOffset
	b.snapshot.Workers[0].Activity = append(b.snapshot.Workers[0].Activity, backend.Activity{Text: "new event"})
	b.snapshot.Workers[0], b.snapshot.Workers[1] = b.snapshot.Workers[1], b.snapshot.Workers[0]
	next, _ = m.Update(snapshotMsg{snapshot: b.snapshot})
	m = next.(Model)
	if m.selected != "a" || m.viewport.YOffset != before || m.following {
		t.Fatal("refresh disrupted selection/scroll")
	}
	m, _ = press(m, "f")
	if !m.viewport.AtBottom() || !m.following {
		t.Fatal("follow did not resume")
	}
}
func TestResponsiveScreensAndTerminalEscapeFiltering(t *testing.T) {
	m, _ := testModel()
	m.snapshot.Workers[0].Title = "Unicode worker 界界界界界 and a deliberately long title"
	m.snapshot.Workers[0].Activity = []backend.Activity{{Kind: "tool", Text: "safe\x1b[2J\x1b]52;c;malicious\x07text\x00"}}
	for _, size := range [][2]int{{40, 16}, {60, 24}, {100, 30}, {140, 44}} {
		resized, _ := m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		m = resized.(Model)
		for _, target := range []screen{workersScreen, pollersScreen, settingsScreen, connectScreen, helpScreen} {
			if target == connectScreen || target == settingsScreen {
				m.openForm(target)
			} else {
				m.screen = target
			}
			view := m.View()
			lines := strings.Split(view, "\n")
			if len(lines) != size[1] {
				t.Fatalf("%v %v height %d", size, target, len(lines))
			}
			for _, line := range lines {
				if lipgloss.Width(line) > size[0] {
					t.Fatalf("%v screen %v overflow %d", size, target, lipgloss.Width(line))
				}
			}
			if strings.Contains(view, "malicious") || strings.Contains(view, "\x00") || strings.Contains(view, "\x1b[2J") {
				t.Fatal("unsafe terminal input passed through")
			}
		}
	}
	if !strings.Contains(m.activity(), "safetext") {
		t.Fatal("sanitized output lost content")
	}
}
func TestIntakeAndDetachDoNotStopWorkers(t *testing.T) {
	m, b := testModel()
	var cmd tea.Cmd
	m, cmd = press(m, " ")
	m = execute(m, cmd)
	if b.settings.IntakePaused == nil || *b.settings.IntakePaused || b.stops != 0 {
		t.Fatal("intake changed workers")
	}
	_, cmd = press(m, "q")
	if _, ok := cmd().(tea.QuitMsg); !ok || b.stops != 0 {
		t.Fatal("detach did not quit safely")
	}
}

func TestFailedAndUnknownSteeringNeverLookQueued(t *testing.T) {
	for _, status := range []string{"failed", "future_status"} {
		label := steeringLabel(status)
		if strings.Contains(label, "queued") || strings.Contains(label, "received by runtime") {
			t.Fatal(label)
		}
	}
}
func TestCompletedWorkersDoNotOfferUnsupportedContinuation(t *testing.T) {
	m, _ := testModel()
	m.snapshot.Workers[0].Status = "completed"
	m, _ = press(m, "enter")
	if m.composing || strings.Contains(m.View(), "Continue conversation") || strings.Contains(m.View(), "[Enter] Message") {
		t.Fatal("unsupported continuation advertised")
	}
}
func TestCompactHelpAndFormsKeepControlsReachable(t *testing.T) {
	m, _ := testModel()
	resized, _ := m.Update(tea.WindowSizeMsg{Width: 40, Height: 16})
	m = resized.(Model)
	m, _ = press(m, "?")
	m, _ = press(m, "end")
	if !strings.Contains(m.View(), "selecting.") {
		t.Fatalf("guide cannot reach last content: %s", m.View())
	}
	for _, target := range []screen{connectScreen, settingsScreen} {
		m.openForm(target)
		for index := range m.form {
			m.focusField(index)
			view := m.View()
			if !strings.Contains(view, "> ") {
				t.Fatalf("focused field %d hidden", index)
			}
		}
	}
}
func TestConnectNormalizesOriginAndRejectsInsecureURL(t *testing.T) {
	m, b := testModel()
	m, _ = press(m, "c")
	m.form[0].SetValue("http://tzudo.app")
	m, _ = press(m, "ctrl+s")
	if b.connection.URL != "" || m.failure == "" {
		t.Fatal("insecure URL submitted")
	}
	m.form[0].SetValue("https://tzudo.app")
	var cmd tea.Cmd
	m, cmd = press(m, "ctrl+s")
	m = execute(m, cmd)
	if b.connection.URL != "https://tzudo.app/api/v1/ai/poll" || b.connection.APIKey != "" {
		t.Fatal("origin/saved key not normalized")
	}
}
