package setup

import (
	"strings"
	"testing"
)

func TestZshSnippetUsesWorktreeEnv(t *testing.T) {
	rc := ShellRC{Shell: "zsh"}
	s := rc.snippet()
	if strings.Contains(s, ".worktree-env") || strings.Contains(s, "source ") {
		t.Fatalf("snippet must not source a file:\n%s", s)
	}
	if !strings.Contains(s, `eval "$(worktree env)"`) {
		t.Fatalf("snippet must eval worktree env:\n%s", s)
	}
}

func TestBashAndFishSnippetsEvalWorktreeEnv(t *testing.T) {
	for _, sh := range []string{"bash", "fish"} {
		s := ShellRC{Shell: sh}.snippet()
		if !strings.Contains(s, "worktree env") {
			t.Fatalf("%s snippet must call worktree env:\n%s", sh, s)
		}
	}
}
