package tui

import (
	"context"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"tmatrix/internal/backend"
)

type creditBackend struct {
	*fakeBackend
	refreshes int
}

func (b *creditBackend) RefreshAdapterCredits(context.Context) error { b.refreshes++; return b.err }
func creditModel() (Model, *creditBackend) {
	m, original := testModel()
	b := &creditBackend{fakeBackend: original}
	m.backend = b
	primary, secondary := 15.0, 21.0
	m.snapshot.AdapterCredits = &backend.AdapterCredits{AdapterID: "codex", DisplayName: "Codex", Status: "ready",
		LastSuccessfulAt: m.now.Format(time.RFC3339Nano), Windows: []backend.AdapterCreditWindow{
			{Label: "5h", RemainingPercent: &primary}, {Label: "7d", RemainingPercent: &secondary},
		}}
	return m, b
}
func refreshKey(m Model, paste bool) (Model, tea.Cmd) {
	result, cmd := m.Update(tea.KeyMsg{Type: tea.KeyCtrlR, Paste: paste})
	return result.(Model), cmd
}

func TestCreditRefreshIsGlobalAndPreservesEditorsAndBusyOperations(t *testing.T) {
	for _, mode := range []string{"composer", "settings", "connection", "confirmation", "matrix"} {
		t.Run(mode, func(t *testing.T) {
			m, b := creditModel()
			switch mode {
			case "composer":
				m, _ = press(m, "enter")
				m, _ = press(m, "Keep this draft")
			case "settings":
				m, _ = press(m, "s")
				m.form[0].Focus()
				m.form[0].SetValue("draft settings")
			case "connection":
				m, _ = press(m, "c")
				m.form[0].Focus()
				m.form[0].SetValue("draft connection")
			case "confirmation":
				m.confirmation = "a"
			case "matrix":
				m.matrix.active = true
			}
			m.busy = true
			m.pageOffset = 3
			m.viewport.YOffset = 2
			selected, draft, screen, confirmation := m.selected, m.composer.Value(), m.screen, m.confirmation
			formDraft := ""
			if len(m.form) > 0 {
				formDraft = m.form[0].Value()
			}
			m, cmd := refreshKey(m, false)
			if cmd == nil || !m.creditRefreshPending {
				t.Fatal("global shortcut did not request credits")
			}
			duplicate, duplicateCmd := refreshKey(m, false)
			if duplicateCmd != nil || !duplicate.creditRefreshPending {
				t.Fatal("pending action accepted a duplicate")
			}
			result, next := m.Update(cmd())
			m = result.(Model)
			if b.refreshes != 1 || m.creditRefreshPending || !m.busy || next != nil {
				t.Fatal("credit response disturbed worker operation or created another polling loop")
			}
			if m.selected != selected || m.composer.Value() != draft || m.screen != screen || m.confirmation != confirmation || m.pageOffset != 3 || m.viewport.YOffset != 2 {
				t.Fatal("refresh disturbed current reading or editor")
			}
			if len(m.form) > 0 && m.form[0].Value() != formDraft {
				t.Fatal("refresh lost a form draft")
			}
		})
	}
}

func TestCreditPasteDoesNotRefreshAndFailureDoesNotClearWorkerBusy(t *testing.T) {
	m, b := creditModel()
	m, cmd := refreshKey(m, true)
	if cmd != nil || m.creditRefreshPending || b.refreshes != 0 {
		t.Fatal("bracketed paste requested credits")
	}
	b.err = errors.New("refresh unavailable")
	m.busy = true
	m, cmd = refreshKey(m, false)
	m = execute(m, cmd)
	if !m.busy || m.creditRefreshPending || m.failure != "refresh unavailable" {
		t.Fatal("failure changed worker operation state")
	}
	legacy, _ := testModel()
	originalHeight := legacy.headerHeight()
	legacy, cmd = refreshKey(legacy, false)
	if cmd != nil || legacy.failure != "Credit reporting is unavailable for this connection." || len(legacy.creditRows()) != 0 || legacy.headerHeight() != originalHeight {
		t.Fatal("legacy adapter layout or unavailable behavior changed")
	}
}

