package discovery

import (
	"os/exec"
	"path/filepath"
	"strings"
)

func IsInsideWorktree(dir string) (string, bool) {
	cmd := exec.Command("git", "-C", dir, "rev-parse", "--show-toplevel")
	out, err := cmd.Output()
	if err != nil {
		return "", false
	}
	toplevel := strings.TrimSpace(string(out))

	cmd = exec.Command("git", "-C", dir, "rev-parse", "--git-common-dir")
	commonOut, err := cmd.Output()
	if err != nil {
		return "", false
	}
	commonDir := strings.TrimSpace(string(commonOut))

	gitDir := filepath.Join(toplevel, ".git")
	if commonDir != ".git" && commonDir != gitDir {
		return toplevel, true
	}
	return "", false
}
