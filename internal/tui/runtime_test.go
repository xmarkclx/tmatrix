package tui

import (
	"testing"
	"time"

	"tmatrix/internal/backend"
)

func TestElapsedUsesExecutionStartAndConfirmedEnd(t *testing.T) {
	now := time.Date(2026, 9, 29, 10, 4, 32, 0, time.UTC)
	worker := backend.Worker{Status: "running", StartedAt: "2026-09-29T10:00:00Z"}
	for _, status := range []string{"running", "stopping"} {
		worker.Status = status
		if got := elapsedLabel(worker, now); got != "4m 32s elapsed" {
			t.Fatalf("%s: %s", status, got)
		}
		if got := elapsedLabel(worker, now.Add(time.Second)); got != "4m 33s elapsed" {
			t.Fatalf("%s did not advance: %s", status, got)
		}
	}
	worker.Status = "completed"
	worker.EndedAt = "2026-09-29T10:02:00Z"
	for _, clock := range []time.Time{now, now.Add(24 * time.Hour)} {
		if got := elapsedLabel(worker, clock); got != "2m 00s total" {
			t.Fatalf("completed execution changed duration: %s", got)
		}
	}
	worker.EndedAt = ""
	worker.Activity = []backend.Activity{
		{At: "2026-09-29T10:02:00Z", Kind: "worker.completed"},
		{At: "2026-09-29T10:03:00Z", Kind: "message"},
	}
	if got := elapsedLabel(worker, now); got != "2m 00s total" {
		t.Fatal("bridge terminal-event fallback:", got)
	}
}

func TestElapsedDoesNotInventTimesFromAmbiguousEvidence(t *testing.T) {
	now := time.Date(2026, 9, 29, 10, 4, 32, 0, time.UTC)
	cases := []backend.Worker{
		{Status: "running"},
		{Status: "running", StartedAt: "invalid"},
		{Status: "running", StartedAt: "2026-09-29T10:05:00Z"},
		{Status: "completed", StartedAt: "2026-09-29T10:00:00Z"},
		{Status: "completed", StartedAt: "2026-09-29T10:00:00Z", EndedAt: "2026-09-29T09:59:00Z"},
		{Status: "completed", StartedAt: "2026-09-29T10:00:00Z", EndedAt: "2026-09-29T10:05:00Z"},
		{Status: "stopped", StartedAt: "2026-09-29T10:00:00Z", Activity: []backend.Activity{{Kind: "status", Text: "Execution stopped", At: "2026-09-29T10:02:00Z"}}},
		{Status: "stop_unverified", StartedAt: "2026-09-29T10:00:00Z", EndedAt: "2026-09-29T10:02:00Z"},
		{Status: "unknown", StartedAt: "2026-09-29T10:00:00Z"},
	}
	for _, worker := range cases {
		if got := elapsedLabel(worker, now); got != "Runtime unknown" {
			t.Fatalf("invented elapsed time for %+v: %s", worker, got)
		}
	}
}

func TestElapsedFormatsLongAndOffsetTimes(t *testing.T) {
	now := time.Date(2026, 9, 30, 10, 4, 32, 0, time.UTC)
	worker := backend.Worker{Status: "running", StartedAt: "2026-09-29T18:00:00+08:00"}
	if got := elapsedLabel(worker, now); got != "1d 00h 04m 32s elapsed" {
		t.Fatal(got)
	}
	worker.StartedAt = "2026-09-30T08:02:03Z"
	if got := elapsedLabel(worker, now); got != "2h 02m 29s elapsed" {
		t.Fatal(got)
	}
}
