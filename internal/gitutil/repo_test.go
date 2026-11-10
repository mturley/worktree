package gitutil

import (
	"testing"

	"github.com/mturley/worktree/internal/testgit"
)

func TestRemoteSlug(t *testing.T) {
	t.Parallel()
	wt := testgit.Worktree(t)
	for i, url := range []string{
		"git@github.com:Owner/Repo.git",
		"https://github.com/owner/repo",
		"ssh://git@github.com/owner/repo.git",
	} {
		name := "r" + string(rune('a'+i))
		runIn(t, wt, "remote", "add", name, url)
		if got := RemoteSlug(wt, name); got != "owner/repo" {
			t.Errorf("RemoteSlug(%q) = %q, want owner/repo", url, got)
		}
	}
	if got := RemoteSlug(wt, "nope"); got != "" {
		t.Errorf("unknown remote = %q, want empty", got)
	}
}
