package webui

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	wconfig "github.com/mturley/watcher/config"
	wgithub "github.com/mturley/watcher/github"

	"github.com/mturley/worktree/internal/resources"
)

// TestMainIsolatesGitHub: TestMain has replaced ghLib, and the default
// watcher paths lead into its temp HOME, not the user's real config.
func TestMainIsolatesGitHub(t *testing.T) {
	t.Parallel()
	if _, err := ghLib.FetchPRSummaries("tok", nil); err == nil || !strings.Contains(err.Error(), "unstubbed GitHub seam") {
		t.Fatalf("ghLib.FetchPRSummaries err = %v, want the unstubbed error", err)
	}
	if err := ghLib.FetchRefs(t.Context(), t.TempDir(), "origin"); err == nil {
		t.Fatal("ghLib.FetchRefs ran a real fetch")
	}
	home := os.Getenv("WATCHER_HOME")
	if home == "" || !strings.HasPrefix(wconfig.DefaultPath(), home) || !strings.HasPrefix(wconfig.ConfigDefaultPath(), home) {
		t.Fatalf("watcher paths %q, %q not under WATCHER_HOME %q", wconfig.DefaultPath(), wconfig.ConfigDefaultPath(), home)
	}
	if os.Getenv("HOME") != home {
		t.Fatalf("HOME = %q, want the isolated %q", os.Getenv("HOME"), home)
	}
}

// unseamedPRServer is gitTestServer for a worktree tracking PR o/r#1 with
// no GitHub seam stubbed, so every GitHub call falls back to ghLib.
func unseamedPRServer(t *testing.T) (*Server, string, string) {
	t.Helper()
	repo := forkRepo(t)
	wt := filepath.Join(t.TempDir(), "lw")
	gitIn(t, repo, "worktree", "add", "-b", "pr-branch", wt)
	srv, ts := gitTestServer(t, wt, nil)
	must(t, resources.Add(srv.DB, wt, resources.Resource{Type: "pr", ID: prcID, URL: "https://github.com/o/r/pull/1"}))
	return srv, ts.URL, wt
}

func guardGet(t *testing.T, base, route, wt string) (int, map[string]any) {
	t.Helper()
	resp, err := http.Get(base + route + "?path=" + url.QueryEscape(wt))
	must(t, err)
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return resp.StatusCode, out
}

func guardPost(t *testing.T, base, route string, body map[string]any) (int, map[string]any) {
	t.Helper()
	b, err := json.Marshal(body)
	must(t, err)
	resp, err := http.Post(base+route, "application/json", bytes.NewReader(b))
	must(t, err)
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return resp.StatusCode, out
}

// TestPRRoutesUnseamedNoAuth: with no auth path set, the server reads the
// isolated default (no auth.yaml), so it has no token and never calls out.
func TestPRRoutesUnseamedNoAuth(t *testing.T) {
	t.Parallel()
	_, base, wt := unseamedPRServer(t)
	code, out := guardGet(t, base, "/api/pr-comments", wt)
	if code != http.StatusOK || out["state"] != prStateNoToken {
		t.Fatalf("summary: %d %v, want 200 no_token", code, out)
	}
	code, out = guardPost(t, base, "/api/pr-write/reply", map[string]any{"path": wt, "mode": "single", "in_reply_to": 1, "body": "hi"})
	if code != http.StatusConflict || out["state"] != prStateNoToken {
		t.Fatalf("reply: %d %v, want 409 no_token", code, out)
	}
	code, out = guardPost(t, base, "/api/pr-write/submit", map[string]any{"path": wt, "head": "x", "event": "COMMENT"})
	if code != http.StatusConflict || out["state"] != prStateNoToken {
		t.Fatalf("submit: %d %v, want 409 no_token", code, out)
	}
}

// TestPRRoutesUnseamedWithToken: with a token but no seam stubbed, reads
// and writes reach ghLib's unstubbed functions and fail, never GitHub.
func TestPRRoutesUnseamedWithToken(t *testing.T) {
	t.Parallel()
	srv, base, wt := unseamedPRServer(t)
	auth := filepath.Join(t.TempDir(), "auth.yaml")
	must(t, os.WriteFile(auth, []byte("services:\n  github:\n    token: tok\n"), 0o600))
	srv.WatcherAuthPath = auth

	code, out := guardGet(t, base, "/api/pr-comments", wt)
	if code != http.StatusOK || out["state"] != prStateError {
		t.Fatalf("summary: %d %v, want 200 error", code, out)
	}
	if msg, _ := out["message"].(string); !strings.Contains(msg, "unstubbed GitHub seam") {
		t.Fatalf("summary message = %q, want the unstubbed error", msg)
	}
	for _, route := range []string{"/api/pr-comments/threads", "/api/pr-write/review"} {
		code, out := guardGet(t, base, route, wt)
		if code == http.StatusOK && out["state"] == prStateOK {
			t.Fatalf("%s: %d %v, want an error or empty state", route, code, out)
		}
	}
	code, out = guardPost(t, base, "/api/pr-write/reply", map[string]any{"path": wt, "mode": "single", "in_reply_to": 1, "body": "hi"})
	if code < 400 {
		t.Fatalf("reply: %d %v, want an error", code, out)
	}
	code, out = guardPost(t, base, "/api/pr-write/submit", map[string]any{"path": wt, "head": "x", "event": "COMMENT"})
	if code < 400 {
		t.Fatalf("submit: %d %v, want an error", code, out)
	}
}

// TestPRWriteRefusesEmptyToken: a PR reached with no token is refused
// before the write context is fetched, and the refusal is not cached.
func TestPRWriteRefusesEmptyToken(t *testing.T) {
	t.Parallel()
	srv := &Server{}
	calls := 0
	srv.FetchPRWriteContext = func(token string, _ wgithub.PRRef) (*wgithub.PRWriteContext, error) {
		calls++
		return &wgithub.PRWriteContext{PullRequestID: "PR1"}, nil
	}
	pc := testPC()
	pc.token = ""
	if _, err := srv.cachedPRWriteContext(pc.token, pc.pr.ID, pc.ref); !errors.Is(err, errNoGitHubToken) {
		t.Fatalf("cachedPRWriteContext err = %v, want errNoGitHubToken", err)
	}
	if _, err := srv.loadPRTarget(t.TempDir(), pc, false); !errors.Is(err, errNoGitHubToken) {
		t.Fatalf("loadPRTarget err = %v, want errNoGitHubToken", err)
	}
	if calls != 0 {
		t.Fatalf("write context fetched %d times with no token", calls)
	}
	if srv.viewerIsAuthor(pc) {
		t.Fatal("viewerIsAuthor with no token")
	}
	// The refusal is not remembered: a token arriving works at once.
	if _, err := srv.cachedPRWriteContext("tok", pc.pr.ID, pc.ref); err != nil || calls != 1 {
		t.Fatalf("with token: err %v, %d calls", err, calls)
	}
}
