package tui

import (
	"strings"
	"testing"
)

func TestSettingsHaveNoRoutingPolicy(t *testing.T) {
	m, _ := testModel()
	m.width, m.height = 60, 30
	m.snapshot.RuntimeAdapter = "codex"
	m, _ = press(m, "s")
	view := m.View()
	if strings.Contains(view, "Routing policy") || strings.Contains(view, "Subscriptions first") {
		t.Fatalf("settings still offer a routing policy: %s", view)
	}
}
