package tui

import (
	"strings"
	"unicode/utf8"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
	"github.com/rivo/uniseg"
)

type inputGrapheme struct {
	text       string
	start, end int // Bubbles positions are rune offsets, not byte offsets.
	width      int
}

func inputGraphemes(value string) []inputGrapheme {
	var clusters []inputGrapheme
	position := 0
	iterator := uniseg.NewGraphemes(value)
	for iterator.Next() {
		text := iterator.Str()
		next := position + utf8.RuneCountInString(text)
		clusters = append(clusters, inputGrapheme{text, position, next, iterator.Width()})
		position = next
	}
	return clusters
}

// Bubbles v0.21 edits and scrolls by rune. Treat an emoji sequence, combining
// character, or flag as one character so editing never leaves half a glyph.
func updateComposer(input textinput.Model, message tea.Msg) (textinput.Model, tea.Cmd) {
	previous := input.Position()
	// Restoring a draft through SetValue can retain the old worker's rune
	// position. Normalize it before a delete slices the replacement text.
	for _, cluster := range inputGraphemes(input.Value()) {
		if previous > cluster.start && previous < cluster.end {
			previous = cluster.end
			input.SetCursor(previous)
			break
		}
	}
	if key, ok := message.(tea.KeyMsg); ok && input.Focused() {
		clusters := inputGraphemes(input.Value())
		before, after := 0, utf8.RuneCountInString(input.Value())
		for _, cluster := range clusters {
			if cluster.start < previous {
				before = cluster.start
			}
			if cluster.end > previous {
				after = cluster.end
				break
			}
		}
		switch key.String() {
		case "left", "ctrl+b":
			input.SetCursor(before)
			return input, nil
		case "right", "ctrl+f":
			input.SetCursor(after)
			return input, nil
		case "backspace", "ctrl+h":
			if previous > 0 {
				value := []rune(input.Value())
				input.SetValue(string(value[:before]) + string(value[previous:]))
				input.SetCursor(before)
			}
			return input, nil
		case "delete", "ctrl+d":
			value := []rune(input.Value())
			input.SetValue(string(value[:previous]) + string(value[after:]))
			input.SetCursor(previous)
			return input, nil
		}
	}
	// Let Bubbles handle paste, validation, word shortcuts, focus and cursor
	// blinking. Apply limits at a whole-grapheme boundary after sanitization.
	limit := input.CharLimit
	original := input.Value()
	input.CharLimit = 0
	updated, command := input.Update(message)
	updated.CharLimit = limit
	position := updated.Position()
	value := updated.Value()
	if limit > 0 && utf8.RuneCountInString(value) > limit {
		// Preserve the text after a middle-of-line paste. Truncating the whole
		// value at the limit would silently delete an existing draft suffix.
		oldRunes, newRunes := []rune(original), []rune(value)
		prefix, suffix := 0, 0
		for prefix < len(oldRunes) && prefix < len(newRunes) && oldRunes[prefix] == newRunes[prefix] {
			prefix++
		}
		for suffix < len(oldRunes)-prefix && suffix < len(newRunes)-prefix && oldRunes[len(oldRunes)-1-suffix] == newRunes[len(newRunes)-1-suffix] {
			suffix++
		}
		insertedEnd := len(newRunes) - suffix
		end := -1
		if prefix == 0 {
			end = 0
		}
		for _, cluster := range inputGraphemes(value) {
			if cluster.end > min(limit-suffix, insertedEnd) {
				break
			}
			end = cluster.end
		}
		if end < prefix {
			updated.SetValue(original)
			position = previous
		} else {
			updated.SetValue(string(newRunes[:end]) + string(newRunes[insertedEnd:]))
			if position > insertedEnd {
				position -= insertedEnd - end
			} else if position > end {
				position = end
			}
		}
	}
	for _, cluster := range inputGraphemes(updated.Value()) {
		if position > cluster.start && position < cluster.end {
			if position < previous {
				position = cluster.start
			} else {
				position = cluster.end
			}
			break
		}
	}
	updated.SetCursor(position)
	return updated, command
}

// Render the cursor over the whole cluster and pan by terminal cells. ANSI
// styling inserted in the middle of a ZWJ sequence can split its visible emoji.
func composerView(input textinput.Model) string {
	if input.Value() == "" {
		return input.View()
	}
	clusters := inputGraphemes(input.Value())
	at := len(clusters)
	for i, cluster := range clusters {
		if input.Position() <= cluster.start {
			at = i
			break
		}
	}
	cursorText, cursorWidth := " ", 1
	if at < len(clusters) {
		cursorText, cursorWidth = clusters[at].text, max(1, clusters[at].width)
	}
	width := input.Width + 1 // Match Bubbles' spare cursor cell.
	if input.Width <= 0 {
		width = ansi.StringWidth(input.Value()) + 1
	}
	if cursorWidth > width {
		cursorText, cursorWidth = " ", 1
	}
	start, used := at, cursorWidth
	for start > 0 && used+clusters[start-1].width <= width {
		start--
		used += clusters[start].width
	}
	var before, after strings.Builder
	for i := start; i < at; i++ {
		before.WriteString(clusters[i].text)
	}
	for i := at + 1; i < len(clusters) && used+clusters[i].width <= width; i++ {
		after.WriteString(clusters[i].text)
		used += clusters[i].width
	}
	style := input.TextStyle.Inline(true)
	input.Cursor.SetChar(cursorText)
	return input.PromptStyle.Render(input.Prompt) + style.Render(before.String()) + input.Cursor.View() + style.Render(after.String()+strings.Repeat(" ", max(0, width-used)))
}
