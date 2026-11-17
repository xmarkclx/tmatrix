package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestLegacyMigrationPreservesConnectionAndCredential(t *testing.T) {
	dir := privateTestDir(t)
	instance := NewID()
	legacy := map[string]any{"version": 1, "max_workers": 7, "poll_interval_ms": 750, "engine_dir": "/engine", "worker_type": "codex", "poller_type": "tzudo", "poll_url": "https://legacy.invalid/custom/poll", "instance_id": instance, "resume_intake": true}
	data, _ := json.Marshal(legacy)
	if err := os.WriteFile(filepath.Join(dir, ConfigFilename), data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := SaveAPIKey(dir, "legacy-fixture-key"); err != nil {
		t.Fatal(err)
	}
	keyBefore, _ := os.ReadFile(filepath.Join(dir, CredentialFilename))
	cfg, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	want := Source{ID: "legacy", Name: "TzuDo", PollURL: "https://legacy.invalid/custom/poll", InstanceID: instance, CredentialID: "legacy", ConversationNamespace: "https://legacy.invalid"}
	if cfg.Version != 2 || cfg.InstanceID != instance || cfg.UpdateOrigin != "https://legacy.invalid" || cfg.MaxWorkers != 7 || cfg.PollIntervalMS != 750 || !cfg.ResumeIntake || !reflect.DeepEqual(cfg.Sources, []Source{want}) {
		t.Fatalf("migration lost source identity or settings: %+v", cfg)
	}
	if err := Save(dir, cfg); err != nil {
		t.Fatal(err)
	}
	reloaded, err := Load(dir)
	if err != nil || !reflect.DeepEqual(cfg, reloaded) {
		t.Fatal("migration was not stable across save and reload")
	}
	keyAfter, _ := os.ReadFile(filepath.Join(dir, CredentialFilename))
	if string(keyAfter) != string(keyBefore) {
		t.Fatal("migration rewrote the existing credential")
	}
	saved, _ := os.ReadFile(filepath.Join(dir, ConfigFilename))
	if strings.Contains(string(saved), "legacy-fixture-key") {
		t.Fatal("configuration contains key bytes")
	}
}

func TestSourceRegistryAndPrivateCredentialGenerations(t *testing.T) {
	dir := privateTestDir(t)
	cfg := Default()
	first := NewSource("TzuDo", "https://source.invalid/tasks/poll")
	second := NewSource("Mindmap", "https://source.invalid/chat/poll")
	first.CredentialID, second.CredentialID = NewID(), NewID()
	cfg.Sources = []Source{first, second}
	if err := SaveCredential(dir, first.CredentialID, "first-fixture"); err != nil {
		t.Fatal(err)
	}
	if err := SaveCredential(dir, second.CredentialID, "second-fixture"); err != nil {
		t.Fatal(err)
	}
	if err := Save(dir, cfg); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(dir)
	if err != nil || !reflect.DeepEqual(loaded, cfg) {
		t.Fatal("source registry changed on reload")
	}
	for _, item := range []struct{ id, key string }{{first.CredentialID, "first-fixture"}, {second.CredentialID, "second-fixture"}} {
		key, err := LoadSourceKey(dir, item.id)
		if err != nil || key != item.key {
			t.Fatal("source credential crossed connections")
		}
		path, _ := CredentialPath(dir, item.id)
		info, _ := os.Stat(path)
		if info.Mode().Perm() != 0600 {
			t.Fatal("source credential is not owner-only")
		}
	}
	duplicate := cfg
	duplicate.Sources = append([]Source{}, cfg.Sources...)
	duplicate.Sources[1].ID = first.ID
	if Validate(duplicate) == nil {
		t.Fatal("duplicate source identity accepted")
	}
	duplicate.Sources[1] = second
	duplicate.Sources[1].CredentialID = first.CredentialID
	if Validate(duplicate) == nil {
		t.Fatal("shared credential reference accepted")
	}
	if _, err := CredentialPath(dir, "../../outside"); err == nil {
		t.Fatal("credential path traversal accepted")
	}
	cfg.Sources = []Source{}
	if err := Save(dir, cfg); err != nil {
		t.Fatal(err)
	}
	empty, err := Load(dir)
	if err != nil || len(empty.Sources) != 0 || empty.InstanceID != cfg.InstanceID || empty.UpdateOrigin != cfg.UpdateOrigin {
		t.Fatal("empty registry restored a source or changed engine identity")
	}
}

func TestSourceCredentialFilesRejectSymlinks(t *testing.T) {
	dir := privateTestDir(t)
	id := NewID()
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("untouched"), 0600); err != nil {
		t.Fatal(err)
	}
	path, _ := CredentialPath(dir, id)
	if err := os.Symlink(outside, path); err != nil {
		t.Skip(err)
	}
	if SaveCredential(dir, id, "replacement") == nil {
		t.Fatal("source credential write followed a symlink")
	}
	if _, err := LoadSourceKey(dir, id); err == nil {
		t.Fatal("source credential read followed a symlink")
	}
	data, _ := os.ReadFile(outside)
	if string(data) != "untouched" {
		t.Fatal("source credential changed external data")
	}
}

func TestSettingsLockRejectsConcurrentWriterAndReleases(t *testing.T) {
	dir := privateTestDir(t)
	release, err := LockSettings(dir)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "settings-change.lock")
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("settings lock is not owner-only")
	}
	if _, err := LockSettings(dir); err == nil || !strings.Contains(err.Error(), "in progress") {
		t.Fatal("concurrent settings writer bypassed the lock")
	}
	release()
	releaseAgain, err := LockSettings(dir)
	if err != nil {
		t.Fatal("completed settings writer retained its lock")
	}
	releaseAgain()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("settings lock was retained after release")
	}
}

func TestPollOriginNormalizesLegacyIdentity(t *testing.T) {
	for _, test := range []struct{ url, want string }{{"https://EXAMPLE.invalid:443/poll", "https://example.invalid"}, {"https://[2001:DB8::1]:443/poll", "https://[2001:db8::1]"}, {"https://example.invalid:8443/poll", "https://example.invalid:8443"}} {
		if got := PollOrigin(test.url); got != test.want {
			t.Fatalf("origin %q, want %q", got, test.want)
		}
	}
}
