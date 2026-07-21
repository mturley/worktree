package gitutil

import (
	"os/exec"
	"strings"
)

func RepoRoot(dir string) (string, error) {
	cmd := exec.Command("git", "-C", dir, "rev-parse", "--show-toplevel")
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func CommonDir(dir string) string {
	cmd := exec.Command("git", "-C", dir, "rev-parse", "--git-common-dir")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func DefaultBranch(repoRoot string) string {
	for _, remote := range []string{"upstream", "origin"} {
		for _, branch := range []string{"main", "master"} {
			ref := remote + "/" + branch
			cmd := exec.Command("git", "-C", repoRoot, "rev-parse", "--verify", ref)
			if err := cmd.Run(); err == nil {
				return ref
			}
		}
	}
	return "HEAD"
}

func RemoteURL(repoRoot, remote string) string {
	cmd := exec.Command("git", "-C", repoRoot, "remote", "get-url", remote)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func RepoSlug(repoRoot string) string {
	for _, remote := range []string{"origin", "upstream"} {
		url := RemoteURL(repoRoot, remote)
		if url == "" {
			continue
		}
		url = strings.TrimSuffix(url, ".git")
		if idx := strings.LastIndex(url, ":"); idx >= 0 {
			return url[idx+1:]
		}
		parts := strings.Split(url, "/")
		if len(parts) >= 2 {
			return parts[len(parts)-2] + "/" + parts[len(parts)-1]
		}
	}
	return ""
}

func Fetch(repoRoot string, args ...string) error {
	cmdArgs := append([]string{"-C", repoRoot, "fetch"}, args...)
	cmd := exec.Command("git", cmdArgs...)
	cmd.Stdout = nil
	cmd.Stderr = nil
	return cmd.Run()
}
