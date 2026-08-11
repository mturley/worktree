package shellenv

import (
	"path/filepath"
	"strings"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/ports"
	"github.com/mturley/worktree/internal/registry"
)

func TestLinesForRegisteredWorktree(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	wt := "/wt/my-branch"
	registry.Register(conn, registry.Entry{
		Path: wt, Repo: "repo", RepoRoot: "/repo", Branch: "my-branch", CreatedAt: "t",
	})
	ports.Allocate(conn, "my-branch") // slot 0 -> 4020-4029

	lines, err := Lines(conn, wt)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(lines, "\n")
	for _, want := range []string{
		"export WORKTREE_PORTS=4020-4029",
		`export WORKTREE_PATH="/wt/my-branch"`,
		"export WORKTREE_TITLE=",
		"export KUBECONFIG=",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in:\n%s", want, joined)
		}
	}
}

func TestLinesEmptyForUnregistered(t *testing.T) {
	conn, _ := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	defer conn.Close()
	lines, err := Lines(conn, "/not/a/worktree")
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 0 {
		t.Fatalf("expected no lines for unregistered path, got %v", lines)
	}
}
