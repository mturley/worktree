package dotfiles

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

type Dotfile struct {
	Name string
	Path string
	IsDir bool
}

func Discover(repoRoot string) ([]Dotfile, error) {
	entries, err := os.ReadDir(repoRoot)
	if err != nil {
		return nil, err
	}

	var dotfiles []Dotfile
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, ".") || name == ".git" {
			continue
		}
		fullPath := filepath.Join(repoRoot, name)
		if isGitignored(repoRoot, name) {
			dotfiles = append(dotfiles, Dotfile{
				Name:  name,
				Path:  fullPath,
				IsDir: e.IsDir(),
			})
		}
	}
	return dotfiles, nil
}

func Copy(src, dstDir string, df Dotfile) error {
	dst := filepath.Join(dstDir, df.Name)

	if _, err := os.Stat(dst); err == nil {
		return nil
	}

	if runtime.GOOS == "darwin" {
		cmd := exec.Command("cp", "-Rc", src, dst)
		return cmd.Run()
	}

	cmd := exec.Command("cp", "-r", src, dst)
	return cmd.Run()
}

func isGitignored(repoRoot, name string) bool {
	cmd := exec.Command("git", "-C", repoRoot, "check-ignore", "-q", name)
	return cmd.Run() == nil
}
