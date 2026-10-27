package discovery

import (
	"os/exec"
	"path/filepath"
	"strings"
)

func IsInsideWorktree(dir string) (string, bool) {
	// One git process for both answers: spawning git is the expensive part.
	out, err := exec.Command("git", "-C", dir, "rev-parse", "--show-toplevel", "--git-common-dir").Output()
	if err != nil {
		return "", false
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) != 2 {
		return "", false
	}
	toplevel, commonDir := lines[0], lines[1]

	gitDir := filepath.Join(toplevel, ".git")
	if commonDir != ".git" && commonDir != gitDir {
		return toplevel, true
	}
	return "", false
}
