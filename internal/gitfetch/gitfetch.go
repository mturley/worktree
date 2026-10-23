// Package gitfetch schedules background `git fetch` runs for the web UI's Code
// tab. The server calls Maybe on every status poll while the tab is open, so
// everything here is built to be called far more often than it acts: it never
// blocks, dedupes per repository (not per worktree), honours an interval, runs
// at most one fetch per repository at a time, and stays out of the way of the
// user's own git commands.
package gitfetch

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/mturley/worktree/internal/gitutil"
)

// fetchTimeout bounds one `git fetch`; a hung remote must not wedge the repo's
// slot forever.
const fetchTimeout = 60 * time.Second

// State is what the UI shows about a repository's background fetching.
type State struct {
	LastOKAt   *time.Time `json:"last_ok_at"`
	LastError  string     `json:"last_error"`
	InProgress bool       `json:"in_progress"`
}

type repoState struct {
	lastAttempt time.Time // zero until the first attempt
	lastOKAt    *time.Time
	lastError   string
	inProgress  bool
}

// Scheduler fetches remotes in the background. Now and Fetch are fields so
// tests can fake the clock and the network.
type Scheduler struct {
	// Ctx is the server's lifetime context: every fetch derives from it, so
	// shutdown cancels in-flight git processes. A request context must never
	// govern a background fetch.
	Ctx      context.Context
	Interval time.Duration
	Now      func() time.Time
	Fetch    func(ctx context.Context, dir, remote string) error

	mu    sync.Mutex
	repos map[string]*repoState
}

// New returns a Scheduler that runs the real git fetch.
func New(ctx context.Context, interval time.Duration) *Scheduler {
	return &Scheduler{
		Ctx:      ctx,
		Interval: interval,
		Now:      time.Now,
		Fetch:    gitFetch,
		repos:    map[string]*repoState{},
	}
}

// repoKey canonicalizes the repository's common git dir, so every linked
// worktree of one repo shares a key. `git rev-parse --git-common-dir` is
// relative to dir from a main worktree (".git") but absolute from a linked one,
// and on macOS temp paths differ by a /var -> /private/var symlink.
func repoKey(dir string) string {
	common := gitutil.CommonDir(dir)
	if common == "" {
		return ""
	}
	if !filepath.IsAbs(common) {
		common = filepath.Join(dir, common)
	}
	if abs, err := filepath.Abs(common); err == nil {
		common = abs
	}
	if resolved, err := filepath.EvalSymlinks(common); err == nil {
		common = resolved
	}
	return filepath.Clean(common)
}

// State reports the fetch state of dir's repository.
func (s *Scheduler) State(dir string) State {
	key := repoKey(dir)
	s.mu.Lock()
	defer s.mu.Unlock()
	rs := s.repos[key]
	if key == "" || rs == nil {
		return State{}
	}
	st := State{LastError: rs.lastError, InProgress: rs.inProgress}
	if rs.lastOKAt != nil {
		t := *rs.lastOKAt
		st.LastOKAt = &t
	}
	return st
}

// Maybe starts a background fetch of remotes for dir's repository if one is
// due. It returns immediately. It does nothing when a fetch for the repo is in
// flight, when the last attempt (successful or not) is within Interval, or when
// a git lock file shows the user's own git command is mid-flight; a skipped
// attempt does not count against the interval.
func (s *Scheduler) Maybe(dir string, remotes []string) {
	if len(remotes) == 0 || s.Ctx.Err() != nil {
		return
	}
	key := repoKey(dir)
	if key == "" {
		return
	}

	s.mu.Lock()
	rs := s.repos[key]
	if rs == nil {
		rs = &repoState{}
		s.repos[key] = rs
	}
	now := s.Now()
	if rs.inProgress || (!rs.lastAttempt.IsZero() && now.Sub(rs.lastAttempt) < s.Interval) {
		s.mu.Unlock()
		return
	}
	// Checked under the lock so a skip is atomic with the decision to start.
	if lockPresent(dir, key) {
		s.mu.Unlock()
		return
	}
	rs.inProgress = true
	rs.lastAttempt = now
	s.mu.Unlock()

	remotes = append([]string(nil), remotes...)
	bg := s.Ctx
	go func() {
		var firstErr error
		for _, r := range remotes {
			if err := s.Fetch(bg, dir, r); err != nil && firstErr == nil {
				firstErr = fmt.Errorf("fetch %s: %w", r, err)
			}
		}
		done := s.Now()
		s.mu.Lock()
		defer s.mu.Unlock()
		rs.inProgress = false
		if firstErr != nil {
			rs.lastError = redactError(firstErr.Error())
			return
		}
		rs.lastError = ""
		rs.lastOKAt = &done
	}()
}

