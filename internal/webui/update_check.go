package webui

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// The repo whose main branch an installed binary is compared against. Public,
// so the compare API needs no token (60 unauthenticated requests an hour per
// IP; the check runs a few times an hour at most).
const (
	updateRepo       = "mturley/worktree"
	updateBranch     = "main"
	updateDetailsURL = "https://github.com/" + updateRepo + "/commits/" + updateBranch
)

// updateStatus is what GET /api/update-status returns.
type updateStatus struct {
	// Available is true only when main has commits this binary lacks. Every
	// failure — no build commit, a commit GitHub has never seen (a local
	// build of unpushed work), the network — leaves it false: a banner that
	// might be wrong is worse than none.
	Available  bool   `json:"available"`
	BehindBy   int    `json:"behind_by"`
	DetailsURL string `json:"details_url"`
}

type updateChecker struct {
	mu     sync.Mutex
	status updateStatus
}

func (s *Server) updateCheckerOrInit() *updateChecker {
	s.updateOnce.Do(func() { s.update = &updateChecker{} })
	return s.update
}

// StartUpdateCheck compares BuildCommit against the repo's main branch now and
// then every interval. Without a build commit (a `go run`, or a build outside
// a git checkout) there is nothing to compare, so it does nothing.
func (s *Server) StartUpdateCheck(interval time.Duration) (stop func()) {
	if s.BuildCommit == "" {
		s.logger().Printf("update check disabled: binary has no build commit")
		return func() {}
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			s.checkForUpdate(ctx)
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
	return cancel
}

func (s *Server) checkForUpdate(ctx context.Context) {
	behind, err := s.commitsBehind(ctx, s.BuildCommit)
	if err != nil {
		// Keep the last good answer: one failed request should not make a
		// known update disappear and reappear.
		s.logger().Printf("update check: %v", err)
		return
	}
	c := s.updateCheckerOrInit()
	c.mu.Lock()
	c.status = updateStatus{Available: behind > 0, BehindBy: behind}
	c.mu.Unlock()
}

// commitsBehind asks GitHub how many commits main has that commit does not.
func (s *Server) commitsBehind(ctx context.Context, commit string) (int, error) {
	base := s.updateAPIBase
	if base == "" {
		base = "https://api.github.com"
	}
	u := fmt.Sprintf("%s/repos/%s/compare/%s...%s", base, updateRepo, url.PathEscape(commit), updateBranch)
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// 404 is the usual one: the binary was built from a commit that was
		// never pushed.
		return 0, fmt.Errorf("compare %s...%s: HTTP %d", commit, updateBranch, resp.StatusCode)
	}
	var body struct {
		AheadBy int `json:"ahead_by"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return 0, fmt.Errorf("compare response: %w", err)
	}
	// In base...head with head = main, ahead_by counts main's commits that
	// the build lacks, which is exactly "behind" from the binary's side.
	return body.AheadBy, nil
}

// handleUpdateStatus: GET /api/update-status
func (s *Server) handleUpdateStatus(w http.ResponseWriter, r *http.Request) {
	c := s.updateCheckerOrInit()
	c.mu.Lock()
	st := c.status
	c.mu.Unlock()
	st.DetailsURL = updateDetailsURL
	writeJSON(w, http.StatusOK, st)
}
