package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

// Drawing and mouse hit testing share terminal-cell geometry. Never duplicate
// row numbers in the input handler: borders, overflow and resizing move them.
type layoutBlock struct {
	lines   []string
	targets []hitTarget
}

func (b *layoutBlock) append(other layoutBlock) {
	offset := len(b.lines)
	b.lines = append(b.lines, other.lines...)
	for _, target := range other.targets {
		target.y += offset
		b.targets = append(b.targets, target)
	}
}

func (m Model) compact() bool { return m.height < 28 || m.width < 60 }
func (m Model) headerHeight() int {
	if m.compact() {
		return 6
	}
	return 9
}
func (m Model) bodyHeight() int { return max(1, m.height-m.headerHeight()-2) }
func (m Model) activityHeight() int {
	reserved := 6 // identity, state, conversation, divider and two action rows
	if m.compact() {
		reserved = 5
	}
	return max(1, m.bodyHeight()-2-reserved)
}

func (m Model) View() string {
	frame := ""
	if m.matrix.active {
		frame = m.matrixView()
	} else {
		frame, _ = m.renderLayout()
	}
	if m.options.Portable {
		frame = portableFrame(frame)
	}
	return frame
}

func (m Model) renderLayout() (string, []hitTarget) {
	if m.width < 40 || m.height < 16 {
		lines := make([]string, max(1, m.height))
		lines[0] = fit("TMatrix · resize to at least 40 × 16", m.width)
		if m.options.Portable {
			lines[0] = fit("TMatrix: resize to at least 41 x 16", m.width)
		}
		for i := 1; i < len(lines); i++ {
			lines[i] = fit("", m.width)
		}
		return paintCanvas(strings.Join(lines, "\n")), nil
	}
	capacity := fmt.Sprintf("Workers %d/%d", m.snapshot.RunningWorkers, m.snapshot.MaxWorkers)
	if !m.loaded {
		capacity = "Connecting…"
	}
	mode := ""
	if m.options.Demo {
		mode = " DEMO · SIMULATED WORKERS"
	}
	badge := "ON - Accepting New Tasks"
	badgeStyle := accentStyle
	switch {
	case m.restarting || m.snapshot.RestartPending:
		badge = "RESTART PENDING - Waiting for workers"
		if m.width < 60 {
			badge = "RESTART PENDING"
		}
		badgeStyle = warningStyle
	case m.connectionError != "":
		badge = "UNKNOWN - Connection Lost"
		badgeStyle = warningStyle
	case !m.loaded:
		badge = "UNKNOWN - Connecting…"
		badgeStyle = mutedStyle
	case m.snapshot.Poller.Status == "stopped":
		badge = "OFF - Engine draining or stopped"
		badgeStyle = warningStyle
	case m.snapshot.IntakePaused:
		badge = "OFF - Not Accepting New Tasks"
		badgeStyle = warningStyle
	}
	b := layoutBlock{lines: []string{
		frameLine(" >_ TMATRIX: "+badge, m.width, badgeStyle),
		frameLine(mode+strings.Repeat(" ", max(1, m.width-lipgloss.Width(mode)-lipgloss.Width(capacity)-1))+capacity+" ", m.width, mutedStyle),
	}}
	b.append(m.navLayout())
	if m.screen == workersScreen {
		b.append(m.workerCards())
	} else {
		count := 4
		if m.compact() {
			count = 3
		}
		b.lines = append(b.lines, frameLine(" "+m.screenName(), m.width, accentStyle))
		for i := 1; i < count; i++ {
			b.lines = append(b.lines, "")
		}
	}
	var body layoutBlock
	switch m.screen {
	case workersScreen:
		body = m.workerContent()
	case serviceScreen:
		body = m.serviceContent()
	case adapterUpdatesScreen:
		body = m.adapterUpdateContent()
	case settingsScreen, connectScreen:
		body = m.formContent()
	default:
		content := m.helpView()
		if m.screen == pollersScreen {
			content = m.pollersView()
		}
		lines := strings.Split(content, "\n")
		available := m.bodyHeight() - 2
		offset := min(m.pageOffset, max(0, len(lines)-available))
		body.lines = lines[offset:min(len(lines), offset+available)]
		body.targets = []hitTarget{{x: 0, y: 0, width: m.width - 4, height: available, action: "scroll"}}
	}
	b.append(m.frameBody(body))
	notice := m.notice
	style := mutedStyle
	if m.failure != "" {
		notice = m.failure
		style = errorStyle
	} else if m.connectionError != "" {
		notice = "Connection lost · " + m.connectionError
		style = errorStyle
	} else if notice == "" {
		notice = "Working locally!"
	}
	b.lines = append(b.lines, frameLine(" "+ellipsis(notice, m.width-2), m.width, style))
	b.append(m.footerLayout())
	for i := range b.lines {
		b.lines[i] = fit(b.lines[i], m.width)
	}
	return paintCanvas(strings.Join(b.lines, "\n")), b.targets
}