func TestCreditRowKeepsQuotaAndMouseGeometryAtMinimumSize(t *testing.T) {
	m, _ := creditModel()
	m.width, m.height = 40, 16
	frame, targets := m.renderLayout()
	if !strings.Contains(frame, "Codex 5h 15% | 7d 21%") || !strings.Contains(frame, "^R") {
		t.Fatalf("narrow quota row missing: %s", frame)
	}
	lines := strings.Split(frame, "\n")
	if len(lines) != 16 {
		t.Fatalf("header geometry exceeds minimum height: %d", len(lines))
	}
	for _, line := range lines {
		if lipgloss.Width(line) != 40 {
			t.Fatalf("bad quota frame width: %d", lipgloss.Width(line))
		}
	}
	found := false
	for _, target := range targets {
		if target.action == "key" && target.key == "s" {
			if target.y != 3 {
				t.Fatalf("navigation mouse target did not move with quota row: %d", target.y)
			}
			found = true
		}
	}
	if !found {
		t.Fatal("settings mouse target disappeared")
	}
	m.snapshot.AdapterCredits.Status = "stale"
	if !strings.Contains(strings.Join(m.creditRows(), ""), "Codex stale 5h 15% | 7d 21%") {
		t.Fatal("stale indicator hid second quota window")
	}
}

func TestCreditWarningsRemainVisibleWhenQuotaReadingIsTruncated(t *testing.T) {
	m, _ := creditModel()
	m.width, m.height = 40, 16
	percent := 21.0
	m.snapshot.AdapterCredits.DisplayName = "A custom adapter with a long display name"
	m.snapshot.AdapterCredits.Windows = []backend.AdapterCreditWindow{
		{Label: "First long quota window label", RemainingPercent: &percent},
		{Label: "Second long quota window label", RemainingPercent: &percent},
		{Label: "Third long quota window label", RemainingPercent: &percent},
		{Label: "Fourth long quota window label", RemainingPercent: &percent},
	}
	m.snapshot.AdapterCredits.Status = "stale"
	m.snapshot.AdapterCredits.Refreshing = true
	row := strings.Join(m.creditRows(), "")
	if !strings.Contains(row, "stale checking") || lipgloss.Width(row) != 40 {
		t.Fatalf("truncated quota hid reporting state: %s", row)
	}
	m.snapshot.AdapterCredits.Status = "ready"
	m.snapshot.AdapterCredits.Refreshing = false
	m.connectionError = "offline"
	row = strings.Join(m.creditRows(), "")
	if !strings.Contains(row, "stale") || lipgloss.Width(row) != 40 {
		t.Fatalf("long adapter name hid connection-loss warning: %s", row)
	}
}

func TestCreditRowDistinguishesZeroMissingStaleAndChecking(t *testing.T) {
	m, _ := creditModel()
	zero, invalid := 0.0, math.NaN()
	m.snapshot.AdapterCredits.Windows = []backend.AdapterCreditWindow{{Label: "5h", RemainingPercent: &zero}, {Label: "missing"}, {Label: "invalid", RemainingPercent: &invalid}}
	if row := strings.Join(m.creditRows(), ""); !strings.Contains(row, "5h 0%") || strings.Contains(row, "missing") || strings.Contains(row, "NaN") {
		t.Fatalf("misrepresented reading: %s", row)
	}
	m.connectionError = "offline"
	if !strings.Contains(strings.Join(m.creditRows(), ""), "stale") {
		t.Fatal("connection loss presented fresh quota")
	}
	m.connectionError = ""
	m.now = m.now.Add(2 * time.Minute)
	if !strings.Contains(strings.Join(m.creditRows(), ""), "stale") {
		t.Fatal("aged quota presented as fresh")
	}
	m.snapshot.AdapterCredits.Status = "unavailable"
	if row := strings.Join(m.creditRows(), ""); !strings.Contains(row, "unavailable") || strings.Contains(row, "0%") {
		t.Fatal("missing data presented as zero")
	}
	m.snapshot.AdapterCredits.Refreshing = true
	if !strings.Contains(strings.Join(m.creditRows(), ""), "checking") {
		t.Fatal("initial check status hidden")
	}
	if !strings.Contains(m.helpView(), "Ctrl+R") {
		t.Fatal("refresh shortcut missing from help")
	}
}
