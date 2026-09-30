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
)

const (
	ConfigFilename     = "config.json"
	CredentialFilename = "credentials"
	DiscoveryFilename  = "bridge.json"
	DefaultPollURL     = "https://tzudo.app/api/v1/ai/poll"
)

type Config struct {
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

func Default() Config {
	return Config{Version: 1, MaxWorkers: 10, PollIntervalMS: 5000,
		WorkerType: "codex", PollerType: "tzudo", PollURL: DefaultPollURL,
		InstanceID: NewID()}
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
	if c.Version != 1 {
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
	if c.WorkerType == "codex" && c.AdapterModule != "" {
		return errors.New("the bundled codex adapter cannot be overridden")
	}
	if c.WorkerType != "codex" && (!filepath.IsAbs(c.AdapterModule) || len(c.AdapterModule) > 4096 || strings.ContainsRune(c.AdapterModule, '\x00')) {
		return errors.New("custom workers require an absolute adapter_module path in config.json")
	}
	if c.PollerType != "tzudo" {
		return errors.New("only the tzudo poller is available")
	}
	if len(c.InstanceID) != 36 || c.InstanceID[8] != '-' || c.InstanceID[13] != '-' || c.InstanceID[18] != '-' || c.InstanceID[23] != '-' {
		return errors.New("invalid instance ID")
	}
	if decoded, err := hex.DecodeString(strings.ReplaceAll(c.InstanceID, "-", "")); err != nil || len(decoded) != 16 {
		return errors.New("invalid instance ID")
	}
	if len(c.EngineDir) > 4096 || strings.ContainsRune(c.EngineDir, '\x00') {
		return errors.New("invalid engine directory")
	}
	return ValidatePollURL(c.PollURL)
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
	var c Config
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&c); err != nil {
		return Config{}, errors.New("settings file is not valid TMatrix JSON")
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return Config{}, errors.New("settings file contains extra data")
	}
	return c, Validate(c)
}

func Save(dir string, c Config) error {
	if err := Validate(c); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return errors.New("cannot encode settings")
	}
	return writePrivate(dir, ConfigFilename, append(data, '\n'))
}

func LoadAPIKey(dir string) (string, error) {
	data, err := readPrivate(filepath.Join(dir, CredentialFilename))
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

func SaveAPIKey(dir, key string) error {
	if err := ValidateAPIKey(key); err != nil {
		return err
	}
	return writePrivate(dir, CredentialFilename, []byte(key+"\n"))
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
	if info.Size() > 64*1024 {
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
