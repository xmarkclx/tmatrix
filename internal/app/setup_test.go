package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSetupDefersUntilConnected(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "private")
	s, err := New(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := s.SetupService(); err != nil {
			t.Fatal(err)
		}
	}
	info, err := os.Stat(filepath.Join(dir, "install-service-on-connect"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatal("setup marker must be private")
	}
}
