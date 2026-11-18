package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"tmatrix/internal/config"
)

const systemdUnit = "tmatrix.service"

var errForceStopUnavailable = errors.New("force stop requires the installed Linux/WSL systemd service for this configuration")

func (s *Service) forceStopUnitPath() (string, error) {
	if runtime.GOOS != "linux" {
		return "", errForceStopUnavailable
	}
	home, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "systemd", "user", systemdUnit), nil
}

func ownedForceStopUnit(path, dir string) bool {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 65536 {
		return false
	}
	content, err := os.ReadFile(path)
	quoted, quoteErr := systemdQuote(dir)
	if err != nil || quoteErr != nil || !strings.HasPrefix(string(content), "# Managed by tmatrix service install\n") {
		return false
	}
	for _, line := range strings.Split(string(content), "\n") {
		if strings.HasPrefix(line, "ExecStart=") {
			return strings.HasSuffix(line, " --config-dir "+quoted+" daemon")
		}
	}
	return false
}

func (s *Service) CanForceStop() bool {
	path, err := s.forceStopUnitPath()
	return err == nil && ownedForceStopUnit(path, s.Dir)
}

func (s *Service) ForceStop(ctx context.Context) error {
	path, err := s.forceStopUnitPath()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	systemd := forceStopService{
		unit: systemdUnit, unitPath: path, proc: "/proc", cgroups: "/sys/fs/cgroup",
		control: func(ctx context.Context, args ...string) (string, error) {
			data, err := exec.CommandContext(ctx, "systemctl", append([]string{"--user"}, args...)...).CombinedOutput()
			return string(data), err
		},
	}
	return systemd.stop(ctx, s.Dir)
}

type forceStopService struct {
	unit, unitPath, proc, cgroups string
	control                       func(context.Context, ...string) (string, error)
}

type serviceState struct {
	active, group, invocation string
	mainPID                   int
}

func (f forceStopService) state(ctx context.Context) (serviceState, error) {
	out, err := f.control(ctx, "show", "--property=ActiveState,MainPID,ControlGroup,FragmentPath,DropInPaths,NeedDaemonReload,InvocationID", f.unit)
	if err != nil {
		return serviceState{}, errors.New("could not inspect the installed TMatrix service")
	}
	properties := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		name, value, ok := strings.Cut(line, "=")
		if ok {
			properties[name] = value
		}
	}
	if properties["FragmentPath"] != f.unitPath || properties["DropInPaths"] != "" || properties["NeedDaemonReload"] != "no" {
		return serviceState{}, errors.New("could not verify the loaded TMatrix service matches this configuration")
	}
	pid, err := strconv.Atoi(properties["MainPID"])
	group := properties["ControlGroup"]
	if err != nil || pid < 0 || (group != "" && (!filepath.IsAbs(group) || filepath.Clean(group) != group || filepath.Base(group) != f.unit)) {
		return serviceState{}, errors.New("invalid TMatrix service process information")
	}
	return serviceState{active: properties["ActiveState"], mainPID: pid, group: group, invocation: properties["InvocationID"]}, nil
}

func (f forceStopService) processGroup(pid int) (string, error) {
	data, err := os.ReadFile(filepath.Join(f.proc, strconv.Itoa(pid), "cgroup"))
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if group, ok := strings.CutPrefix(line, "0::"); ok {
			return group, nil
		}
	}
	return "", errors.New("cannot identify the process's systemd control group")
}

func (f forceStopService) groupEmpty(group string) (bool, error) {
	if group == "" {
		return true, nil
	}
	data, err := os.ReadFile(filepath.Join(f.cgroups, group, "cgroup.events"))
	if errors.Is(err, os.ErrNotExist) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	return strings.Contains("\n"+string(data), "\npopulated 0\n"), nil
}

