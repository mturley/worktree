package webui

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
)

func deleteFixture(t *testing.T) (*Server, string) {
	t.Helper()
	base := t.TempDir()
	repoRoot := filepath.Join(base, "repo")
	os.MkdirAll(repoRoot, 0o755)
	git := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	git(repoRoot, "init", "-b", "main")
	os.WriteFile(filepath.Join(repoRoot, "a.txt"), []byte("one\n"), 0o644)
	git(repoRoot, "add", "a.txt")
	git(repoRoot, "commit", "-m", "init")

	wtPath := filepath.Join(base, "worktrees", "wt-1")
	git(repoRoot, "worktree", "add", "-b", "feature", wtPath)

	conn, err := wdb.OpenAt(filepath.Join(base, "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	registry.Register(conn, registry.Entry{
		Path: wtPath, Repo: "repo", RepoRoot: repoRoot, Branch: "feature",
		CreatedAt: "2026-08-26T00:00:00Z",
	})
	return &Server{DB: conn}, wtPath
}

func postDelete(t *testing.T, ts *httptest.Server, body map[string]any) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	resp, err := http.Post(ts.URL+"/api/worktrees/delete", "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func TestDeleteWorktreeReportsEveryStep(t *testing.T) {
	srv, wtPath := deleteFixture(t)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	code, body := postDelete(t, ts, map[string]any{"path": wtPath})
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200", code)
	}
	if body["ok"] != true {
		t.Fatalf("ok = %v, body = %+v", body["ok"], body)
	}
	steps, _ := body["steps"].([]any)
	if len(steps) < 6 {
		t.Fatalf("want a step per stage for the stepper, got %d: %+v", len(steps), steps)
	}
	first, _ := steps[0].(map[string]any)
	// The stepper renders these directly, so both must be present.
	if first["key"] == nil || first["label"] == nil {
		t.Fatalf("step is missing key/label: %+v", first)
	}
	if _, err := os.Stat(wtPath); !os.IsNotExist(err) {
		t.Fatal("worktree directory still present")
	}
}

// ok must be false when any cleanup step fails, even though remove_directory
// itself succeeded — a failed step is not a completed delete, and the modal
// must not treat it as one (navigating home as though everything finished).
func TestDeleteWorktreeOKIsFalseWhenAStepFails(t *testing.T) {
	srv, wtPath := deleteFixture(t)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// Close the DB out from under the handler: remove_directory is a plain
	// filesystem op and still succeeds, but every DB-backed cleanup step
	// (release_ports, unregister, remove_resources) now fails.
	if err := srv.DB.Close(); err != nil {
		t.Fatal(err)
	}

	code, body := postDelete(t, ts, map[string]any{"path": wtPath})
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200", code)
	}
	if body["ok"] != false {
		t.Fatalf("ok = %v, want false when a cleanup step failed: %+v", body["ok"], body)
	}
	steps, _ := body["steps"].([]any)
	sawFailed := false
	for _, s := range steps {
		step, _ := s.(map[string]any)
		if step["status"] == "failed" {
			sawFailed = true
		}
	}
	if !sawFailed {
		t.Fatalf("expected at least one failed step, got %+v", steps)
	}
}

// The distinction the whole flow rests on: "git wants confirmation" must not
// look like "the delete broke".
func TestDeleteWorktreeNeedsForceIsTwoHundred(t *testing.T) {
	srv, wtPath := deleteFixture(t)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// An unmerged commit on the branch makes `git branch -d` refuse.
	os.WriteFile(filepath.Join(wtPath, "b.txt"), []byte("two\n"), 0o644)
	for _, args := range [][]string{{"add", "b.txt"}, {"commit", "-m", "unmerged"}} {
		cmd := exec.Command("git", append([]string{"-C", wtPath}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
		cmd.Run()
	}

	code, body := postDelete(t, ts, map[string]any{"path": wtPath, "delete_branch": true})
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200 — needs_force is not an error", code)
	}
	if body["needs_force"] != "delete_branch" {
		t.Fatalf("needs_force = %v, want delete_branch", body["needs_force"])
	}

	code, body = postDelete(t, ts, map[string]any{
		"path": wtPath, "delete_branch": true, "force_branch": true,
	})
	if code != http.StatusOK || body["needs_force"] != "" {
		t.Fatalf("forced retry: status %d body %+v", code, body)
	}
}

func TestDeleteWorktreeRequiresPath(t *testing.T) {
	srv, _ := deleteFixture(t)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	if code, _ := postDelete(t, ts, map[string]any{}); code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", code)
	}
}

func TestDeleteWorktreeUnknownPath(t *testing.T) {
	srv, _ := deleteFixture(t)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	code, body := postDelete(t, ts, map[string]any{"path": filepath.Join(t.TempDir(), "nope")})
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200 with ok:false", code)
	}
	if body["ok"] != false {
		t.Fatalf("ok = %v, want false for a worktree that cannot be resolved", body["ok"])
	}
}

// config.Load() failure (e.g. a malformed config.yaml) must produce the same
// 200/ok:false shape as a hard runner failure — not a 500 — so the modal has
// one failure shape to render instead of two. We force a real Load() error by
// pointing XDG_CONFIG_HOME at a temp dir with invalid YAML, rather than
// touching the developer's actual config.
func TestDeleteWorktreeConfigLoadFailureIsTwoHundred(t *testing.T) {
	srv, wtPath := deleteFixture(t)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	xdg := t.TempDir()
	cfgDir := filepath.Join(xdg, "worktree")
	os.MkdirAll(cfgDir, 0o755)
	os.WriteFile(filepath.Join(cfgDir, "config.yaml"), []byte("worktrees_base: [not: a-string"), 0o644)
	t.Setenv("XDG_CONFIG_HOME", xdg)

	code, body := postDelete(t, ts, map[string]any{"path": wtPath})
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200 — config load failure is not an error status", code)
	}
	if body["ok"] != false {
		t.Fatalf("ok = %v, want false", body["ok"])
	}
	steps, ok := body["steps"].([]any)
	if !ok || len(steps) != 0 {
		t.Fatalf("steps = %+v, want empty array", body["steps"])
	}
	if body["error"] == nil || body["error"] == "" {
		t.Fatalf("error = %v, want non-empty message", body["error"])
	}
}
