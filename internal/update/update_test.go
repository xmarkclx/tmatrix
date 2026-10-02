package update

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallPrefix(t *testing.T) {
	home := t.TempDir()
	custom := filepath.Join(home, "custom prefix")
	for _, tc := range []struct {
		name, executable, override, want string
	}{
		{"default release", filepath.Join(home, ".local/lib/tmatrix/releases/1.2.3.abc/tmatrix"), "", filepath.Join(home, ".local")},
		{"custom release", filepath.Join(custom, "lib/tmatrix/releases/1.2.3.abc/tmatrix"), "", custom},
		{"environment override", filepath.Join(custom, "lib/tmatrix/releases/1.2.3.abc/tmatrix"), filepath.Join(home, "override"), filepath.Join(home, "override")},
		{"development binary", filepath.Join(home, "checkout/bin/tmatrix-20"), "", filepath.Join(home, ".local")},
		{"unbundled binary", filepath.Join(custom, "bin/tmatrix"), "", filepath.Join(home, ".local")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := installPrefix(tc.executable, tc.override, home); got != tc.want {
				t.Fatalf("prefix = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestDownloadInstaller(t *testing.T) {
	for _, tc := range []struct {
		name    string
		status  int
		body    string
		wantErr bool
	}{
		{"success", 200, "#!/bin/sh\necho fixture\n", false},
		{"not found", 404, "not found", true},
		{"server failure", 503, "try again", true},
		{"empty", 200, "", true},
		{"oversized", 200, strings.Repeat("x", maxInstallerSize+1), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				io.WriteString(w, tc.body)
			}))
			defer server.Close()
			got, err := downloadInstaller(server.Client(), server.URL)
			if (err != nil) != tc.wantErr {
				t.Fatalf("download error = %v, wantErr %v", err, tc.wantErr)
			}
			if !tc.wantErr && string(got) != tc.body {
				t.Fatal("installer content changed")
			}
			if tc.wantErr && got != nil {
				t.Fatal("failed download returned executable content")
			}
		})
	}
}

func TestDownloadInstallerRejectsTruncatedBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "100")
		io.WriteString(w, "partial installer")
	}))
	defer server.Close()
	if script, err := downloadInstaller(server.Client(), server.URL); err == nil || script != nil {
		t.Fatalf("partial download accepted: %q, %v", script, err)
	}
}

func TestInstallerRedirectRequiresHTTPS(t *testing.T) {
	requested := false
	insecure := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested = true
	}))
	defer insecure.Close()
	secure := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, insecure.URL, http.StatusFound)
	}))
	defer secure.Close()
	client := installerClient()
	client.Transport = secure.Client().Transport
	if script, err := downloadInstaller(client, secure.URL); err == nil || script != nil {
		t.Fatalf("insecure redirect accepted: %q, %v", script, err)
	}
	if requested {
		t.Fatal("HTTP redirect destination was contacted")
	}
}

func TestRunInstallerPassesLiteralArgumentsAndStreams(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh unavailable")
	}
	// Neither prefix metacharacters nor release environment overrides may change
	// the command into a different repository, pinned version, or shell source.
	t.Setenv("TMATRIX_REPO", "example/other")
	t.Setenv("TMATRIX_VERSION", "v0.0.1")
	prefix := filepath.Join(t.TempDir(), "spaces 'quotes' $(touch INJECTED); &")
	script := []byte("printf '%s\\n' \"$0\" \"$@\"\nread -r value\nprintf 'input: %s\\n' \"$value\"\nprintf 'installer progress\\n' >&2\n")
	var stdout, stderr bytes.Buffer
	if err := runInstaller(script, prefix, strings.NewReader("fixture\n"), &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	lines := strings.SplitN(stdout.String(), "\n", 2)
	if len(lines) != 2 || lines[1] != fmt.Sprintf("--repo\nxmarkclx/tmatrix\n--version\nlatest\n--prefix\n%s\ninput: fixture\n", prefix) {
		t.Fatalf("unexpected installer arguments or input: %q", stdout.String())
	}
	if stderr.String() != "installer progress\n" {
		t.Fatalf("installer stderr = %q", stderr.String())
	}
	if _, err := os.Stat(filepath.Dir(lines[0])); !os.IsNotExist(err) {
		t.Fatalf("temporary installer directory retained: %v", err)
	}
}

func TestRunInstallerReportsFailureAndCleansUp(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("sh unavailable")
	}
	var stdout, stderr bytes.Buffer
	err := runInstaller([]byte("printf '%s' \"$0\"\necho 'setup incomplete' >&2\nexit 42\n"), t.TempDir(), nil, &stdout, &stderr)
	if err == nil || !strings.Contains(err.Error(), "exit status 42") || !strings.Contains(err.Error(), "drain may still be running") {
		t.Fatalf("installer failure lost: %v", err)
	}
	if !strings.Contains(stderr.String(), "setup incomplete") {
		t.Fatal("installer failure detail not streamed")
	}
	if _, err := os.Stat(filepath.Dir(stdout.String())); !os.IsNotExist(err) {
		t.Fatalf("failed installer directory retained: %v", err)
	}
}

func TestRunRejectsRelativePrefixBeforeDownload(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if err := Run("relative", nil, &stdout, &stderr); err == nil {
		t.Fatal("relative prefix accepted")
	}
	if stdout.Len() != 0 || stderr.Len() != 0 {
		t.Fatal("update began before validation completed")
	}
}
