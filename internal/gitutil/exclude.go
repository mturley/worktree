package gitutil

import (
	"os"
	"path/filepath"
	"strings"
)

const (
	markerBegin = "# BEGIN worktree managed"
	markerEnd   = "# END worktree managed"
)

var managedEntries = []string{
	".worktree-env",
	".worktree-resources",
}

func AddExcludes(repoRoot string) error {
	excludePath := filepath.Join(repoRoot, ".git", "info", "exclude")
	if err := os.MkdirAll(filepath.Dir(excludePath), 0755); err != nil {
		return err
	}

	content, _ := os.ReadFile(excludePath)
	text := string(content)

	if strings.Contains(text, markerBegin) {
		return nil
	}

	block := markerBegin + "\n"
	for _, entry := range managedEntries {
		block += entry + "\n"
	}
	block += markerEnd + "\n"

	if text != "" && !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	text += block

	return os.WriteFile(excludePath, []byte(text), 0644)
}

func RemoveExcludes(repoRoot string) error {
	excludePath := filepath.Join(repoRoot, ".git", "info", "exclude")
	content, err := os.ReadFile(excludePath)
	if err != nil {
		return nil
	}

	text := string(content)
	beginIdx := strings.Index(text, markerBegin)
	endIdx := strings.Index(text, markerEnd)
	if beginIdx < 0 || endIdx < 0 {
		return nil
	}

	endIdx += len(markerEnd)
	if endIdx < len(text) && text[endIdx] == '\n' {
		endIdx++
	}

	text = text[:beginIdx] + text[endIdx:]
	return os.WriteFile(excludePath, []byte(text), 0644)
}