// lockPresent reports whether git's own lock files exist in the common dir or
// the worktree's git dir. It stats a handful of names and walks only refs/,
// since it runs on every poll.
func lockPresent(dir, commonDir string) bool {
	dirs := []string{commonDir}
	if out, err := exec.Command("git", "-C", dir, "rev-parse", "--absolute-git-dir").Output(); err == nil {
		if gd := strings.TrimSpace(string(out)); gd != "" && gd != commonDir {
			dirs = append(dirs, gd)
		}
	}
	for _, d := range dirs {
		for _, name := range []string{"index.lock", "HEAD.lock", "packed-refs.lock", "shallow.lock"} {
			if _, err := os.Lstat(filepath.Join(d, name)); err == nil {
				return true
			}
		}
	}
	found := false
	_ = filepath.WalkDir(filepath.Join(commonDir, "refs"), func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable subtree: not evidence of a lock
		}
		if !d.IsDir() && strings.HasSuffix(p, ".lock") {
			found = true
			return filepath.SkipAll
		}
		return nil
	})
	return found
}

// gitFetch is the real Fetch. It must never prompt: stdin is not a terminal
// and a credential or host-key prompt would hang until the timeout.
func gitFetch(ctx context.Context, dir, remote string) error {
	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()

	ssh := os.Getenv("GIT_SSH_COMMAND")
	if ssh == "" {
		if out, err := exec.Command("git", "-C", dir, "config", "core.sshCommand").Output(); err == nil {
			ssh = strings.TrimSpace(string(out))
		}
	}
	if ssh == "" {
		ssh = "ssh"
	}

	args, env := fetchCommand(dir, remote, ssh)
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Env = append(os.Environ(), env...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// fetchCommand builds gitFetch's git arguments and the environment entries it
// appends, given the resolved ssh command. Split out so tests can check that
// every prompt path is closed without running a fetch.
func fetchCommand(dir, remote, ssh string) (args, env []string) {
	// --no-auto-maintenance: a background fetch must not kick off `git
	// maintenance`/gc, which takes locks the user's commands would then hit.
	args = []string{"-C", dir, "fetch", "--prune", "--no-auto-maintenance", remote}
	env = []string{
		"GIT_TERMINAL_PROMPT=0", // git's own username/password prompt
		"GIT_ASKPASS=",          // a configured askpass helper would pop a GUI dialog
		"SSH_ASKPASS=",
		"GCM_INTERACTIVE=never", // Git Credential Manager's browser/device flow
		"GIT_SSH_COMMAND=" + ssh + " -o BatchMode=yes", // ssh passphrase and host-key prompts
	}
	return args, env
}

// maxErrorRunes bounds LastError: git can print pages of output, and the UI
// shows the error in a tooltip.
const maxErrorRunes = 500

// credentialsInURL matches the userinfo of a URL ("https://user:token@"),
// which git echoes back in errors about https remotes with embedded tokens.
// Greedy to the URL's LAST "@": a password may hold "@" or "/" itself, so
// stopping at the first of either would leak the rest of it. A path with an
// "@" in it gets over-masked, which is the safe way to be wrong.
var credentialsInURL = regexp.MustCompile(`(\w+://)[^\s'"]*@`)

// redactError makes a fetch error safe to show in the UI: credentials in
// remote URLs are masked and the text is truncated.
func redactError(msg string) string {
	msg = credentialsInURL.ReplaceAllString(msg, "${1}***@")
	if r := []rune(msg); len(r) > maxErrorRunes {
		msg = string(r[:maxErrorRunes]) + "…"
	}
	return msg
}

// RemotesFor returns the distinct, sorted remote names behind refs such as
// "upstream/main" or "origin/feat". A ref counts when its prefix up to the
// first "/" names a configured remote, or when it is a local branch whose
// branch.<name>.remote is set.
func RemotesFor(dir string, refs ...string) []string {
	known := map[string]bool{}
	if out, err := exec.Command("git", "-C", dir, "remote").Output(); err == nil {
		for _, r := range strings.Fields(string(out)) {
			known[r] = true
		}
	}
	set := map[string]bool{}
	for _, ref := range refs {
		if prefix, _, ok := strings.Cut(ref, "/"); ok && known[prefix] {
			set[prefix] = true
			continue
		}
		out, err := exec.Command("git", "-C", dir, "config", "branch."+ref+".remote").Output()
		if err != nil {
			continue
		}
		if r := strings.TrimSpace(string(out)); known[r] {
			set[r] = true
		}
	}
	remotes := make([]string, 0, len(set))
	for r := range set {
		remotes = append(remotes, r)
	}
	sort.Strings(remotes)
	return remotes
}
