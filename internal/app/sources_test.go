package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"tmatrix/internal/backend"
	"tmatrix/internal/config"
)

func saveFixtureSource(t *testing.T, s *Service, url, key string) config.Config {
	t.Helper()
	cfg, err := config.Load(s.Dir)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Sources = []config.Source{fixtureSource(cfg, url)}
	cfg.UpdateOrigin = config.PollOrigin(url)
	if err := config.SaveAPIKey(s.Dir, key); err != nil {
		t.Fatal(err)
	}
	if err := config.Save(s.Dir, cfg); err != nil {
		t.Fatal(err)
	}
	return cfg
}

func TestSourceEditCancelledBeforePublicationPreservesRegistry(t *testing.T) {
	s, requested := drainingService(t)
	before := saveFixtureSource(t, s, "https://original.invalid/api/poll", "original-fixture")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- s.Connect(ctx, backend.Connection{SourceID: "legacy", Name: "Renamed", URL: "https://original.invalid/api/poll", APIKey: "replacement-fixture"})
	}()
	select {
	case <-requested:
	case <-time.After(3 * time.Second):
		t.Fatal("source change did not wait for active work")
	}
	during, _ := config.Load(s.Dir)
	if !reflect.DeepEqual(during, before) {
		t.Fatal("source registry changed before draining")
	}
	cancel()
	if err := <-done; err == nil {
		t.Fatal("cancelled source change succeeded")
	}
	after, _ := config.Load(s.Dir)
	key, _ := config.LoadSourceKey(s.Dir, "legacy")
	if !reflect.DeepEqual(after, before) || key != "original-fixture" {
		t.Fatal("cancelled source change lost its connection")
	}
}

func TestCredentialRotationRollsBackWhenRegistryPublicationFails(t *testing.T) {
	s, requested := drainingService(t)
	saveFixtureSource(t, s, "https://original.invalid/api/poll", "original-fixture")
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- s.Connect(ctx, backend.Connection{SourceID: "legacy", Name: "Renamed", URL: "https://original.invalid/api/poll", APIKey: "replacement-fixture"})
	}()
	select {
	case <-requested:
	case <-ctx.Done():
		t.Fatal("drain was not requested")
	}
	original := filepath.Join(s.Dir, config.ConfigFilename)
	outside := filepath.Join(t.TempDir(), "original-config")
	before, _ := os.ReadFile(original)
	if err := os.Rename(original, outside); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, original); err != nil {
		t.Skip(err)
	}
	if err := os.Remove(config.DiscoveryPath(s.Dir)); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err == nil {
		t.Fatal("source change accepted an unsafe registry replacement")
	}
	after, _ := os.ReadFile(outside)
	key, _ := config.LoadSourceKey(s.Dir, "legacy")
	if string(after) != string(before) || key != "original-fixture" {
		t.Fatal("failed publication changed existing source credentials")
	}
	entries, _ := os.ReadDir(s.Dir)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "credentials-") {
			t.Fatal("failed publication retained its orphan credential")
		}
	}
}

func TestOldEngineIsRejectedBeforeChangingSources(t *testing.T) {
	engine := sourceEngineFixture(t)
	if err := os.Remove(filepath.Join(engine, "dist", "source-supervisor.js")); err != nil {
		t.Fatal(err)
	}
	s, err := New(filepath.Join(t.TempDir(), "private"), engine)
	if err != nil {
		t.Fatal(err)
	}
	before := saveFixtureSource(t, s, "https://original.invalid/api/poll", "original-fixture")
	err = s.Connect(context.Background(), backend.Connection{SourceID: "legacy", Name: "Original", URL: "https://replacement.invalid/api/poll", APIKey: "replacement-fixture"})
	after, _ := config.Load(s.Dir)
	key, _ := config.LoadSourceKey(s.Dir, "legacy")
	if err == nil || !strings.Contains(err.Error(), "engine update needed") || !reflect.DeepEqual(before, after) || key != "original-fixture" {
		t.Fatal("old engine capability check changed the saved connection")
	}
}

