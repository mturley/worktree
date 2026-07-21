package discovery

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

type Worktree struct {
	Path     string
	Branch   string
	Repo     string
	RepoRoot string
	Prunable bool
	IsBare   bool
	Status   string // "ok", "prunable", "missing", "orphaned"
}

type RepoGroup struct {
	Repo      string
	Worktrees []Worktree
}

func Discover(searchRoots []string, maxDepth int, pruneList []string) ([]RepoGroup, error) {
	repoRoots := findGitRepos(searchRoots, maxDepth, pruneList)
	worktreesByRepo := make(map[string][]Worktree)

	for _, root := range repoRoots {
		wts, err := listWorktrees(root)
		if err != nil {
			continue
		}
		repo := filepath.Base(root)
		for _, wt := range wts {
			wt.Repo = repo
			wt.RepoRoot = root
			worktreesByRepo[repo] = append(worktreesByRepo[repo], wt)
		}
	}

	var groups []RepoGroup
	for repo, wts := range worktreesByRepo {
		if len(wts) <= 1 {
			continue
		}
		groups = append(groups, RepoGroup{Repo: repo, Worktrees: wts})
	}
	sort.Slice(groups, func(i, j int) bool {
		return groups[i].Repo < groups[j].Repo
	})
	return groups, nil
}

func findGitRepos(roots []string, maxDepth int, pruneList []string) []string {
	var repos []string
	seen := make(map[string]bool)

	for _, root := range roots {
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
			if !seen[repoRoot] {
				seen[repoRoot] = true
				repos = append(repos, repoRoot)
			}
		}
	}
	return repos
}

func listWorktrees(repoRoot string) ([]Worktree, error) {
	cmd := exec.Command("git", "-C", repoRoot, "worktree", "list", "--porcelain")
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	var worktrees []Worktree
	var current Worktree

	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "worktree "):
			if current.Path != "" {
				worktrees = append(worktrees, current)
			}
			current = Worktree{
				Path:   strings.TrimPrefix(line, "worktree "),
				Status: "ok",
			}
		case strings.HasPrefix(line, "branch "):
			ref := strings.TrimPrefix(line, "branch ")
			current.Branch = strings.TrimPrefix(ref, "refs/heads/")
		case line == "bare":
			current.IsBare = true
		case line == "prunable":
			current.Prunable = true
			current.Status = "prunable"
		case strings.HasPrefix(line, "detached"):
			current.Branch = "(detached)"
		}
	}
	if current.Path != "" {
		worktrees = append(worktrees, current)
	}

	for i := range worktrees {
		if worktrees[i].IsBare {
			continue
		}
		if _, err := os.Stat(worktrees[i].Path); os.IsNotExist(err) {
			worktrees[i].Status = "missing"
		} else if _, err := os.Stat(filepath.Join(worktrees[i].Path, ".git")); os.IsNotExist(err) {
			worktrees[i].Status = "orphaned"
		}
	}

	return worktrees, nil
}

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
