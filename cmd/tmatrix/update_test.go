package main

import "testing"

func TestUpdateDispatchWithoutEngine(t *testing.T) {
	// These commands must complete before app.New can discover or start an engine.
	t.Setenv("TMATRIX_ENGINE_DIR", t.TempDir())
	if err := run([]string{"update", "--help"}); err != nil {
		t.Fatalf("update help needs an engine: %v", err)
	}
	for _, args := range [][]string{
		{"update", "unexpected"},
		{"update", "--unknown"},
		{"update", "--prefix"},
		{"update", "--prefix", "relative"},
		{"--demo", "update"},
		{"--config-dir", t.TempDir(), "update"},
		{"--engine-dir", t.TempDir(), "update"},
	} {
		if err := run(args); err == nil {
			t.Fatalf("invalid update arguments accepted: %v", args)
		}
	}
}