func TestRemovingFinalSourceLeavesDisconnectedRegistry(t *testing.T) {
	s, err := New(filepath.Join(t.TempDir(), "private"), "")
	if err != nil {
		t.Fatal(err)
	}
	before := saveFixtureSource(t, s, "https://original.invalid/api/poll", "original-fixture")
	if err := s.RemoveSource(context.Background(), "legacy"); err != nil {
		t.Fatal(err)
	}
	after, _ := config.Load(s.Dir)
	snapshot, err := s.Snapshot(context.Background())
	if err != nil || len(after.Sources) != 0 || after.ResumeIntake || after.InstanceID != before.InstanceID || after.UpdateOrigin != before.UpdateOrigin || len(snapshot.Pollers) != 0 || !snapshot.IntakePaused {
		t.Fatal("last source removal restarted or restored a source")
	}
	if _, err := os.Stat(config.DiscoveryPath(s.Dir)); !os.IsNotExist(err) {
		t.Fatal("last source removal started an engine")
	}
	if _, err := config.LoadSourceKey(s.Dir, "legacy"); err != nil {
		t.Fatal(err)
	}
}

func TestRecoveryRequiresExplicitSourceAndUsesStoredNamespace(t *testing.T) {
	cfg := config.Default()
	first := config.NewSource("First", "https://shared.invalid/a/poll")
	first.CredentialID = config.NewID()
	second := config.NewSource("Second", "https://shared.invalid/b/poll")
	second.CredentialID = config.NewID()
	cfg.Sources = []config.Source{first, second}
	dir := filepath.Join(t.TempDir(), "private")
	if err := config.Save(dir, cfg); err != nil {
		t.Fatal(err)
	}
	err := RecoverConversation(context.Background(), dir, "", "00000000-0000-4000-8000-000000000000", false)
	if err == nil || !strings.Contains(err.Error(), "--source") {
		t.Fatal("recovery guessed a source")
	}
	if first.ConversationNamespace == second.ConversationNamespace {
		t.Fatal("two source endpoints share conversation namespace")
	}
	decoded := []string{}
	if json.Unmarshal([]byte(second.ConversationNamespace), &decoded) != nil || !reflect.DeepEqual(decoded, []string{"https://shared.invalid/b/poll", second.ID}) {
		t.Fatal("source namespace lost endpoint identity")
	}
}

