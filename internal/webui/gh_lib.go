package webui

import (
	"context"
	"database/sql"
	"log"

	"github.com/mturley/watcher"
	wgithub "github.com/mturley/watcher/github"
	"github.com/mturley/worktree/internal/gitfetch"
)

// ghLibFuncs is every call this package makes that reaches GitHub, or
// fetches from a git remote on GitHub's behalf.
type ghLibFuncs struct {
	FetchPRSummaries    func(token string, refs []wgithub.PRRef) (map[wgithub.PRRef]wgithub.PRSummary, error)
	FetchReviewThreads  func(token string, ref wgithub.PRRef) (*wgithub.PRReviewThreads, error)
	FetchPRWriteContext func(token string, ref wgithub.PRRef) (*wgithub.PRWriteContext, error)
	StartReview         func(token, pullRequestID, commitOid string) (string, error)
	AddReviewThread     func(token, reviewID string, c wgithub.NewReviewComment) (int64, error)
	AddReviewReply      func(token, reviewID, threadID, body string) (int64, error)
	PostComment         func(token string, ref wgithub.PRRef, commitOid string, c wgithub.NewReviewComment) (int64, error)
	PostReply           func(token string, ref wgithub.PRRef, inReplyTo int64, body string) (int64, error)
	SubmitReview        func(token, reviewID, event, body string) error
	FetchRefs           func(ctx context.Context, dir, remote string, refspecs ...string) error
	Poll                func(conn *sql.DB, token string, resources []watcher.Resource, logger *log.Logger) error
	ViewerID            func(token string) (string, error)
	Validate            func(token string) error
}

// ghLib is what every GitHub call goes through: the Server's nil seams
// (FetchPRSummaries, StartReview, FetchRefs, ...) fall back to it, and the
// unseamed calls (the poller, linked resources, self identity, credential
// checks) use it directly. In production it is the watcher library. The
// package's TestMain replaces every function with one that fails, so no
// test can reach GitHub by leaving a seam nil.
var ghLib = realGHLib()

func realGHLib() ghLibFuncs {
	return ghLibFuncs{
		FetchPRSummaries: func(token string, refs []wgithub.PRRef) (map[wgithub.PRRef]wgithub.PRSummary, error) {
			return wgithub.FetchPRSummaries(token, refs)
		},
		FetchReviewThreads: func(token string, ref wgithub.PRRef) (*wgithub.PRReviewThreads, error) {
			return wgithub.FetchReviewThreads(token, ref)
		},
		FetchPRWriteContext: func(token string, ref wgithub.PRRef) (*wgithub.PRWriteContext, error) {
			return wgithub.FetchPRWriteContext(token, ref)
		},
		StartReview: func(token, pullRequestID, commitOid string) (string, error) {
			return wgithub.StartReview(token, pullRequestID, commitOid)
		},
		AddReviewThread: func(token, reviewID string, c wgithub.NewReviewComment) (int64, error) {
			return wgithub.AddReviewThread(token, reviewID, c)
		},
		AddReviewReply: func(token, reviewID, threadID, body string) (int64, error) {
			return wgithub.AddReviewReply(token, reviewID, threadID, body)
		},
		PostComment: func(token string, ref wgithub.PRRef, commitOid string, c wgithub.NewReviewComment) (int64, error) {
			return wgithub.PostComment(token, ref, commitOid, c)
		},
		PostReply: func(token string, ref wgithub.PRRef, inReplyTo int64, body string) (int64, error) {
			return wgithub.PostReply(token, ref, inReplyTo, body)
		},
		SubmitReview: func(token, reviewID, event, body string) error {
			return wgithub.SubmitReview(token, reviewID, event, body)
		},
		FetchRefs: gitfetch.FetchRefs,
		Poll:      wgithub.Poll,
		ViewerID: func(token string) (string, error) {
			return wgithub.ViewerID(token)
		},
		Validate: func(token string) error {
			return wgithub.Validate(token)
		},
	}
}
