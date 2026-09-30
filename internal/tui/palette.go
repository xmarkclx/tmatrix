package tui

import "github.com/charmbracelet/lipgloss"

type palette struct {
	Background, Text, Muted, Accent, Border                                  lipgloss.CompleteColor
	Selection, SelectionText, Warning, Error                                 lipgloss.CompleteColor
	Panel, Card, CardText, ActiveCard, ActiveCardText                        lipgloss.CompleteColor
	Message, MessageBG, Steering, SteeringBG, Tool, ToolBG                   lipgloss.CompleteColor
	Output, OutputBG, Status, StatusBG, ErrorText, ErrorBG, Prompt, PromptBG lipgloss.CompleteColor
	PromptBorder                                                             lipgloss.CompleteColor
}

// Edit the three capability values together to keep each foreground/background
// pair readable. Fixed ANSI256 entries (16–255) avoid the terminal's theme slots;
// ANSI uses a quiet black canvas with labels and borders instead of saturated
// full-width fills. NO_COLOR still renders the labels and borders without ANSI.
var matrixPalette = palette{
	Background:     lipgloss.CompleteColor{TrueColor: "#050B07", ANSI256: "232", ANSI: "0"},
	Text:           lipgloss.CompleteColor{TrueColor: "#C8F5D5", ANSI256: "194", ANSI: "15"},
	Muted:          lipgloss.CompleteColor{TrueColor: "#A1C5AA", ANSI256: "151", ANSI: "7"},
	Accent:         lipgloss.CompleteColor{TrueColor: "#7BFFA5", ANSI256: "120", ANSI: "10"},
	Border:         lipgloss.CompleteColor{TrueColor: "#549268", ANSI256: "71", ANSI: "10"},
	Selection:      lipgloss.CompleteColor{TrueColor: "#54DF86", ANSI256: "84", ANSI: "10"},
	SelectionText:  lipgloss.CompleteColor{TrueColor: "#082111", ANSI256: "22", ANSI: "0"},
	Warning:        lipgloss.CompleteColor{TrueColor: "#FFE9B3", ANSI256: "230", ANSI: "15"},
	Error:          lipgloss.CompleteColor{TrueColor: "#FFE0E4", ANSI256: "224", ANSI: "15"},
	Panel:          lipgloss.CompleteColor{TrueColor: "#14221A", ANSI256: "234", ANSI: "0"},
	Card:           lipgloss.CompleteColor{TrueColor: "#1D3327", ANSI256: "235", ANSI: "0"},
	CardText:       lipgloss.CompleteColor{TrueColor: "#C8F5D5", ANSI256: "194", ANSI: "7"},
	ActiveCard:     lipgloss.CompleteColor{TrueColor: "#285239", ANSI256: "22", ANSI: "10"},
	ActiveCardText: lipgloss.CompleteColor{TrueColor: "#7BFFA5", ANSI256: "120", ANSI: "0"},
	Message:        lipgloss.CompleteColor{TrueColor: "#CBF5D8", ANSI256: "194", ANSI: "7"},
	MessageBG:      lipgloss.CompleteColor{TrueColor: "#17432C", ANSI256: "22", ANSI: "0"},
	Steering:       lipgloss.CompleteColor{TrueColor: "#E8D9FF", ANSI256: "225", ANSI: "7"},
	SteeringBG:     lipgloss.CompleteColor{TrueColor: "#342D50", ANSI256: "54", ANSI: "0"},
	Tool:           lipgloss.CompleteColor{TrueColor: "#C6F2F5", ANSI256: "159", ANSI: "7"},
	ToolBG:         lipgloss.CompleteColor{TrueColor: "#173E48", ANSI256: "23", ANSI: "0"},
	Output:         lipgloss.CompleteColor{TrueColor: "#D2E6FF", ANSI256: "153", ANSI: "7"},
	OutputBG:       lipgloss.CompleteColor{TrueColor: "#24354B", ANSI256: "17", ANSI: "0"},
	Status:         lipgloss.CompleteColor{TrueColor: "#FFE9B3", ANSI256: "230", ANSI: "7"},
	StatusBG:       lipgloss.CompleteColor{TrueColor: "#494020", ANSI256: "58", ANSI: "0"},
	ErrorText:      lipgloss.CompleteColor{TrueColor: "#FFE0E4", ANSI256: "224", ANSI: "15"},
	ErrorBG:        lipgloss.CompleteColor{TrueColor: "#53272F", ANSI256: "52", ANSI: "0"},
	Prompt:         lipgloss.CompleteColor{TrueColor: "#172A16", ANSI256: "22", ANSI: "0"},
	PromptBG:       lipgloss.CompleteColor{TrueColor: "#BCD996", ANSI256: "151", ANSI: "7"},
	PromptBorder:   lipgloss.CompleteColor{TrueColor: "#172A16", ANSI256: "22", ANSI: "10"},
}
