package main

import (
	"fmt"
	"runtime/debug"
	"strings"
)

// Plain go builds can identify the revision, but only the build helper and
// release pipeline have the full Git history needed for a reliable count.
func buildVersion() string {
	revision := commit
	if revision == "local" {
		if info, ok := debug.ReadBuildInfo(); ok {
			modified := false
			for _, setting := range info.Settings {
				switch setting.Key {
				case "vcs.revision":
					revision = setting.Value
				case "vcs.modified":
					modified = setting.Value == "true"
				}
			}
			if modified {
				revision += "-dirty"
			}
		}
	}
	return formatVersion(version, revision, commitCount)
}

func formatVersion(tag, revision, count string) string {
	dirty := strings.HasSuffix(revision, "-dirty")
	revision = strings.TrimSuffix(revision, "-dirty")
	if len(revision) > 12 {
		revision = revision[:12]
	}
	if dirty {
		revision += "-dirty"
	}
	if count == "" {
		count = "unknown"
	}
	return fmt.Sprintf("TMatrix %s (build %s, commit %s)", tag, count, revision)
}
