// Package update delegates release installation to the published installer so
// checksum verification, immutable bundles and worker draining share one path.
package update

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

const installerURL = "https://github.com/xmarkclx/tmatrix/releases/latest/download/install.sh"
const maxInstallerSize = 1024 * 1024

func Run(prefix string, stdin io.Reader, stdout, stderr io.Writer) error {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		return errors.New("tmatrix update supports Linux and macOS; for live workers on Windows, run tmatrix update inside WSL")
	}
	if prefix == "" {
		executable, err := os.Executable()
		if err != nil {
			return fmt.Errorf("locate TMatrix executable: %w", err)
		}
		// macOS may report the CLI symlink rather than the immutable bundle.
		if resolved, err := filepath.EvalSymlinks(executable); err == nil {
			executable = resolved
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return fmt.Errorf("locate home directory: %w", err)
		}
		prefix = installPrefix(executable, os.Getenv("TMATRIX_PREFIX"), home)
	}
	if !filepath.IsAbs(prefix) {
		return errors.New("update prefix must be an absolute path")
	}
	if _, err := exec.LookPath("sh"); err != nil {
		return errors.New("tmatrix update requires sh on PATH")
	}
	fmt.Fprintf(stdout, "Updating TMatrix in %s from the latest official release.\nExisting workers will finish before the new engine starts; keep this command open.\n", prefix)
	script, err := downloadInstaller(installerClient(), installerURL)
	if err != nil {
		return err
	}
	return runInstaller(script, prefix, stdin, stdout, stderr)
}

func installerClient() *http.Client {
	return &http.Client{
		Timeout: time.Minute,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if req.URL.Scheme != "https" {
				return errors.New("installer redirect must use HTTPS")
			}
			if len(via) >= 10 {
				return errors.New("too many installer redirects")
			}
			return nil
		},
	}
}

func installPrefix(executable, override, home string) string {
	if override != "" {
		return override
	}
	// The installer owns <prefix>/lib/tmatrix/releases/<unique-bundle>/tmatrix.
	// Development binaries fall back to ~/.local rather than modifying a checkout.
	bundle := filepath.Dir(executable)
	releases := filepath.Dir(bundle)
	project := filepath.Dir(releases)
	lib := filepath.Dir(project)
	if filepath.Base(executable) == "tmatrix" && filepath.Base(releases) == "releases" && filepath.Base(project) == "tmatrix" && filepath.Base(lib) == "lib" {
		return filepath.Dir(lib)
	}
	return filepath.Join(home, ".local")
}

func downloadInstaller(client *http.Client, url string) ([]byte, error) {
	response, err := client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("download update installer: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download update installer: HTTP %d", response.StatusCode)
	}
	script, err := io.ReadAll(io.LimitReader(response.Body, maxInstallerSize+1))
	if err != nil {
		return nil, fmt.Errorf("read update installer: %w", err)
	}
	if len(script) == 0 || len(script) > maxInstallerSize {
		return nil, errors.New("update installer is empty or exceeds 1 MiB")
	}
	return script, nil
}

func runInstaller(script []byte, prefix string, stdin io.Reader, stdout, stderr io.Writer) error {
	dir, err := os.MkdirTemp("", "tmatrix-update-")
	if err != nil {
		return fmt.Errorf("create update directory: %w", err)
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "install.sh")
	if err := os.WriteFile(path, script, 0600); err != nil {
		return fmt.Errorf("save update installer: %w", err)
	}
	// Pass literal arguments rather than interpolating paths into shell source.
	// Only the download is time bounded: draining active workers can take hours.
	command := exec.Command("sh", path, "--repo", "xmarkclx/tmatrix", "--version", "latest", "--prefix", prefix)
	command.Stdin, command.Stdout, command.Stderr = stdin, stdout, stderr
	if err := command.Run(); err != nil {
		return fmt.Errorf("update installer failed; setup may be incomplete or a requested drain may still be running; inspect tmatrix status before retrying: %w", err)
	}
	return nil
}
