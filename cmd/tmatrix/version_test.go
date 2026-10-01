package main

import "testing"

func TestFormatVersion(t *testing.T) {
	for _, tt := range []struct {
		tag, revision, count, want string
	}{
		{"0.1.1", "0123456789abcdef0123456789abcdef01234567", "42", "TMatrix 0.1.1 (build 42, commit 0123456789ab)"},
		{"dev", "0123456789abcdef-dirty", "43", "TMatrix dev (build 43, commit 0123456789ab-dirty)"},
		{"dev", "local", "", "TMatrix dev (build unknown, commit local)"},
	} {
		if got := formatVersion(tt.tag, tt.revision, tt.count); got != tt.want {
			t.Errorf("formatVersion = %q, want %q", got, tt.want)
		}
	}
}
