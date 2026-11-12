package cmd

import (
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	watcherdb "github.com/mturley/watcher/db"
	wgithub "github.com/mturley/watcher/github"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/setup"
	"github.com/mturley/worktree/internal/webui"
)

// isolateLive points every config and credential path at a temp dir, so a
// live command can never read the real config or reach a service, and
// optionally writes worktree's config.yaml and a GitHub token. It also makes
// buildServer fail the test if a command would use the real one.
func isolateLive(t *testing.T, worktreeConfig string, githubToken string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	xdg := filepath.Join(home, "xdg")
	t.Setenv("XDG_CONFIG_HOME", xdg)
	if err := os.MkdirAll(filepath.Join(xdg, "worktree"), 0o755); err != nil {
		t.Fatal(err)
	}
	if worktreeConfig != "" {
		if err := os.WriteFile(filepath.Join(xdg, "worktree", "config.yaml"), []byte(worktreeConfig), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if githubToken != "" {
		auth := "services:\n  github:\n    token: " + githubToken + "\n"
		if err := os.WriteFile(filepath.Join(xdg, "worktree", "watcher-auth.yaml"), []byte(auth), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	orig := buildServer
	t.Cleanup(func() { buildServer = orig })
	buildServer = func(*sql.DB) (*webui.Server, error) {
		t.Fatal("buildServer used before the test installed its stub")
		return nil, nil
	}
}

// stubServer makes buildServer return headlessServer's result with seams set.
func stubServer(t *testing.T, set func(*webui.Server)) {
	t.Helper()
	buildServer = func(conn *sql.DB) (*webui.Server, error) {
		srv, err := headlessServer(conn)
		if err != nil {
			return nil, err
		}
		set(srv)
		return srv, nil
	}
}

// prFixture registers the live worktree (branch "feature"), follows PR
// o/r#1 on it with the PR's head cached as o/r's "feature", makes the branch
// track that through a "gh" remote for github.com/o/r, and returns the
// worktree's path.
func prFixture(t *testing.T) string {
	t.Helper()
	live, _ := seedReadFixture(t)
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := resources.Add(conn, live, resources.Resource{Type: "pr", ID: "o/r#1", URL: "https://github.com/o/r/pull/1"}); err != nil {
		t.Fatal(err)
	}
	state := `{"head_ref_name":"feature","base_ref_name":"main","head_repo_owner":"o","head_repo_name":"r"}`
	if err := watcherdb.UpsertResourceState(conn, "pr", "o/r#1", state, "2026-01-01T00:00:00Z", "x"); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"remote", "add", "gh", "https://github.com/o/r.git"},
		{"config", "branch.feature.remote", "gh"},
		{"config", "branch.feature.merge", "refs/heads/feature"},
	} {
		if out, err := exec.Command("git", append([]string{"-C", live}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	return live
}

func TestPRThreadsRefusedWhenGitHubOff(t *testing.T) {
	isolateLive(t, "watchers:\n  github: false\n", "tok")
	live := prFixture(t)
	called := false
	stubServer(t, func(s *webui.Server) {
		s.FetchPRSummaries = func(string, []wgithub.PRRef) (map[wgithub.PRRef]wgithub.PRSummary, error) {
			called = true
			return nil, errors.New("unexpected")
		}
		s.FetchReviewThreads = func(string, wgithub.PRRef) (*wgithub.PRReviewThreads, error) {
			called = true
			return nil, errors.New("unexpected")
		}
	})
	out, err := runCLI(t, "pr-threads", "list", "--worktree", live)
	if err == nil || errors.Is(err, ErrNothingFound) {
		t.Fatalf("err = %v, want a refusal (exit 2)\n%s", err, out)
	}
	if code := exitCode(err, &strings.Builder{}); code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(err.Error(), setup.WatcherOffMessage("github")) {
		t.Fatalf("err = %q, want the watcher-off message", err)
	}
	if called {
		t.Fatal("GitHub was contacted while its watcher is off")
	}
}

func stubThreads(s *webui.Server) {
	s.FetchPRSummaries = func(_ string, refs []wgithub.PRRef) (map[wgithub.PRRef]wgithub.PRSummary, error) {
		out := map[wgithub.PRRef]wgithub.PRSummary{}
		for _, r := range refs {
			out[r] = wgithub.PRSummary{Title: "A PR", State: "OPEN", URL: "https://github.com/o/r/pull/1", HeadRefName: "feature"}
		}
		return out, nil
	}
	s.FetchReviewThreads = func(string, wgithub.PRRef) (*wgithub.PRReviewThreads, error) {
		return &wgithub.PRReviewThreads{Threads: []wgithub.ReviewThread{
			{ID: "T1", IsResolved: true, Path: "a.go", DiffSide: "RIGHT", OriginalLine: 3,
				Comments: []wgithub.ThreadComment{{DatabaseID: 1, Author: "amy", Body: "done"}}},
			{ID: "T2", Path: "b.go", DiffSide: "RIGHT", OriginalLine: 7,
				Comments: []wgithub.ThreadComment{{DatabaseID: 2, Author: "bob", Body: "please fix"}}},
		}}, nil
	}
}

func TestPRThreadsJSONOpenOnly(t *testing.T) {
	isolateLive(t, "", "tok")
	live := prFixture(t)
	stubServer(t, stubThreads)

	out, err := runCLI(t, "pr-threads", "list", "--worktree", live, "--json")
	if err != nil {
		t.Fatalf("err = %v\n%s", err, out)
	}
	var threads []map[string]any
	decodeEnvelope(t, out, "threads", &threads)
	if len(threads) != 1 || threads[0]["id"] != "T2" {
		t.Fatalf("threads = %v, want only the open T2", threads)
	}
	var pr map[string]any
	decodeEnvelope(t, out, "pr", &pr)
	if pr["id"] != "o/r#1" {
		t.Fatalf("pr = %v", pr)
	}

	out, err = runCLI(t, "pr-threads", "list", "--worktree", live, "--json", "--all")
	if err != nil {
		t.Fatalf("err = %v\n%s", err, out)
	}
	decodeEnvelope(t, out, "threads", &threads)
	if len(threads) != 2 {
		t.Fatalf("--all threads = %v, want both", threads)
	}

	out, err = runCLI(t, "pr-threads", "list", "--worktree", live)
	if err != nil || !strings.Contains(out, "please fix") || strings.Contains(out, "done") {
		t.Fatalf("text = %q, err = %v", out, err)
	}
}

func TestPRThreadsNoPR(t *testing.T) {
	isolateLive(t, "", "tok")
	live, _ := seedReadFixture(t) // no PR tracked
	stubServer(t, stubThreads)

	out, err := runCLI(t, "pr-threads", "list", "--worktree", live)
	if !errors.Is(err, ErrNothingFound) || strings.TrimSpace(out) != "no open PR for this worktree's branch" {
		t.Fatalf("text: err = %v, out = %q", err, out)
	}
	out, err = runCLI(t, "pr-threads", "list", "--worktree", live, "--json")
	if !errors.Is(err, ErrNothingFound) {
		t.Fatalf("json err = %v", err)
	}
	var env map[string]json.RawMessage
	if jerr := json.Unmarshal([]byte(out), &env); jerr != nil {
		t.Fatal(jerr)
	}
	if string(env["pr"]) != "null" || string(env["threads"]) != "[]" || string(env["schema_version"]) != "1" {
		t.Fatalf("json = %s", out)
	}
}

func TestPRThreadsNoToken(t *testing.T) {
	isolateLive(t, "", "")
	live := prFixture(t)
	stubServer(t, stubThreads)
	_, err := runCLI(t, "pr-threads", "list", "--worktree", live)
	if err == nil || errors.Is(err, ErrNothingFound) || !strings.Contains(err.Error(), "no GitHub token") {
		t.Fatalf("err = %v", err)
	}
}

func TestPRThreadsFetchError(t *testing.T) {
	isolateLive(t, "", "tok")
	live := prFixture(t)
	stubServer(t, func(s *webui.Server) {
		stubThreads(s)
		s.FetchReviewThreads = func(string, wgithub.PRRef) (*wgithub.PRReviewThreads, error) {
			return nil, errors.New("boom")
		}
	})
	_, err := runCLI(t, "pr-threads", "list", "--worktree", live)
	if err == nil || errors.Is(err, ErrNothingFound) || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("err = %v", err)
	}
}
