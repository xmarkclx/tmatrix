package tui

import (
	"reflect"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"tmatrix/internal/config"
)

func TestRoutingPolicyChangesWithKeyboardAndMouse(t *testing.T) {
	m, b := testModel()
	m.width, m.height = 40, 16
	m.snapshot.RuntimeAdapter = "codex"
	m.snapshot.RuntimePolicy = config.SubscriptionsFirst
	m, _ = press(m, "s")
	m, _ = press(m, "tab")
	m, _ = press(m, "tab")
	if view := m.View(); !strings.Contains(view, "Routing policy") || !strings.Contains(view, "Subscriptions first") {
		t.Fatalf("routing field is not visible at compact size: %s", view)
	}
	m, _ = press(m, "right")
	if !strings.Contains(m.View(), "Claude first") {
		t.Fatal("right arrow did not select Claude first")
	}
	m, _ = clickTarget(t, m, "runtime-policy", "right", "", 0)
	if !strings.Contains(m.View(), "No credit fallback") {
		t.Fatal("next control did not select No credit fallback")
	}
	var cmd tea.Cmd
	m, cmd = press(m, "ctrl+s")
	_ = execute(m, cmd)
	if b.settings.RuntimePolicy == nil || *b.settings.RuntimePolicy != "subscriptions-only" {
		t.Fatalf("incorrect policy saved: %v", b.settings.RuntimePolicy)
	}
}

func TestSettingsSavePreservesPolicyChangedInAnotherConsole(t *testing.T) {
	m, b := testModel()
	m.snapshot.RuntimeAdapter = "codex"
	m.snapshot.RuntimePolicy = config.SubscriptionsFirst
	m, _ = press(m, "s")
	m.snapshot.RuntimePolicy = config.ClaudeFirst
	m.form[0].SetValue("5")
	m, cmd := press(m, "ctrl+s")
	_ = execute(m, cmd)
	if b.settings.RuntimePolicy != nil || b.settings.MaxWorkers == nil || *b.settings.MaxWorkers != 5 {
		t.Fatalf("saving concurrency overwrote runtime routing: %+v", b.settings)
	}
}

func TestRoutingPolicyCyclesAllOptions(t *testing.T) {
	m, _ := testModel()
	m.snapshot.RuntimeAdapter = "codex"
	m.snapshot.RuntimePolicy = config.SubscriptionsFirst
	m, _ = press(m, "s")
	m, _ = press(m, "tab")
	m, _ = press(m, "tab")
	var labels []string
	for range 6 {
		labels = append(labels, runtimePolicyChoices[m.runtimePolicyIndex()].label)
		m, _ = press(m, "enter")
	}
	if !reflect.DeepEqual(labels, []string{"Subscriptions first", "Claude first", "No credit fallback", "Codex only", "Claude only", "Subscriptions first"}) {
		t.Fatalf("routing policy choices changed: %q", labels)
	}
}
