package gitutil

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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

func listRemotes(repoRoot string) []string {
	cmd := exec.Command("git", "-C", repoRoot, "remote")
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	return strings.Fields(string(out))
}

func DefaultBranch(repoRoot string) string {
	for _, remote := range listRemotes(repoRoot) {
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

func PullDefaultBranch(repoRoot string) error {
	ref := DefaultBranch(repoRoot)
	parts := strings.SplitN(ref, "/", 2)
	if len(parts) != 2 {
		return fmt.Errorf("cannot determine remote/branch from %s", ref)
	}
	return Fetch(repoRoot, parts[0], parts[1])
}

func RemoteURL(repoRoot, remote string) string {
	cmd := exec.Command("git", "-C", repoRoot, "remote", "get-url", remote)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func slugFromURL(url string) string {
	url = strings.TrimSuffix(url, ".git")
	if idx := strings.LastIndex(url, ":"); idx >= 0 && !strings.Contains(url[idx:], "/") {
		return url[idx+1:]
	}
	parts := strings.Split(url, "/")
	if len(parts) >= 2 {
		return parts[len(parts)-2] + "/" + parts[len(parts)-1]
	}
	return ""
}

func remoteMatchesSlug(repoRoot, remote, owner, repo string) bool {
	url := RemoteURL(repoRoot, remote)
	if url == "" {
		return false
	}
	target := strings.ToLower(owner + "/" + repo)
	url = strings.TrimSuffix(url, ".git")
	url = strings.ToLower(url)
	return strings.HasSuffix(url, "/"+target) || strings.HasSuffix(url, ":"+target)
}

func RepoSlug(repoRoot string) string {
	for _, remote := range listRemotes(repoRoot) {
		url := RemoteURL(repoRoot, remote)
		if url == "" {
			continue
		}
		if s := slugFromURL(url); s != "" {
			return s
		}
	}
	return ""
}

func Fetch(repoRoot string, args ...string) error {
	cmdArgs := append([]string{"-C", repoRoot, "fetch"}, args...)
	cmd := exec.Command("git", cmdArgs...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func FindRemoteForRepo(repoRoot, owner, repo string) (string, error) {
	remotes := listRemotes(repoRoot)
	if len(remotes) == 0 {
		return "", fmt.Errorf("no remotes configured in %s", repoRoot)
	}
	for _, remote := range remotes {
		if remoteMatchesSlug(repoRoot, remote, owner, repo) {
			return remote, nil
		}
	}
	return "", fmt.Errorf("no remote matching %s/%s found in %s", owner, repo, repoRoot)
}

func MatchesRemote(repoRoot, owner, repo string) bool {
	target := strings.ToLower(owner + "/" + repo)
	for _, remote := range listRemotes(repoRoot) {
		url := RemoteURL(repoRoot, remote)
		if url == "" {
			continue
		}
		url = strings.TrimSuffix(url, ".git")
		url = strings.ToLower(url)
		if strings.HasSuffix(url, "/"+target) || strings.HasSuffix(url, ":"+target) {
			return true
		}
	}
	return false
}

func FindRepoBySlug(owner, repo string, searchRoots []string, maxDepth int, pruneList []string) (string, error) {
	for _, root := range searchRoots {
		root = os.ExpandEnv(root)
		findArgs := []string{root, "-maxdepth", fmt.Sprintf("%d", maxDepth)}
		for _, p := range pruneList {
			findArgs = append(findArgs, "-name", p, "-prune", "-o")
		}
		findArgs = append(findArgs, "-name", ".git", "-type", "d", "-print")

		cmd := exec.Command("find", findArgs...)
		out, err := cmd.Output()
		if err != nil {
			continue
		}

		scanner := bufio.NewScanner(strings.NewReader(string(out)))
		for scanner.Scan() {
			gitDir := scanner.Text()
			repoRoot := filepath.Dir(gitDir)
			if MatchesRemote(repoRoot, owner, repo) {
				return repoRoot, nil
			}
		}
	}
	return "", fmt.Errorf("no local clone found for %s/%s", owner, repo)
}
