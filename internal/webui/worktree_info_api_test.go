package webui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
)

func TestWorktreeInfoReturnsEnvAndGitStatus(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	wtPath := t.TempDir()
	for _, args := range [][]string{{"init", "-b", "b1"}} {
		cmd := exec.Command("git", append([]string{"-C", wtPath}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	os.WriteFile(filepath.Join(wtPath, "untracked.txt"), []byte("x\n"), 0o644)

	registry.Register(conn, registry.Entry{
		Path: wtPath, Repo: "odh", RepoRoot: "/r", Branch: "b1",
		CreatedAt: "2026-08-13T00:00:00Z",
	})

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/worktree-info?path=" + url.QueryEscape(wtPath))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got worktreeInfoDTO
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}

	// Env comes from shellenv, the same source `worktree info` prints, and
	// arrives split into key/value with the %q quoting removed.
	byKey := map[string]string{}
	for _, kv := range got.Env {
		byKey[kv.Key] = kv.Value
	}
	if byKey["WORKTREE_PATH"] != wtPath {
		t.Fatalf("WORKTREE_PATH = %q, want %q (env: %+v)", byKey["WORKTREE_PATH"], wtPath, got.Env)
	}
	if byKey["WORKTREE_TITLE"] != "wt b1" {
		t.Fatalf("WORKTREE_TITLE = %q, want %q", byKey["WORKTREE_TITLE"], "wt b1")
	}
	if v, ok := byKey["KUBECONFIG"]; !ok || v == "" {
		t.Fatalf("KUBECONFIG missing from env: %+v", got.Env)
	}

	if got.Git == nil {
		t.Fatal("git status missing for a real repo")
	}
	if got.Git.Branch != "b1" {
		t.Fatalf("branch = %q, want b1", got.Git.Branch)
	}
	if got.Git.Untracked != 1 {
		t.Fatalf("untracked = %d, want 1 (%+v)", got.Git.Untracked, *got.Git)
	}
}

func TestWorktreeInfoOmitsGitForNonRepo(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	wtPath := t.TempDir() // registered, but not a git repo
	registry.Register(conn, registry.Entry{
		Path: wtPath, Repo: "odh", RepoRoot: "/r", Branch: "b1",
		CreatedAt: "2026-08-13T00:00:00Z",
	})

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/worktree-info?path=" + url.QueryEscape(wtPath))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 — a missing git dir is a normal state", resp.StatusCode)
	}
	var got worktreeInfoDTO
	json.NewDecoder(resp.Body).Decode(&got)
	if got.Git != nil {
		t.Fatalf("expected no git status outside a repo, got %+v", *got.Git)
	}
}

func TestWorktreeInfoRequiresPath(t *testing.T) {
	conn, _ := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	defer conn.Close()
	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/worktree-info")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}
