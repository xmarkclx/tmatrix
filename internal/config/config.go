// Package config stores TMatrix's own settings. It never imports the existing
// AI Worker service's configuration or credentials.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"unicode"
)

const (
	ConfigFilename     = "config.json"
	CredentialFilename = "credentials"
	DiscoveryFilename  = "bridge.json"
	DefaultPollURL     = "https://tzudo.app/api/v1/ai/poll"
	maxPrivateFileSize = 64 * 1024
)

type Source struct {
	ID                    string `json:"id"`
	Name                  string `json:"name"`
	PollURL               string `json:"poll_url"`
	InstanceID            string `json:"instance_id"`
	CredentialID          string `json:"credential_id"`
	ConversationNamespace string `json:"conversation_namespace"`
}

type Config struct {
	AdapterModule  string `json:"adapter_module,omitempty"`
	ResumeIntake   bool   `json:"resume_intake,omitempty"`
	Version        int    `json:"version"`
	MaxWorkers     int    `json:"max_workers"`
	PollIntervalMS int    `json:"poll_interval_ms"`
	EngineDir      string `json:"engine_dir"`
	WorkerType     string `json:"worker_type"`
	// RemovedRuntimePolicy accepts settings saved before routing followed the
	// task's model. Load discards it so the next Save drops the key.
	RemovedRuntimePolicy json.RawMessage `json:"runtime_policy,omitempty"`
	InstanceID           string          `json:"instance_id"`
	UpdateOrigin         string          `json:"update_origin"`
	Sources              []Source        `json:"sources"`
}

func Default() Config {
	return Config{Version: 2, MaxWorkers: 10, PollIntervalMS: 5000, WorkerType: "codex", InstanceID: NewID(), UpdateOrigin: "https://tzudo.app", Sources: []Source{}}
}

func NewSource(name, pollURL string) Source {
	id := NewID()
	return Source{ID: id, Name: strings.TrimSpace(name), PollURL: pollURL, InstanceID: NewID(), ConversationNamespace: SourceNamespace(pollURL, id)}
}

func SourceNamespace(pollURL, id string) string {
	value, _ := json.Marshal([]string{pollURL, id})
	return string(value)
}

func PollOrigin(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	host := strings.ToLower(u.Host)
	if u.Port() == "443" {
		host = strings.TrimSuffix(host, ":443")
	}
	return u.Scheme + "://" + host
}

func validID(id string) bool {
	if len(id) != 36 || id[8] != '-' || id[13] != '-' || id[18] != '-' || id[23] != '-' {
		return false
	}
	decoded, err := hex.DecodeString(strings.ReplaceAll(id, "-", ""))
	return err == nil && len(decoded) == 16
}

func ValidateSource(source Source) error {
	if source.ID != "legacy" && !validID(source.ID) {
		return errors.New("invalid source ID")
	}
	if source.CredentialID != "legacy" && !validID(source.CredentialID) {
		return errors.New("invalid source credential reference")
	}
	if strings.TrimSpace(source.Name) == "" || len([]rune(source.Name)) > 120 || strings.IndexFunc(source.Name, unicode.IsControl) >= 0 {
		return errors.New("source name must contain 1 to 120 characters without control characters")
	}
	if !validID(source.InstanceID) {
		return errors.New("invalid source instance ID")
	}
	if source.ConversationNamespace == "" || len(source.ConversationNamespace) > 8192 {
		return errors.New("invalid conversation namespace")
	}
	return ValidatePollURL(source.PollURL)
}

// NewID returns an opaque UUID without using hostnames or existing worker IDs.
func NewID() string {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		panic("system random source unavailable")
	}
	id[6] = (id[6] & 0x0f) | 0x40
	id[8] = (id[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[0:4], id[4:6], id[6:8], id[8:10], id[10:])
}

func DefaultDir() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", errors.New("cannot locate user configuration directory; set --config-dir")
	}
	return filepath.Join(dir, "tmatrix"), nil
}

func DiscoveryPath(dir string) string { return filepath.Join(dir, DiscoveryFilename) }

func ValidatePollURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" {
		return errors.New("poll URL must use HTTPS without embedded credentials, query, or fragment")
	}
	return nil
}