func (f forceStopService) engineExists(dir, ownedGroup string) (bool, error) {
	pid, err := engineDiscoveryPID(config.DiscoveryPath(dir))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	group, err := f.processGroup(pid)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if ownedGroup == "" || group != ownedGroup {
		return true, errors.New("the running engine is outside the installed TMatrix service")
	}
	return true, nil
}

func (f forceStopService) stop(ctx context.Context, dir string) error {
	if !ownedForceStopUnit(f.unitPath, dir) {
		return errForceStopUnavailable
	}
	before, err := f.state(ctx)
	if err != nil {
		return err
	}
	running, err := f.engineExists(dir, before.group)
	if err != nil {
		return err
	}
	if before.mainPID == 0 && (before.active == "inactive" || before.active == "failed") {
		empty, err := f.groupEmpty(before.group)
		if err == nil && empty && !running {
			return nil
		}
	}
	if before.mainPID <= 1 || before.group == "" || before.invocation == "" {
		return errors.New("could not identify the running TMatrix service")
	}
	profile, err := os.ReadFile(filepath.Join(f.proc, strconv.Itoa(before.mainPID), "cmdline"))
	_, argv, valid := strings.Cut(string(profile), "\x00")
	group, groupErr := f.processGroup(before.mainPID)
	if err != nil || !valid || argv != "--config-dir\x00"+dir+"\x00daemon\x00" || groupErr != nil || group != before.group {
		return errors.New("running TMatrix service belongs to another configuration or could not be verified")
	}
	caller, err := f.processGroup(os.Getpid())
	if err != nil || caller == group || strings.HasPrefix(caller, group+"/") {
		return errors.New("open TMatrix from a terminal outside the worker service to force stop it")
	}
	if _, err := os.Lstat(filepath.Join(dir, "start.lock")); !errors.Is(err, os.ErrNotExist) {
		return errors.New("TMatrix startup is in progress or could not be verified")
	}
	if _, err := f.control(ctx, "--job-mode=replace-irreversibly", "--no-block", "stop", f.unit); err != nil {
		return errors.New("could not request a stop for the installed TMatrix service")
	}

	// The queued stop suppresses the service's automatic restart. Signal only
	// the invocation we verified before asking systemd to stop it.
	pending, err := f.state(ctx)
	if err != nil {
		return err
	}
	if pending.invocation != "" && pending.invocation != before.invocation {
		return errors.New("TMatrix service restarted before force stop could be applied")
	}
	var killErr error
	if pending.active == "deactivating" || pending.active == "active" || pending.active == "activating" {
		_, killErr = f.control(ctx, "kill", "--kill-whom=all", "--signal=SIGKILL", f.unit)
	}
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		after, err := f.state(ctx)
		if err != nil {
			return err
		}
		if after.invocation != "" && after.invocation != before.invocation {
			return errors.New("TMatrix service restarted before force stop could be verified")
		}
		empty, err := f.groupEmpty(before.group)
		if err != nil {
			return errors.New("could not verify that TMatrix service processes exited")
		}
		if after.mainPID == 0 && (after.active == "inactive" || after.active == "failed") && empty {
			running, err := f.engineExists(dir, before.group)
			if err != nil {
				return errors.New("TMatrix service stopped but engine exit could not be verified")
			}
			if !running {
				return nil
			}
		}
		if killErr != nil {
			return errors.New("systemd could not force stop the TMatrix service")
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("could not verify TMatrix force stop: %w", ctx.Err())
		case <-tick.C:
		}
	}
}

func engineDiscoveryPID(path string) (int, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return 0, err
	}
	if !info.Mode().IsRegular() || info.Size() > 16384 || (runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0) {
		return 0, errors.New("engine discovery must be a private regular file")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	var record struct {
		Version int `json:"version"`
		PID     int `json:"pid"`
	}
	if json.Unmarshal(data, &record) != nil || record.Version != 1 || record.PID <= 1 {
		return 0, errors.New("invalid engine discovery process")
	}
	return record.PID, nil
}
