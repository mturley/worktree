package worktreenew

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	wgithub "github.com/mturley/watcher/github"
	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/github"
)

func stubToken(t *testing.T, tok string, err error) {
	t.Helper()
	orig := githubToken
	githubToken = func() (string, error) { return tok, err }
	t.Cleanup(func() { githubToken = orig })
}

func stubSummaries(t *testing.T, fn func(token string, ref wgithub.PRRef) (map[wgithub.PRRef]wgithub.PRSummary, error)) *int {
	t.Helper()
	calls := 0
	orig := fetchPRSummaries
	fetchPRSummaries = func(token string, ref wgithub.PRRef) (map[wgithub.PRRef]wgithub.PRSummary, error) {
		calls++
		return fn(token, ref)
	}
	t.Cleanup(func() { fetchPRSummaries = orig })
	return &calls
}

func TestFetchPRWithTokenMapsTheSummary(t *testing.T) {
	stubToken(t, "ghp_x", nil)
	stubSummaries(t, func(token string, ref wgithub.PRRef) (map[wgithub.PRRef]wgithub.PRSummary, error) {
		if token != "ghp_x" || ref != (wgithub.PRRef{Owner: "o", Repo: "r", Number: 7}) {
			t.Fatalf("token=%q ref=%+v", token, ref)
		}
		return map[wgithub.PRRef]wgithub.PRSummary{ref: {Title: "Fix it", HeadRefName: "fix-it", HeadRepoOwner: "fork", HeadRepoName: "r2",
			Body: "RHOAIENG-1", URL: "u", State: "OPEN"}}, nil
	})
	got, err := fetchPRWithToken("o", "r", 7)
	if err != nil {
		t.Fatal(err)
	}
	if *got != (github.PRInfo{Number: 7, Title: "Fix it", HeadRef: "fix-it", HeadOwner: "fork", HeadRepo: "r2",
		Body: "RHOAIENG-1", URL: "u", State: "OPEN"}) {
		t.Fatalf("%+v", got)
	}
}

func TestFetchPRWithTokenErrors(t *testing.T) {
	ref := wgithub.PRRef{Owner: "o", Repo: "r", Number: 7}
	for name, tc := range map[string]struct {
		tokErr error
		tok    string
		resp   map[wgithub.PRRef]wgithub.PRSummary
		err    error
		want   string
	}{
		"no token":  {tokErr: errors.New("not configured"), want: "no GitHub token is configured"},
		"rejected":  {tok: "t", err: fmt.Errorf("x: %w", wgithub.ErrAuth), want: "GitHub rejected the stored token"},
		"not found": {tok: "t", resp: map[wgithub.PRRef]wgithub.PRSummary{}, want: "not found, or the GitHub token can't access it"},
		"no branch": {tok: "t", resp: map[wgithub.PRRef]wgithub.PRSummary{ref: {Title: "x"}}, want: "no head branch"},
		"network":   {tok: "t", err: errors.New("dial tcp: timeout"), want: "dial tcp: timeout"},
	} {
		t.Run(name, func(t *testing.T) {
			stubToken(t, tc.tok, tc.tokErr)
			calls := stubSummaries(t, func(string, wgithub.PRRef) (map[wgithub.PRRef]wgithub.PRSummary, error) { return tc.resp, tc.err })
			_, err := fetchPRWithToken("o", "r", 7)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
			if tc.tokErr != nil && *calls != 0 {
				t.Fatal("no token, yet GitHub was called")
			}
		})
	}
}

// With the GitHub watcher off, PR-based creation stops before reading
// anything, and says how to turn it back on.
func TestRunPRRefusedWhileGitHubWatcherOff(t *testing.T) {
	repo := prRepo(t, "")
	origFetch := fetchPRInfo
	fetched := false
	fetchPRInfo = func(string, string, int) (*github.PRInfo, error) {
		fetched = true
		return nil, errors.New("unreachable")
	}
	t.Cleanup(func() { fetchPRInfo = origFetch })

	cfg := config.Config{WorktreesBase: t.TempDir()}
	cfg.Watchers.SetEnabled(config.ServiceGitHub, false)
	res := Run(nil, cfg, Options{Input: "https://github.com/owner/repo/pull/1", RepoRoot: repo}, nil)
	if !errors.Is(res.Err, ErrGitHubWatcherDisabled) {
		t.Fatalf("err = %v", res.Err)
	}
	if fetched {
		t.Fatal("GitHub was contacted while its watcher is off")
	}
	for _, want := range []string{"worktree setup", "Settings → Connected Services → GitHub"} {
		if !strings.Contains(res.Err.Error(), want) {
			t.Fatalf("error %q should mention %q", res.Err, want)
		}
	}
}
