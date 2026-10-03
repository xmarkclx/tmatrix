package tui

import (
	"crypto/sha256"
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
)

func activityStyle(kind string) (string, lipgloss.CompleteColor, lipgloss.CompleteColor) {
	parts := strings.Split(kind, ".")
	typeName := parts[len(parts)-1]
	switch {
	case typeName == "error" || strings.Contains(kind, "failed"):
		return "! ERROR", matrixPalette.ErrorBG, matrixPalette.ErrorText
	case typeName == "agent_message" || kind == "message" || strings.Contains(kind, "assistant"):
		return "💬 MESSAGE", matrixPalette.MessageBG, matrixPalette.Message
	case typeName == "command_execution":
		return "⚙ COMMAND", matrixPalette.ToolBG, matrixPalette.Tool
	case typeName == "file_change":
		return "⚙ FILES", matrixPalette.ToolBG, matrixPalette.Tool
	case typeName == "web_search":
		return "⚙ SEARCH", matrixPalette.ToolBG, matrixPalette.Tool
	case kind == "tool" || strings.Contains(kind, "tool"):
		return "⚙ TOOL", matrixPalette.ToolBG, matrixPalette.Tool
	case kind == "output" || strings.Contains(kind, "output"):
		return "✓ OUTPUT", matrixPalette.OutputBG, matrixPalette.Output
	case kind == "steering" || strings.HasPrefix(kind, "steering."):
		return "↳ STEERING", matrixPalette.SteeringBG, matrixPalette.Steering
	default:
		return "• " + strings.ToUpper(strings.ReplaceAll(kind, ".", " ")), matrixPalette.StatusBG, matrixPalette.Status
	}
}

func (m Model) activity() string {
	content, _ := m.renderActivity()
	return content
}

func (m Model) renderActivity() (string, []activitySpan) {
	worker := m.worker()
	if worker == nil {
		return "", nil
	}
	width := max(4, m.width-4)
	var cards []string
	var spans []activitySpan
	row := 0
	appendCard := func(key string, sequence int64, card string) {
		height := lipgloss.Height(card)
		spans = append(spans, activitySpan{key: key, sequence: sequence, start: row, height: height})
		cards = append(cards, card)
		row += height
	}
	appendCard("initial-prompt", 0, m.initialPromptCard(width))
	if len(worker.Activity) == 0 {
		appendCard("waiting", 0, mutedStyle.Render("Waiting for activity from this worker…"))
	}
	duplicates := map[string]int{}
	steeringCards := map[string]bool{}
	for _, event := range worker.Activity {
		if event.SteeringID != "" {
			steeringCards[event.SteeringID] = true
		}
		kind := single(event.Kind)
		if kind == "" {
			kind = "activity"
		}
		key := fmt.Sprintf("event:%d", event.Sequence)
		if event.Sequence <= 0 {
			// Older/mock adapters without sequence IDs still get stable text identity.
			hash := sha256.Sum256([]byte(event.At + "\x00" + event.Kind + "\x00" + event.Text))
			key = fmt.Sprintf("legacy:%x", hash[:12])
			duplicates[key]++
			key += fmt.Sprintf(":%d", duplicates[key])
		}
		appendCard(key, event.Sequence, renderActivityCard(kind, event.Text, event.At, width))
	}
	for _, steer := range worker.Steering {
		if steeringCards[steer.ID] {
			continue
		}
		if steer.Message != "" {
			appendCard("steering:"+steer.ID, 0, renderActivityCard("steering", steer.Message+"\n\n"+steeringLabel(steer.Status), "", width))
		} else {
			appendCard("steering:"+steer.ID, 0, mutedStyle.Render(textBlock("↳ "+steeringLabel(steer.Status), width)))
		}
	}
	return strings.Join(cards, "\n"), spans
}

func renderActivityCard(kind, text, at string, width int) string {
	label, bg, ink := activityStyle(kind)
	timestamp := "--:--:--"
	if parsed, err := time.Parse(time.RFC3339Nano, at); err == nil {
		timestamp = parsed.Local().Format("15:04:05")
	}
	inner := width - 4
	heading := ellipsis(label, max(1, inner-10))
	heading += strings.Repeat(" ", max(1, inner-lipgloss.Width(heading)-8)) + timestamp
	// One plain-text block lets every wrapped cell inherit the message surface.
	body := textBlock(text, inner)
	style := lipgloss.NewStyle().Width(width-2).Padding(0, 1).
		Border(lipgloss.RoundedBorder()).BorderForeground(ink).
		Background(bg).Foreground(ink)
	return paintSurface(style.Render(heading+"\n"+body), lipgloss.NewStyle().Foreground(ink).Background(bg))
}
