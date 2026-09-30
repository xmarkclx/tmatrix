package tui

import (
	"context"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"tmatrix/internal/config"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"tmatrix/internal/backend"
)

func fieldInput(value, placeholder string, secret bool) textinput.Model {
	input := textinput.New()
	input.SetValue(value)
	input.Placeholder = placeholder
	input.CharLimit = 4096
	input.Prompt = "  "
	input.TextStyle = bodyStyle
	input.PromptStyle = accentStyle
	input.PlaceholderStyle = mutedStyle
	input.Cursor.Style = cursorStyle
	input.Cursor.TextStyle = bodyStyle
	if secret {
		input.EchoMode = textinput.EchoPassword
		input.EchoCharacter = '•'
	}
	return input
}
func (m *Model) openForm(target screen) tea.Cmd {
	m.screen = target
	m.field = 0
	m.failure = ""
	m.notice = ""
	if target == connectScreen {
		endpoint := m.snapshot.Poller.URL
		if endpoint == "" {
			endpoint = "https://tzudo.app"
		}
		placeholder := "Paste key, or leave empty to reuse saved key"
		if m.options.Demo {
			placeholder = "Type any demo key; never use real credentials"
		}
		m.form = []textinput.Model{fieldInput(endpoint, "https://tzudo.app", false), fieldInput("", placeholder, true)}
	} else {
		maximum := m.snapshot.MaxWorkers
		if maximum < 1 {
			maximum = 3
		}
		interval := m.snapshot.PollIntervalMS
		if interval < 1 {
			interval = 5000
		}
		workerType := m.snapshot.RuntimeAdapter
		if workerType == "" {
			workerType = "codex"
		}
		m.form = []textinput.Model{fieldInput(strconv.Itoa(maximum), "3", false), fieldInput(strconv.Itoa(interval), "5000", false), fieldInput(workerType, "codex", false), fieldInput("tzudo", "tzudo", false)}
	}
	return nil
}
func (m *Model) focusField(index int) tea.Cmd {
	m.form[m.field].Blur()
	m.field = (index + len(m.form)) % len(m.form)
	return nil
}

// navigateForm keeps navigation independent of text input, including mouse clicks
// while editing. Leaving a form discards its unsaved values and credentials.
func (m *Model) navigateForm(name string) (bool, tea.Cmd) {
	switch name {
	case "w", "p", "s", "c", "?":
	default:
		return false, nil
	}
	if m.busy {
		return true, nil
	}
	if (name == "s" && m.screen == settingsScreen) || (name == "c" && m.screen == connectScreen) {
		return true, nil
	}
	m.form = nil
	m.failure = ""
	m.notice = ""
	m.pageOffset = 0
	switch name {
	case "w":
		m.screen = workersScreen
	case "p":
		m.screen = pollersScreen
	case "?":
		m.screen = helpScreen
	case "s":
		return true, m.openForm(settingsScreen)
	case "c":
		return true, m.openForm(connectScreen)
	}
	return true, nil
}
func (m *Model) submitForm() tea.Cmd {
	if m.busy {
		return nil
	}
	if m.screen == connectScreen {
		endpoint := strings.TrimRight(strings.TrimSpace(m.form[0].Value()), "/")
		key := strings.TrimSpace(m.form[1].Value())
		parsed, err := url.Parse(endpoint)
		if err != nil || config.ValidatePollURL(endpoint) != nil {
			m.failure = "Use an HTTPS server or poll URL without credentials, query or fragment."
			return nil
		}
		if parsed.Path == "" || parsed.Path == "/" {
			parsed.Path = "/api/v1/ai/poll"
			endpoint = parsed.String()
		}
		m.busy = true
		m.failure = ""
		m.notice = "Draining active workers, then saving connection and restarting intake…"
		return m.operation("connect", "", func(ctx context.Context) (string, error) {
			err := m.backend.Connect(ctx, backend.Connection{URL: endpoint, APIKey: key})
			if err != nil {
				if key == "" {
					return "", err
				}
				return "", errors.New(strings.ReplaceAll(err.Error(), key, "[redacted]"))
			}
			if m.options.Demo {
				return "Simulated connection saved in memory.", nil
			}
			return "Engine ready, intake started. Check Pollers for connection status.", nil
		})
	}
	maximum, err := strconv.Atoi(strings.TrimSpace(m.form[0].Value()))
	if err != nil || maximum < 1 || maximum > 100 {
		m.failure = "Max workers must be a whole number from 1 to 100."
		return nil
	}
	interval, err := strconv.Atoi(strings.TrimSpace(m.form[1].Value()))
	if err != nil || interval < 250 || interval > 300000 {
		m.failure = "Poll interval must be 250–300000 milliseconds."
		return nil
	}
	workerType := strings.TrimSpace(m.form[2].Value())
	pollerType := strings.TrimSpace(m.form[3].Value())
	currentAdapter := m.snapshot.RuntimeAdapter
	if currentAdapter == "" {
		currentAdapter = "codex"
	}
	if workerType != currentAdapter {
		m.failure = "Select worker_type and adapter_module in config.json, then restart the engine."
		return nil
	}
	if pollerType != "tzudo" {
		m.failure = "This release includes the tzudo poller. Additional pollers come later."
		return nil
	}
	m.busy = true
	m.failure = ""
	m.notice = "Saving settings…"
	settings := backend.Settings{MaxWorkers: &maximum, PollIntervalMS: &interval, WorkerType: &workerType, PollerType: &pollerType}
	return m.operation("settings", "", func(ctx context.Context) (string, error) {
		return "Settings saved; active workers keep their current conversation.", m.backend.Configure(ctx, settings)
	})
}
func (m *Model) toggleIntake() tea.Cmd {
	if m.busy {
		return nil
	}
	paused := !m.snapshot.IntakePaused
	m.busy = true
	m.failure = ""
	m.notice = "Updating intake…"
	return m.operation("intake", "", func(ctx context.Context) (string, error) {
		text := "Intake resumed; pollers may claim new tasks."
		if paused {
			text = "Intake paused. Running workers continue."
		}
		return text, m.backend.Configure(ctx, backend.Settings{IntakePaused: &paused})
	})
}
