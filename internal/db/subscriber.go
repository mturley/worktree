package db

import (
	"path/filepath"
	"strings"
)

const subscriberPrefix = "worktree:"

// Subscriber returns the canonical subscriber identity for a worktree at
// worktreePath: "worktree:<canonical-absolute-path>". Symlinks are resolved
// when the path exists so the same worktree always maps to one subscriber.
func Subscriber(worktreePath string) string {
	abs, err := filepath.Abs(worktreePath)
	if err != nil {
		abs = worktreePath
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		abs = resolved
	}
	return subscriberPrefix + filepath.Clean(abs)
}

// WorktreePathFromSubscriber returns the worktree path encoded in a
// "worktree:"-prefixed subscriber string, or ok=false for any other subscriber.
func WorktreePathFromSubscriber(sub string) (string, bool) {
	if !strings.HasPrefix(sub, subscriberPrefix) {
		return "", false
	}
	return strings.TrimPrefix(sub, subscriberPrefix), true
}