func Validate(c Config) error {
	if c.Version != 2 {
		return errors.New("unsupported settings version")
	}
	if c.MaxWorkers < 1 || c.MaxWorkers > 100 {
		return errors.New("max workers must be between 1 and 100")
	}
	if c.PollIntervalMS < 250 || c.PollIntervalMS > 300000 {
		return errors.New("poll interval must be between 250 and 300000 milliseconds")
	}
	if !regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`).MatchString(c.WorkerType) {
		return errors.New("invalid worker adapter ID")
	}
	switch c.WorkerType {
	case "codex", "claude", "gemini":
		if c.AdapterModule != "" {
			return fmt.Errorf("the bundled %s adapter cannot be overridden", c.WorkerType)
		}
	default:
		if !filepath.IsAbs(c.AdapterModule) || len(c.AdapterModule) > 4096 || strings.ContainsRune(c.AdapterModule, '\x00') {
			return errors.New("custom workers require an absolute adapter_module path in config.json")
		}
	}
	if !validID(c.InstanceID) {
		return errors.New("invalid instance ID")
	}
	if ValidatePollURL(c.UpdateOrigin) != nil || PollOrigin(c.UpdateOrigin) != c.UpdateOrigin {
		return errors.New("invalid runtime update origin")
	}
	if len(c.Sources) > 32 {
		return errors.New("at most 32 sources are supported")
	}
	ids := make(map[string]bool)
	credentials := make(map[string]bool)
	for _, source := range c.Sources {
		if err := ValidateSource(source); err != nil {
			return err
		}
		if ids[source.ID] {
			return errors.New("duplicate source ID")
		}
		ids[source.ID] = true
		if credentials[source.CredentialID] {
			return errors.New("duplicate source credential reference")
		}
		credentials[source.CredentialID] = true
	}
	if len(c.EngineDir) > 4096 || strings.ContainsRune(c.EngineDir, '\x00') {
		return errors.New("invalid engine directory")
	}
	return nil
}

// Load returns fresh defaults when settings do not yet exist. The caller saves
// them once at startup, so the new poller instance ID remains stable afterward.
func Load(dir string) (Config, error) {
	data, err := readPrivate(filepath.Join(dir, ConfigFilename))
	if errors.Is(err, os.ErrNotExist) {
		return Default(), nil
	}
	if err != nil {
		return Config{}, err
	}
	var header struct {
		Version int `json:"version"`
	}
	if json.Unmarshal(data, &header) != nil {
		return Config{}, errors.New("settings file is not valid TMatrix JSON")
	}
	var c Config
	if header.Version == 1 {
		var legacy struct {
			AdapterModule  string `json:"adapter_module,omitempty"`
			ResumeIntake   bool   `json:"resume_intake,omitempty"`
			Version        int    `json:"version"`
			MaxWorkers     int    `json:"max_workers"`
			PollIntervalMS int    `json:"poll_interval_ms"`
			EngineDir      string `json:"engine_dir"`
			WorkerType     string `json:"worker_type"`
			PollerType     string `json:"poller_type"`
			PollURL        string `json:"poll_url"`
			InstanceID     string `json:"instance_id"`
		}
		if err := decodeSettings(data, &legacy); err != nil {
			return Config{}, err
		}
		if legacy.PollerType != "tzudo" {
			return Config{}, errors.New("unsupported legacy poller")
		}
		origin := PollOrigin(legacy.PollURL)
		c = Config{Version: 2, AdapterModule: legacy.AdapterModule, ResumeIntake: legacy.ResumeIntake, MaxWorkers: legacy.MaxWorkers, PollIntervalMS: legacy.PollIntervalMS, EngineDir: legacy.EngineDir, WorkerType: legacy.WorkerType, InstanceID: legacy.InstanceID, UpdateOrigin: origin, Sources: []Source{{ID: "legacy", Name: "TzuDo", PollURL: legacy.PollURL, InstanceID: legacy.InstanceID, CredentialID: "legacy", ConversationNamespace: origin}}}
	} else {
		if err := decodeSettings(data, &c); err != nil {
			return Config{}, err
		}
		if c.Sources == nil {
			c.Sources = []Source{}
		}
		c.RemovedRuntimePolicy = nil
	}
	return c, Validate(c)
}

func decodeSettings(data []byte, value any) error {
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(value) != nil {
		return errors.New("settings file is not valid TMatrix JSON")
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return errors.New("settings file contains extra data")
	}
	return nil
}

func Save(dir string, c Config) error {
	if err := Validate(c); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return errors.New("cannot encode settings")
	}
	data = append(data, '\n')
	if len(data) > maxPrivateFileSize {
		return errors.New("TMatrix configuration file is too large")
	}
	return writePrivate(dir, ConfigFilename, data)
}

func LoadAPIKey(dir string) (string, error) { return LoadSourceKey(dir, "legacy") }

func CredentialPath(dir, id string) (string, error) {
	if id == "legacy" {
		return filepath.Join(dir, CredentialFilename), nil
	}
	if !validID(id) {
		return "", errors.New("invalid source credential reference")
	}
	return filepath.Join(dir, "credentials-"+id), nil
}

func LoadSourceKey(dir, id string) (string, error) {
	path, err := CredentialPath(dir, id)
	if err != nil {
		return "", err
	}
	data, err := readPrivate(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	key := strings.TrimSpace(string(data))
	if err := ValidateAPIKey(key); err != nil {
		return "", err
	}
	return key, nil
}

func ValidateAPIKey(key string) error {
	if strings.TrimSpace(key) == "" || len(key) > 8192 || strings.IndexFunc(key, func(r rune) bool { return r <= ' ' || r == 127 }) >= 0 {
		return errors.New("API key must be a nonempty single token without whitespace")
	}
	return nil
}

func SaveAPIKey(dir, key string) error { return SaveCredential(dir, "legacy", key) }

func SaveCredential(dir, id, key string) error {
	path, err := CredentialPath(dir, id)
	if err != nil {
		return err
	}
	if err := ValidateAPIKey(key); err != nil {
		return err
	}
	return writePrivate(dir, filepath.Base(path), []byte(key+"\n"))
}

func RemoveCredential(dir, id string) error {
	path, err := CredentialPath(dir, id)
	if err != nil {
		return err
	}
	if err := validatePrivateDir(dir); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("credential file is not a private regular file")
	}
	return os.Remove(path)
}

func readPrivate(path string) ([]byte, error) {
	if err := validatePrivateDir(filepath.Dir(path)); err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0) {
		return nil, errors.New("TMatrix settings and credential files must be regular files accessible only to their owner")
	}
	if info.Size() > maxPrivateFileSize {
		return nil, errors.New("TMatrix configuration file is too large")
	}
	return os.ReadFile(path)
}

// Rename the complete, private replacement rather than truncating a file that
// another TMatrix process could be reading. Existing symlinks are rejected.
func writePrivate(dir, name string, data []byte) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return errors.New("cannot create TMatrix configuration directory")
	}
	if err := validatePrivateDir(dir); err != nil {
		return err
	}
	path := filepath.Join(dir, name)
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return errors.New("refusing to replace a non-regular configuration file")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.New("cannot inspect configuration file")
	}
	f, err := os.CreateTemp(dir, ".tmatrix-*")
	if err != nil {
		return errors.New("cannot create configuration file")
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		return errors.New("cannot write configuration file")
	}
	if err := os.Rename(f.Name(), path); err != nil {
		return errors.New("cannot save configuration file")
	}
	return nil
}

// Private files also need a private parent: a writable shared directory permits
// another account to replace discovery or credential files without reading them.
func validatePrivateDir(dir string) error {
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("TMatrix configuration directory must be a real directory")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
		return errors.New("TMatrix configuration directory must be private; run chmod 700 on it")
	}
	return nil
}

func LockSettings(dir string) (func(), error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, errors.New("cannot create private settings directory")
	}
	if err := validatePrivateDir(dir); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "settings-change.lock")
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if errors.Is(err, os.ErrExist) {
		return nil, errors.New("another settings change is in progress; inspect settings-change.lock before removing a verified stale lock")
	}
	if err != nil {
		return nil, errors.New("cannot lock TMatrix settings")
	}
	info, err := file.Stat()
	if err == nil {
		_, err = fmt.Fprintf(file, "%d\n", os.Getpid())
	}
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		_ = os.Remove(path)
		return nil, errors.New("cannot write settings lock")
	}
	return func() {
		if current, err := os.Lstat(path); err == nil && os.SameFile(info, current) {
			_ = os.Remove(path)
		}
	}, nil
}
