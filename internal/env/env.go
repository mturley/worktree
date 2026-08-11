package env

import (
	"fmt"
	"os"
	"path/filepath"
)

type WorktreeEnv struct {
	Ports string
	Title string
	Path  string
	Kube  string
}

func KubeconfigPath(repo, worktreeName string) string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".kube", fmt.Sprintf("config-%s-%s", repo, worktreeName))
}

func SeedKubeconfig(kubePath string) error {
	if _, err := os.Stat(kubePath); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(kubePath), 0o755); err != nil {
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
	return os.WriteFile(kubePath, data, 0o600)
}
