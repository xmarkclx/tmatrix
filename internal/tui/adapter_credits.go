package tui

import (
	"context"
	"fmt"
	"math"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"tmatrix/internal/backend"
)

type creditRefreshResult struct{ err error }

func (m Model) refreshCredits() (tea.Model, tea.Cmd) {
	refresher, supported := m.backend.(backend.AdapterCreditRefresher)
	if !supported || m.snapshot.AdapterCredits == nil {
		m.failure = "Credit reporting is unavailable for this connection."
		return m, nil
	}
	if m.creditRefreshPending || m.snapshot.AdapterCredits.Refreshing {
		return m, nil
	}
	m.creditRefreshPending = true
	return m, func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		return creditRefreshResult{err: refresher.RefreshAdapterCredits(ctx)}
	}
}

func (m Model) creditRows() []string {
	credits := m.snapshot.AdapterCredits
	if credits == nil {
		return nil
	}
	name := ellipsis(credits.DisplayName, 12)
	if name == "" {
		name = "Runtime"
	}
	parts := []string{}
	if credits.Status == "ready" || credits.Status == "stale" {
		for _, window := range credits.Windows {
			percent := window.RemainingPercent
			if percent == nil || math.IsNaN(*percent) || math.IsInf(*percent, 0) || *percent < 0 || *percent > 100 {
				continue
			}
			parts = append(parts, fmt.Sprintf("%s %.0f%%", ellipsis(window.Label, 10), *percent))
		}
	}
	reading := strings.Join(parts, " | ")
	status := ""
	if len(parts) == 0 {
		reading = "unavailable"
	}
	if len(parts) > 0 {
		at, err := time.Parse(time.RFC3339Nano, credits.LastSuccessfulAt)
		if credits.Status == "stale" || m.connectionError != "" || err != nil || m.now.Sub(at) >= 2*time.Minute {
			status = " stale"
		}
	}
	if credits.Refreshing || m.creditRefreshPending {
		if len(parts) == 0 {
			reading = "checking"
		} else {
			status += " checking"
		}
	}
	style := mutedStyle
	if strings.Contains(status, "stale") {
		style = warningStyle
	}
	text := name + status + " " + reading
	if m.width >= 60 {
		text += "  [Ctrl+R] refresh"
	} else {
		text += "  ^R"
	}
	return []string{frameLine(" "+ellipsis(text, m.width-2), m.width, style)}
}