func TestDaemonWithNoSourcesExitsWithoutRestartFailure(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "private")
	if err := RunDaemon(context.Background(), dir, config.Default()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(config.DiscoveryPath(dir)); !os.IsNotExist(err) {
		t.Fatal("empty daemon started a poller")
	}
	s, err := New(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := s.Snapshot(context.Background())
	if err != nil || !snapshot.IntakePaused || len(snapshot.Pollers) != 0 || snapshot.Version != 2 {
		t.Fatal("empty daemon failed to remain disconnected")
	}
}

func TestActualMultipleSourceLifecycle(t *testing.T) {
	engine := os.Getenv("TMATRIX_TEST_ENGINE_DIR")
	if engine == "" {
		t.Skip("set TMATRIX_TEST_ENGINE_DIR to the isolated compiled engine")
	}
	root := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "config"))
	t.Setenv("XDG_STATE_HOME", filepath.Join(root, "state"))
	dir := filepath.Join(root, "private")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	instance := config.NewID()
	legacy := map[string]any{"version": 1, "max_workers": 2, "poll_interval_ms": 5000, "engine_dir": engine, "worker_type": "codex", "poller_type": "tzudo", "poll_url": "https://tzudo-fixture.invalid/api/poll", "instance_id": instance, "resume_intake": true}
	data, _ := json.Marshal(legacy)
	if err := os.WriteFile(filepath.Join(dir, config.ConfigFilename), data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := config.SaveAPIKey(dir, "tzudo-fixture-key"); err != nil {
		t.Fatal(err)
	}
	service, err := New(dir, engine)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	defer service.Shutdown(context.Background())
	url := "https://mindmap-fixture.invalid/api/ai-chat/worker/poll"
	if err := service.Connect(ctx, backend.Connection{Name: "Mindmap", URL: url, APIKey: "mindmap-fixture-key"}); err != nil {
		t.Fatal(err)
	}
	snapshot, err := service.Snapshot(ctx)
	if err != nil || len(snapshot.Pollers) != 2 || snapshot.Version != 2 || snapshot.IntakePaused || snapshot.MaxWorkers != 2 {
		t.Fatalf("two sources not exposed by actual engine: %v", err)
	}
	cfg, _ := config.Load(dir)
	if cfg.Sources[0].ID != "legacy" || cfg.Sources[0].ConversationNamespace != "https://tzudo-fixture.invalid" || cfg.InstanceID != instance || cfg.UpdateOrigin != "https://tzudo-fixture.invalid" {
		t.Fatal("adding a source changed the migrated source or engine identity")
	}
	added := cfg.Sources[1]
	if err := service.Connect(ctx, backend.Connection{SourceID: added.ID, Name: "LifeCCC chat", URL: url}); err != nil {
		t.Fatal(err)
	}
	renamed, _ := config.Load(dir)
	if renamed.Sources[1].ID != added.ID || renamed.Sources[1].Name != "LifeCCC chat" || renamed.Sources[1].CredentialID != added.CredentialID || renamed.Sources[1].ConversationNamespace != added.ConversationNamespace {
		t.Fatal("renaming a source changed its credential or conversation identity")
	}
	replacementURL := "https://mindmap-fixture.invalid/another/poll"
	if err := service.Connect(ctx, backend.Connection{SourceID: added.ID, Name: "LifeCCC chat", URL: replacementURL}); err != nil {
		t.Fatal(err)
	}
	changed, _ := config.Load(dir)
	expected := config.SourceNamespace(replacementURL, added.ID)
	if changed.Sources[1].ConversationNamespace != expected || changed.Sources[1].ConversationNamespace == added.ConversationNamespace {
		t.Fatal("endpoint change reused the previous conversation namespace")
	}
	if err := service.Connect(ctx, backend.Connection{SourceID: added.ID, Name: "LifeCCC chat", URL: replacementURL, APIKey: "rotated-mindmap-fixture-key"}); err != nil {
		t.Fatal(err)
	}
	rotated, _ := config.Load(dir)
	firstKey, _ := config.LoadSourceKey(dir, rotated.Sources[0].CredentialID)
	secondKey, _ := config.LoadSourceKey(dir, rotated.Sources[1].CredentialID)
	if firstKey != "tzudo-fixture-key" || secondKey != "rotated-mindmap-fixture-key" || rotated.Sources[1].CredentialID == added.CredentialID || rotated.Sources[1].ConversationNamespace != expected {
		t.Fatal("key rotation crossed sources or changed conversation identity")
	}
	if err := service.RemoveSource(ctx, "legacy"); err != nil {
		t.Fatal(err)
	}
	remaining, _ := config.Load(dir)
	snapshot, err = service.Snapshot(ctx)
	if err != nil || len(snapshot.Pollers) != 1 || snapshot.Pollers[0].ID != added.ID || remaining.UpdateOrigin != "https://tzudo-fixture.invalid" || remaining.InstanceID != instance {
		t.Fatal("removing the first source changed its peer or runtime updater identity")
	}
	if err := service.RemoveSource(ctx, added.ID); err != nil {
		t.Fatal(err)
	}
	empty, _ := config.Load(dir)
	snapshot, err = service.Snapshot(ctx)
	if err != nil || len(empty.Sources) != 0 || len(snapshot.Pollers) != 0 || !snapshot.IntakePaused {
		t.Fatal("removing all sources did not leave disconnected console")
	}
}

func TestRepeatedAddDoesNotDuplicateExistingConnection(t *testing.T) {
	s, requested := drainingService(t)
	before := saveFixtureSource(t, s, "https://original.invalid/api/poll", "original-fixture")
	err := s.Connect(context.Background(), backend.Connection{Name: "Repeated source", URL: "https://original.invalid/api/poll", APIKey: "original-fixture"})
	after, _ := config.Load(s.Dir)
	if err == nil || !strings.Contains(err.Error(), "already configured") || !reflect.DeepEqual(before, after) {
		t.Fatal("repeated add duplicated or replaced an existing source")
	}
	key, _ := config.LoadSourceKey(s.Dir, "legacy")
	if key != "original-fixture" {
		t.Fatal("duplicate add changed the original credential")
	}
	select {
	case <-requested:
		t.Fatal("duplicate add drained the existing connection")
	default:
	}
}

