//go:build windows

package app

import (
	"os/exec"
	"syscall"
)

func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008 | 0x00000200, HideWindow: true}
}

// A missing endpoint is not proof that a Windows process exited. Keep its
// discovery record for manual inspection instead of risking a second poller.
func processExists(pid int) bool { return true }
