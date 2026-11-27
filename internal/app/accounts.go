package app

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"tmatrix/internal/backend"
	"tmatrix/internal/config"
)

var (
	accountProviderPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)
	accountLabelPattern    = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)
)

const accountsUsage = "Usage: tmatrix accounts list | tmatrix accounts {add|login|remove} <provider> <label>"

func RunAccounts(dir, engineOverride string, args []string, input io.Reader, output, diagnostics io.Writer) error {
	if len(args) == 0 || (len(args) == 1 && (args[0] == "--help" || args[0] == "-h")) {
		_, err := fmt.Fprintln(output, accountsUsage)
		return err
	}
	if len(args) == 1 && args[0] == "list" {
		return runAccountUtility(dir, engineOverride, args, input, output, diagnostics)
	}
	if len(args) != 3 || (args[0] != "add" && args[0] != "login" && args[0] != "remove") {
		return errors.New(accountsUsage)
	}
	action, provider, label := args[0], args[1], args[2]
	if !accountProviderPattern.MatchString(provider) {
		return errors.New("invalid account provider")
	}
	if !accountLabelPattern.MatchString(label) {
		return errors.New("account label must match ^[a-z0-9][a-z0-9-]{0,31}$")
	}
	if label == "default" && action != "login" {
		return errors.New("default is the provider's existing account and is reserved")
	}
	if action == "login" {
		return runAccountUtility(dir, engineOverride, args, input, output, diagnostics)
	}
	return manageAccountDirectory(dir, provider, label, action == "add", input, output)
}

func runAccountUtility(dir, engineOverride string, args []string, input io.Reader, output, diagnostics io.Writer) error {
	cfg, err := config.Load(dir)
	if err != nil {
		return err
	}
	if engineOverride == "" {
		engineOverride = cfg.EngineDir
	}
	engine, err := FindEngine(engineOverride)
	if err != nil {
		return err
	}
	entry := filepath.Join(engine, "dist", "account-cli.js")
	if info, err := os.Stat(entry); err != nil || !info.Mode().IsRegular() {
		return errors.New("engine update needed for account management; install or build the matching TMatrix engine")
	}
	command := append([]string{entry, dir, cfg.WorkerType, cfg.AdapterModule}, args...)
	cmd := exec.Command("node", command...)
	cmd.Env = engineEnvironment(os.Environ(), nil)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = input, output, diagnostics
	return cmd.Run()
}

func manageAccountDirectory(dir, provider, label string, create bool, input io.Reader, output io.Writer) error {
	if create {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer root.Close()

	providerPath := filepath.Join("accounts", provider)
	accountPath := filepath.Join(providerPath, label)
	var accountInfo os.FileInfo
	for _, path := range []string{"accounts", providerPath, accountPath} {
		if create {
			if err := root.Mkdir(path, 0700); err != nil && !errors.Is(err, os.ErrExist) {
				return err
			}
		}
		accountInfo, err = root.Lstat(path)
		if err != nil {
			return err
		}
		if !accountInfo.IsDir() {
			return fmt.Errorf("not an account directory: %s", filepath.Join(dir, path))
		}
	}
	fullPath := filepath.Join(dir, accountPath)
	if create {
		_, err := fmt.Fprintln(output, fullPath)
		return err
	}

	if _, err := fmt.Fprintf(output, "Remove %s? [y/N] ", fullPath); err != nil {
		return err
	}
	response, err := bufio.NewReader(input).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	switch strings.ToLower(strings.TrimSpace(response)) {
	case "y", "yes":
	default:
		return errors.New("account removal canceled")
	}
	if accountInUse(dir, provider, label) {
		return fmt.Errorf("cannot remove %s while a worker is using it", fullPath)
	}
	current, err := root.Lstat(accountPath)
	if err != nil {
		return err
	}
	if !os.SameFile(accountInfo, current) {
		return fmt.Errorf("account directory changed while confirming removal: %s", fullPath)
	}
	return root.RemoveAll(accountPath)
}

func accountInUse(dir, provider, label string) bool {
	client, err := backend.NewHTTP(config.DiscoveryPath(dir))
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	snapshot, err := client.Snapshot(ctx)
	if err != nil {
		return false
	}
	for _, worker := range snapshot.Workers {
		if worker.WorkerType == provider && worker.Account == label &&
			(worker.Status == "running" || worker.Status == "stopping" || worker.Status == "stop_unverified") {
			return true
		}
	}
	return false
}