func TestActualSameEndpointAllowsSeparateSourceKeys(t *testing.T) {
	engine := os.Getenv("TMATRIX_TEST_ENGINE_DIR")
	if engine == "" {
		t.Skip("set TMATRIX_TEST_ENGINE_DIR to the isolated compiled engine")
	}
	root := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "config"))
	t.Setenv("XDG_STATE_HOME", filepath.Join(root, "state"))
	s, err := New(filepath.Join(root, "private"), engine)
	if err != nil {
		t.Fatal(err)
	}
	before := saveFixtureSource(t, s, "https://shared-fixture.invalid/api/poll", "first-account-fixture")
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	defer s.Shutdown(context.Background())
	if err := s.Connect(ctx, backend.Connection{Name: "Other account", URL: "https://shared-fixture.invalid/api/poll", APIKey: "second-account-fixture"}); err != nil {
		t.Fatal(err)
	}
	cfg, _ := config.Load(s.Dir)
	snapshot, err := s.Snapshot(ctx)
	if err != nil || len(cfg.Sources) != 2 || len(snapshot.Pollers) != 2 || cfg.Sources[0] != before.Sources[0] || cfg.Sources[0].InstanceID == cfg.Sources[1].InstanceID || cfg.Sources[0].ConversationNamespace == cfg.Sources[1].ConversationNamespace {
		t.Fatal("same endpoint accounts did not remain independent sources")
	}
	first, _ := config.LoadSourceKey(s.Dir, cfg.Sources[0].CredentialID)
	second, _ := config.LoadSourceKey(s.Dir, cfg.Sources[1].CredentialID)
	if first != "first-account-fixture" || second != "second-account-fixture" {
		t.Fatal("same endpoint accounts crossed credentials")
	}
}

func TestConcurrentConsolesCannotOverwriteSourceRegistry(t *testing.T) {
	s, requested := drainingService(t)
	before := saveFixtureSource(t, s, "https://original.invalid/api/poll", "original-fixture")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- s.Connect(ctx, backend.Connection{SourceID: "legacy", Name: "Renamed", URL: "https://original.invalid/api/poll", APIKey: "replacement-fixture"})
	}()
	select {
	case <-requested:
	case <-time.After(3 * time.Second):
		t.Fatal("first console did not enter source change")
	}
	other := &Service{Dir: s.Dir}
	maximum := 3
	actions := []func() error{
		func() error { return other.Configure(context.Background(), backend.Settings{MaxWorkers: &maximum}) },
		func() error {
			return other.Connect(context.Background(), backend.Connection{Name: "Other source", URL: "https://other.invalid/poll", APIKey: "other-fixture"})
		},
		func() error { return other.RemoveSource(context.Background(), "legacy") },
		func() error { _, err := New(s.Dir, filepath.Join(t.TempDir(), "different-engine")); return err },
	}
	for _, action := range actions {
		if err := action(); err == nil || !strings.Contains(err.Error(), "settings change is in progress") {
			t.Fatal("concurrent console changed source settings")
		}
	}
	if attached, err := New(s.Dir, ""); err != nil || attached == nil {
		t.Fatal("routine console attach was blocked by a settings change")
	}
	if attached, err := New(s.Dir, before.EngineDir); err != nil || attached == nil {
		t.Fatal("unchanged engine override blocked routine attach")
	}
	during, _ := config.Load(s.Dir)
	key, _ := config.LoadSourceKey(s.Dir, "legacy")
	if !reflect.DeepEqual(during, before) || key != "original-fixture" {
		t.Fatal("concurrent settings writer corrupted source registry")
	}
	cancel()
	if err := <-done; err == nil {
		t.Fatal("cancelled first source change succeeded")
	}
	if err := os.Remove(config.DiscoveryPath(s.Dir)); err != nil {
		t.Fatal(err)
	}
	if err := other.Configure(context.Background(), backend.Settings{MaxWorkers: &maximum}); err != nil {
		t.Fatal(err)
	}
	after, _ := config.Load(s.Dir)
	if after.MaxWorkers != 3 || !reflect.DeepEqual(after.Sources, before.Sources) {
		t.Fatal("released settings lock did not permit safe later changes")
	}
}

