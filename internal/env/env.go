package env

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const Filename = ".worktree-env"

type WorktreeEnv struct {
	Ports  string // e.g. "4020-4029"
	Title  string // e.g. "wt my-branch"
	Path   string // absolute path
	Kube   string // kubeconfig path
}

func FilePath(worktreePath string) string {
	return filepath.Join(worktreePath, Filename)
}

func Generate(worktreePath string, e WorktreeEnv) error {
	lines := []string{
		"# managed by worktree - do not edit",
		fmt.Sprintf("export WORKTREE_PORTS=%s", e.Ports),
		fmt.Sprintf("export WORKTREE_TITLE=%q", e.Title),
		fmt.Sprintf("export WORKTREE_PATH=%q", e.Path),
		fmt.Sprintf("export KUBECONFIG=%q", e.Kube),
		"",
	}
	return os.WriteFile(FilePath(worktreePath), []byte(strings.Join(lines, "\n")), 0644)
}

func KubeconfigPath(repo, worktreeName string) string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".kube", fmt.Sprintf("config-%s-%s", repo, worktreeName))
}

func SeedKubeconfig(kubePath string) error {
	if _, err := os.Stat(kubePath); err == nil {
		return nil
	}

	if err := os.MkdirAll(filepath.Dir(kubePath), 0755); err != nil {
		return err
	}

	src := os.Getenv("KUBECONFIG")
	if src == "" {
		home, _ := os.UserHomeDir()
		src = filepath.Join(home, ".kube", "config")
	}

	data, err := os.ReadFile(src)
	if err != nil {
		return nil
	}
	return os.WriteFile(kubePath, data, 0600)
}
