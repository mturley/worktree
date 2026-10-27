package discovery

import (
	"os/exec"
	"path/filepath"
	"strings"
)

func IsInsideWorktree(dir string) (string, bool) {
	// One git process for both answers: spawning git is the expensive part.
	// Absolute paths, since --git-common-dir is otherwise relative to dir
	// ("../.git" from a main worktree's subdirectory).
	out, err := exec.Command("git", "-C", dir, "rev-parse", "--path-format=absolute",
		"--show-toplevel", "--git-common-dir").Output()
	if err != nil {
		return "", false
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) != 2 {
		return "", false
	}
	toplevel, commonDir := lines[0], lines[1]

	if commonDir != filepath.Join(toplevel, ".git") {
		return toplevel, true
	}
	return "", false
}