func TestActualCLIDaemonReadsRegistryWhileSettingsLocked(t *testing.T) {
	engine := os.Getenv("TMATRIX_TEST_ENGINE_DIR")
	if engine == "" {
		t.Skip("set TMATRIX_TEST_ENGINE_DIR to the isolated compiled engine")
	}
	root := t.TempDir()
	binary := filepath.Join(root, "tmatrix")
	build := exec.Command("go", "build", "-o", binary, "./cmd/tmatrix")
	build.Dir = "../.."
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build CLI: %v, %s", err, output)
	}
	cfg := config.Default()
	cfg.EngineDir = engine
	cfg.ResumeIntake = false
	source := config.NewSource("Mindmap", "https://cli-fixture.invalid/api/poll")
	source.CredentialID = config.NewID()
	cfg.Sources = []config.Source{source}
	dir := filepath.Join(root, "private")
	if err := config.SaveCredential(dir, source.CredentialID, "cli-fixture-key"); err != nil {
		t.Fatal(err)
	}
	if err := config.Save(dir, cfg); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(filepath.Join(dir, config.ConfigFilename))
	release, err := config.LockSettings(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "--config-dir", dir, "--engine-dir", engine, "daemon")
	cmd.Env = append(os.Environ(), "XDG_CONFIG_HOME="+filepath.Join(root, "config"), "XDG_STATE_HOME="+filepath.Join(root, "state"))
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var client *backend.HTTP
	for {
		if found, err := backend.NewHTTP(config.DiscoveryPath(dir)); err == nil {
			if snapshot, err := found.Snapshot(ctx); err == nil && len(snapshot.Pollers) == 1 && snapshot.Pollers[0].ID == source.ID && snapshot.IntakePaused {
				if _, lockErr := os.Stat(filepath.Join(dir, "start.lock")); os.IsNotExist(lockErr) {
					client = found
					break
				}
			}
		}
		select {
		case err := <-done:
			t.Fatalf("CLI daemon exited while parent held settings lock: %v", err)
		case <-ctx.Done():
			t.Fatal("CLI daemon did not expose registry while settings locked")
		case <-time.After(20 * time.Millisecond):
		}
	}
	after, _ := os.ReadFile(filepath.Join(dir, config.ConfigFilename))
	if string(after) != string(before) {
		t.Fatal("daemon rewrote its parent's published settings")
	}
	if err := client.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestActualCLIStatusRemainsAvailableDuringSettingsChange(t *testing.T) {
	root := t.TempDir()
	binary := filepath.Join(root, "tmatrix")
	build := exec.Command("go", "build", "-o", binary, "./cmd/tmatrix")
	build.Dir = "../.."
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build CLI: %v, %s", err, output)
	}
	cfg := config.Default()
	cfg.Sources = []config.Source{fixtureSource(cfg, "https://status-fixture.invalid/poll")}
	dir := filepath.Join(root, "private")
	if err := config.Save(dir, cfg); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/snapshot" {
			t.Errorf("status changed worker state: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(backend.Snapshot{Version: 2, InstanceID: cfg.InstanceID, MaxWorkers: 2, RunningWorkers: 1, IntakePaused: true, Pollers: []backend.Poller{{ID: "legacy", Name: "TzuDo", Type: "tzudo", URL: "https://status-fixture.invalid/poll", Status: "stopped"}}})
	}))
	defer server.Close()
	discovery, _ := json.Marshal(map[string]any{"version": 1, "url": server.URL, "token": "status-fixture-control-token", "pid": os.Getpid()})
	if err := os.WriteFile(config.DiscoveryPath(dir), discovery, 0600); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(filepath.Join(dir, config.ConfigFilename))
	release, err := config.LockSettings(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, binary, "--config-dir", dir, "status").Output()
	if err != nil {
		t.Fatalf("status blocked by source change: %v", err)
	}
	var result struct {
		Workers      int              `json:"workers"`
		IntakePaused bool             `json:"intake_paused"`
		Pollers      []backend.Poller `json:"pollers"`
	}
	if err := json.Unmarshal(output, &result); err != nil || result.Workers != 1 || !result.IntakePaused || len(result.Pollers) != 1 || result.Pollers[0].ID != "legacy" {
		t.Fatal("status lost the active source while settings were locked")
	}
	after, _ := os.ReadFile(filepath.Join(dir, config.ConfigFilename))
	if string(after) != string(before) {
		t.Fatal("status rewrote source settings")
	}
}
