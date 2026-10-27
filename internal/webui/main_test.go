package webui

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"os"
	"testing"

	"github.com/mturley/watcher"
	wgithub "github.com/mturley/watcher/github"
	"github.com/mturley/worktree/internal/testgit"
)

// isolatedEnv is every variable that locates the user's real config, auth
// or data: TestMain points HOME and WATCHER_HOME at a fresh temp dir and
// clears the rest (so they derive from that HOME). No test can then read
// the real watcher auth.yaml, a real GitHub token, or the real worktree DB
// by leaving a path unset. A test that needs its own still uses t.Setenv,
// which restores these values afterwards.
var isolatedEnv = []string{"HOME", "WATCHER_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "WORKTREE_DB"}

func TestMain(m *testing.M) {
	defer testgit.RemoveTemplates()
	restoreEnv, err := isolateEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, "isolating test environment:", err)
		os.Exit(1)
	}
	defer restoreEnv()
	real := ghLib
	ghLib = unstubbedGHLib()
	defer func() { ghLib = real }()
	m.Run()
}

// isolateEnv applies isolatedEnv and returns what restores the previous
// values and removes the temp dir.
func isolateEnv() (func(), error) {
	dir, err := os.MkdirTemp("", "webui-test-home-")
	if err != nil {
		return nil, err
	}
	type saved struct {
		val string
		ok  bool
	}
	prev := map[string]saved{}
	for _, k := range isolatedEnv {
		v, ok := os.LookupEnv(k)
		prev[k] = saved{v, ok}
	}
	restore := func() {
		for k, s := range prev {
			if s.ok {
				os.Setenv(k, s.val)
			} else {
				os.Unsetenv(k)
			}
		}
		os.RemoveAll(dir)
	}
	for _, k := range isolatedEnv {
		var err error
		if k == "HOME" || k == "WATCHER_HOME" {
			err = os.Setenv(k, dir)
		} else {
			err = os.Unsetenv(k)
		}
		if err != nil {
			restore()
			return nil, err
		}
	}
	return restore, nil
}

// errUnstubbed is what every ghLib function returns under test. A test
// that means to exercise one stubs the Server seam, or, for the unseamed
// calls, sets ghLib itself and restores it.
func errUnstubbed(name string) error {
	return errors.New("unstubbed GitHub seam: " + name)
}

func unstubbedGHLib() ghLibFuncs {
	return ghLibFuncs{
		FetchPRSummaries: func(string, []wgithub.PRRef) (map[wgithub.PRRef]wgithub.PRSummary, error) {
			return nil, errUnstubbed("FetchPRSummaries")
		},
		FetchReviewThreads: func(string, wgithub.PRRef) (*wgithub.PRReviewThreads, error) {
			return nil, errUnstubbed("FetchReviewThreads")
		},
		FetchPRWriteContext: func(string, wgithub.PRRef) (*wgithub.PRWriteContext, error) {
			return nil, errUnstubbed("FetchPRWriteContext")
		},
		StartReview: func(string, string, string) (string, error) {
			return "", errUnstubbed("StartReview")
		},
		AddReviewThread: func(string, string, wgithub.NewReviewComment) (int64, error) {
			return 0, errUnstubbed("AddReviewThread")
		},
		AddReviewReply: func(string, string, string, string) (int64, error) {
			return 0, errUnstubbed("AddReviewReply")
		},
		PostComment: func(string, wgithub.PRRef, string, wgithub.NewReviewComment) (int64, error) {
			return 0, errUnstubbed("PostComment")
		},
		PostReply: func(string, wgithub.PRRef, int64, string) (int64, error) {
			return 0, errUnstubbed("PostReply")
		},
		SubmitReview: func(string, string, string, string) error {
			return errUnstubbed("SubmitReview")
		},
		FetchRefs: func(context.Context, string, string, ...string) error {
			return errUnstubbed("FetchRefs")
		},
		Poll: func(*sql.DB, string, []watcher.Resource, *log.Logger) error {
			return errUnstubbed("Poll")
		},
		ViewerID: func(string) (string, error) {
			return "", errUnstubbed("ViewerID")
		},
		Validate: func(string) error {
			return errUnstubbed("Validate")
		},
	}
}
