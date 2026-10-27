package discovery

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/mturley/worktree/internal/testgit"
)

func TestMain(m *testing.M) {
	defer testgit.RemoveTemplates()
	m.Run()
}

func TestIsInsideWorktree(t *testing.T) {
	wt := testgit.Worktree(t)
	main := filepath.Join(filepath.Dir(wt), "repo")
	for _, dir := range []string{main, wt} {
		if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for dir, want := range map[string]bool{
		main:                       false,
		filepath.Join(main, "sub"): false, // git prints a relative ../.git here
		wt:                         true,
		filepath.Join(wt, "sub"):   true,
		t.TempDir():                false,
	} {
		if _, got := IsInsideWorktree(dir); got != want {
			t.Errorf("IsInsideWorktree(%s) = %v, want %v", dir, got, want)
		}
	}
}
