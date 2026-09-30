package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSettingsRoundTripKeepsCredentialSeparate(t *testing.T) {
	dir := privateTestDir(t)
	c, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	c.MaxWorkers = 7
	if err := Save(dir, c); err != nil {
		t.Fatal(err)
	}
	if err := SaveAPIKey(dir, "fictional-test-credential"); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(dir)
	if err != nil || loaded != c {
		t.Fatalf("settings or instance ID changed: %v", err)
	}
	key, err := LoadAPIKey(dir)
	if err != nil || key != "fictional-test-credential" {
		t.Fatal("credential round trip failed")
	}
	data, err := os.ReadFile(filepath.Join(dir, ConfigFilename))
	if err != nil || strings.Contains(string(data), "credential") || strings.Contains(string(data), "api_key") {
		t.Fatal("main settings must not include credentials")
	}
	for _, name := range []string{ConfigFilename, CredentialFilename} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0600) {
			t.Fatalf("%s is not private", name)
		}
	}
	// Replacements retain the new values and leave no partial temporary files.
	c.MaxWorkers = 2
	if err := Save(dir, c); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 2 {
		t.Fatal("temporary files were left behind")
	}
}

func TestRejectUnsafeConnectionAndSettings(t *testing.T) {
	for _, raw := range []string{"http://tzudo.app/api/v1/ai/poll", "https://name:secret@tzudo.app/api/v1/ai/poll", "https://tzudo.app/?key=secret", "https://tzudo.app/#token", "https://tzudo.app/?", "https:///api/v1/ai/poll"} {
		if ValidatePollURL(raw) == nil {
			t.Fatalf("accepted unsafe connection URL %q", raw)
		}
	}
	for _, mutate := range []func(*Config){
		func(c *Config) { c.MaxWorkers = 0 },
		func(c *Config) { c.MaxWorkers = 101 },
		func(c *Config) { c.PollIntervalMS = 249 },
		func(c *Config) { c.PollIntervalMS = 300001 },
		func(c *Config) { c.WorkerType = "claude" },
		func(c *Config) { c.PollerType = "unknown" },
		func(c *Config) { c.InstanceID = strings.Repeat("x", 36) },
	} {
		c := Default()
		mutate(&c)
		if Validate(c) == nil {
			t.Fatal("accepted unsupported settings")
		}
	}
	for _, key := range []string{"", "key\r\nAuthorization: other", " space", "a b"} {
		if SaveAPIKey(privateTestDir(t), key) == nil {
			t.Fatal("accepted invalid credential")
		}
	}
}

func TestRejectSymlinkAndPublicCredentials(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix mode and symlink checks")
	}
	dir := privateTestDir(t)
	outside := filepath.Join(t.TempDir(), "untouched")
	if err := os.WriteFile(outside, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, CredentialFilename)); err != nil {
		t.Fatal(err)
	}
	if SaveAPIKey(dir, "replacement") == nil {
		t.Fatal("followed credential symlink")
	}
	if _, err := LoadAPIKey(dir); err == nil {
		t.Fatal("read credential symlink")
	}
	data, _ := os.ReadFile(outside)
	if string(data) != "original" {
		t.Fatal("modified symlink target")
	}
	if err := os.Remove(filepath.Join(dir, CredentialFilename)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, CredentialFilename), []byte("fictional"), 0644); err != nil {
		t.Fatal(err)
	}
	// Creation permissions are filtered by the caller's umask. Make this
	// deliberately unsafe fixture public even when the test runner uses 0077.
	if err := os.Chmod(filepath.Join(dir, CredentialFilename), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadAPIKey(dir); err == nil {
		t.Fatal("read world-readable credential")
	}
}

func TestInvalidSaveDoesNotReplaceSettings(t *testing.T) {
	dir := privateTestDir(t)
	c := Default()
	if err := Save(dir, c); err != nil {
		t.Fatal(err)
	}
	c.WorkerType = "unavailable"
	if Save(dir, c) == nil {
		t.Fatal("accepted unsupported worker")
	}
	loaded, err := Load(dir)
	if err != nil || loaded.WorkerType != "codex" {
		t.Fatal("invalid save damaged existing settings")
	}
}

func TestRejectSharedConfigurationDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix directory permission check")
	}
	dir := privateTestDir(t)
	cfg := Default()
	if err := Save(dir, cfg); err != nil {
		t.Fatal(err)
	}
	if err := SaveAPIKey(dir, "fictional-test-key"); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0777); err != nil {
		t.Fatal(err)
	}
	if Save(dir, cfg) == nil {
		t.Fatal("saved settings inside shared directory")
	}
	if SaveAPIKey(dir, "replacement") == nil {
		t.Fatal("saved credential inside shared directory")
	}
	if _, err := Load(dir); err == nil {
		t.Fatal("read settings from shared directory")
	}
	if _, err := LoadAPIKey(dir); err == nil {
		t.Fatal("read credential from shared directory")
	}
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	key, err := LoadAPIKey(dir)
	if err != nil || key != "fictional-test-key" {
		t.Fatal("rejected write changed the existing credential")
	}
}

func privateTestDir(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "tmatrix")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestCustomAdapterConfigurationRoundTrip(t *testing.T) {
	dir := privateTestDir(t)
	cfg := Default()
	cfg.WorkerType = "hermes"
	cfg.AdapterModule = filepath.Join(t.TempDir(), "adapter.mjs")
	if err := Save(dir, cfg); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(dir)
	if err != nil || loaded != cfg {
		t.Fatalf("adapter configuration lost: %v", err)
	}
	cfg.AdapterModule = "relative.mjs"
	if Validate(cfg) == nil {
		t.Fatal("accepted relative adapter path")
	}
	cfg.WorkerType = "codex"
	if Validate(cfg) == nil {
		t.Fatal("accepted bundled adapter override")
	}
}
