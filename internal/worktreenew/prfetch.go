package worktreenew

import (
	"errors"
	"fmt"

	wconfig "github.com/mturley/watcher/config"
	wgithub "github.com/mturley/watcher/github"
	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/github"
)

// Creating a worktree from a pull request reads the PR with the GitHub token
// the watcher uses (watcher auth.yaml) — the gh CLI is not needed. It is
// refused, before anything is fetched, while the GitHub watcher is off.

// ErrGitHubWatcherDisabled refuses PR-based creation while the GitHub
// watcher is off: worktree never contacts GitHub then.
var ErrGitHubWatcherDisabled = errors.New("the GitHub watcher is disabled, so worktree can't read the pull request. " +
	"Run `worktree setup`, or enable it in the web UI's Settings → Connected Services → GitHub")

// ErrNoGitHubToken means there is no token to read the PR with.
var ErrNoGitHubToken = errors.New("no GitHub token is configured, so worktree can't read the pull request. " +
	"Run `worktree setup`, or add one in the web UI's Settings → Connected Services → GitHub")

// Seams for tests: the stored token, and the library's GraphQL fetch.
var (
	githubToken = func() (string, error) {
		wcfg, err := wconfig.Load(wconfig.DefaultPath())
		if err != nil {
			return "", err
		}
		gh, err := wcfg.GitHub()
		if err != nil {
			return "", err
		}
		return gh.Token, nil
	}
	fetchPRSummaries = func(token string, ref wgithub.PRRef) (map[wgithub.PRRef]wgithub.PRSummary, error) {
		return wgithub.FetchPRSummaries(token, []wgithub.PRRef{ref})
	}
)

// checkGitHubWatcher is the gate runPR applies before fetching.
func checkGitHubWatcher(cfg config.Config) error {
	if !cfg.Watchers.Enabled(config.ServiceGitHub) {
		return ErrGitHubWatcherDisabled
	}
	return nil
}

// fetchPRWithToken reads a PR's title, head branch and repo, and body with the
// watcher's GitHub token.
func fetchPRWithToken(owner, repo string, number int) (*github.PRInfo, error) {
	token, err := githubToken()
	if err != nil || token == "" {
		return nil, ErrNoGitHubToken
	}
	ref := wgithub.PRRef{Owner: owner, Repo: repo, Number: number}
	got, err := fetchPRSummaries(token, ref)
	switch {
	case errors.Is(err, wgithub.ErrAuth):
		return nil, fmt.Errorf("GitHub rejected the stored token. Replace it with `worktree setup`, " +
			"or in the web UI's Settings → Connected Services → GitHub")
	case err != nil:
		return nil, fmt.Errorf("reading %s/%s#%d from GitHub: %w", owner, repo, number, err)
	}
	s, ok := got[ref]
	if !ok {
		return nil, fmt.Errorf("pull request %s/%s#%d not found, or the GitHub token can't access it", owner, repo, number)
	}
	if s.HeadRefName == "" {
		return nil, fmt.Errorf("GitHub returned no head branch for %s/%s#%d", owner, repo, number)
	}
	return &github.PRInfo{
		Number:    number,
		Title:     s.Title,
		URL:       s.URL,
		HeadRef:   s.HeadRefName,
		HeadOwner: s.HeadRepoOwner,
		HeadRepo:  s.HeadRepoName,
		State:     s.State,
		Body:      s.Body,
	}, nil
}