func (m Model) navLayout() layoutBlock {
	labels := []string{"[w] Workers", "[p] Pollers", "[s] Settings", "[?] Help"}
	if m.width < 65 {
		labels = []string{"[w] Work", "[p] Poll", "[s] Set", "[?] Help"}
	}
	screens := []screen{workersScreen, pollersScreen, settingsScreen, helpScreen}
	keys := []string{"w", "p", "s", "?"}
	var out []string
	var targets []hitTarget
	x := 0
	for i, label := range labels {
		style := mutedStyle.Padding(0, 1)
		if m.screen == screens[i] || (m.screen == adapterUpdatesScreen && screens[i] == settingsScreen) {
			style = selectedStyle.Padding(0, 1).Bold(lipgloss.ColorProfile() != termenv.ANSI)
		}
		if !m.compact() {
			style = style.Border(lipgloss.RoundedBorder()).BorderForeground(matrixPalette.Border)
		}
		rendered := style.Render(label)
		width := lipgloss.Width(rendered)
		// Compact labels at 40 columns omit padding rather than hiding a tab.
		if m.compact() && m.width < 46 {
			rendered = style.Padding(0).Render(label)
			width = lipgloss.Width(rendered)
		}
		out = append(out, rendered)
		targets = append(targets, hitTarget{x: x, y: 0, width: width, height: lipgloss.Height(rendered), action: "key", key: keys[i]})
		x += width
	}
	return layoutBlock{lines: strings.Split(lipgloss.JoinHorizontal(lipgloss.Top, out...), "\n"), targets: targets}
}

func (m Model) frameBody(body layoutBlock) layoutBlock {
	h := m.bodyHeight()
	w := m.width - 4 // Two borders and one space of padding on each side.
	lines := []string{borderStyle.Render("╭" + strings.Repeat("─", w+2) + "╮")}
	for i := 0; i < h-2; i++ {
		value := ""
		if i < len(body.lines) {
			value = body.lines[i]
		}
		lines = append(lines, borderStyle.Render("│")+" "+fit(value, w)+" "+borderStyle.Render("│"))
	}
	lines = append(lines, borderStyle.Render("╰"+strings.Repeat("─", w+2)+"╯"))
	// Paint the whole window, including margins, unused viewport rows, and
	// borders. Nested cards retain their explicit foreground/background pairs.
	for i := range lines {
		lines[i] = paintSurface(lines[i], panelStyle)
	}
	var targets []hitTarget
	for _, target := range body.targets {
		if target.y < 0 || target.y >= h-2 {
			continue
		}
		target.height = min(target.height, h-2-target.y)
		target.width = min(target.width, w-target.x)
		target.x += 2
		target.y++
		if target.width > 0 && target.height > 0 {
			targets = append(targets, target)
		}
	}
	return layoutBlock{lines: lines, targets: targets}
}

type control struct{ label, key string }

func controls(items []control, width int) layoutBlock {
	var line strings.Builder
	var targets []hitTarget
	for _, item := range items {
		label := " " + item.label + " "
		x := lipgloss.Width(line.String())
		size := lipgloss.Width(label)
		if x+size > width {
			break
		}
		line.WriteString(accentStyle.Render(label))
		targets = append(targets, hitTarget{x: x, y: 0, width: size, height: 1, action: "key", key: item.key})
	}
	return layoutBlock{lines: []string{line.String()}, targets: targets}
}

func (m Model) footerLayout() layoutBlock {
	if m.screen == adapterUpdatesScreen {
		return controls([]control{{"[Esc] Settings", "esc"}, {"[↑/↓] Scroll", ""}}, m.width)
	}
	if m.screen == serviceScreen {
		if m.busy {
			return controls([]control{{"Working…", ""}}, m.width)
		}
		if m.serviceConfirmation != "" {
			return controls([]control{{"[y] Confirm", "y"}, {"[n] Cancel", "n"}}, m.width)
		}
		return controls([]control{{"[Esc] Settings", "esc"}}, m.width)
	}
	if m.screen == settingsScreen {
		return controls([]control{{"[Ctrl+S] Save", "ctrl+s"}, {"[Esc] Back", "esc"}}, m.width)
	}
	if m.confirmation != "" {
		return controls([]control{{"[y] Request stop", "y"}, {"[n] Cancel", "n"}}, m.width)
	}
	if m.composing {
		return controls([]control{{"[Enter] Send", "enter"}, {"[Esc] Save draft", "esc"}}, m.width)
	}
	if m.screen == settingsScreen || m.screen == connectScreen {
		return controls([]control{{"[Ctrl+S] Save", "ctrl+s"}, {"[Esc] Cancel", "esc"}}, m.width)
	}
	selection := "[F2] Select text"
	if m.mouseDisabled {
		selection = "[F2] Mouse on"
	}
	intake := "Pause intake"
	if m.snapshot.IntakePaused {
		intake = "Resume intake"
	}
	if m.width < 65 {
		return controls([]control{{"[m] Matrix", "m"}, {"[?] Help", "?"}, {"[c] Connect", "c"}, {"[Space] Intake", " "}}, m.width)
	}
	return controls([]control{{"[m] Matrix", "m"}, {"[?] Help", "?"}, {"[c] Connect", "c"}, {"[Space] " + intake, " "}, {"[q] Detach", "q"}, {selection, "f2"}}, m.width)
}

func (m Model) screenName() string {
	switch m.screen {
	case pollersScreen:
		return "Pollers"
	case serviceScreen:
		return "Background service"
	case adapterUpdatesScreen:
		if update := m.snapshot.AdapterUpdate; update != nil && strings.TrimSpace(update.DisplayName) != "" {
			return single(update.DisplayName) + " updates"
		}
		return "Runtime updates"
	case settingsScreen:
		return "Settings"
	case connectScreen:
		return "Connect with Tzu Do"
	case helpScreen:
		return "Keyboard guide"
	default:
		return "Workers"
	}
}
