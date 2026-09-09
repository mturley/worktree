package webui

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/mturley/watcher/slack"
)

// fakeSlack is a configurable in-memory slack.Client for tests.
type fakeSlack struct {
	thread      slack.Thread
	users       map[string]slack.User
	emoji       map[string]string
	emojiErr    error
	emojiCalls  int
	emojiMu     sync.Mutex
	channelName string
	currentUser string
	err         error

	markedTS     string
	markUnreadTS string
	replyMsg     slack.Message
	replyErr     error
	replyCalls   int

	// markRead failure injection: the first markReadFailN calls to MarkRead
	// return markReadErr (default a generic non-auth error) before it starts
	// succeeding. markReadCalls/markReadMu record call count under lock,
	// following the same pattern as searchQueries/searchMu below — the
	// handler exercises MarkRead from a request path that runs concurrently
	// with other tests in this suite.
	markReadFailN int
	markReadErr   error
	markReadCalls int
	markReadMu    sync.Mutex

	reactAddTS, reactRemoveTS, reactName string
	reactCalls                           int

	searchUsers      []slack.User
	searchUserGroups []slack.UserGroup
	searchChannels   []slack.Channel
	searchErr        error
	searchMu         sync.Mutex
	searchQueries    []string // records each query, for asserting call counts
}

func (f *fakeSlack) AuthTest(ctx context.Context) error { return f.err }

func (f *fakeSlack) WhoAmI(ctx context.Context) (string, error) { return f.currentUser, nil }

func (f *fakeSlack) Channel(ctx context.Context, id string) (string, error) {
	return f.channelName, nil
}

func (f *fakeSlack) Replies(ctx context.Context, channel, threadTS string) (slack.Thread, error) {
	if f.err != nil {
		return slack.Thread{}, f.err
	}
	return f.thread, nil
}

func (f *fakeSlack) Users(ctx context.Context, ids []string) (map[string]slack.User, error) {
	out := make(map[string]slack.User, len(ids))
	for _, id := range ids {
		if u, ok := f.users[id]; ok {
			out[id] = u
		}
	}
	return out, nil
}

func (f *fakeSlack) Emoji(ctx context.Context) (map[string]string, error) {
	f.emojiMu.Lock()
	f.emojiCalls++
	f.emojiMu.Unlock()
	return f.emoji, f.emojiErr
}

func (f *fakeSlack) emojiCallCount() int {
	f.emojiMu.Lock()
	defer f.emojiMu.Unlock()
	return f.emojiCalls
}
func (f *fakeSlack) UserGroups(ctx context.Context) (map[string]slack.UserGroup, error) {
	return nil, nil
}
func (f *fakeSlack) UserGroupsInfo(ctx context.Context, ids []string) (map[string]slack.UserGroup, error) {
	return nil, nil
}

func (f *fakeSlack) MarkRead(ctx context.Context, channel, threadTS, ts string) error {
	f.markReadMu.Lock()
	f.markReadCalls++
	calls := f.markReadCalls
	f.markReadMu.Unlock()

	if f.err != nil {
		return f.err
	}
	if calls <= f.markReadFailN {
		if f.markReadErr != nil {
			return f.markReadErr
		}
		return errors.New("slack error: message_not_found")
	}
	f.markedTS = ts
	return nil
}

// markReadCallCount returns a snapshot of markReadCalls under lock.
func (f *fakeSlack) markReadCallCount() int {
	f.markReadMu.Lock()
	defer f.markReadMu.Unlock()
	return f.markReadCalls
}

func (f *fakeSlack) MarkUnread(ctx context.Context, channel, threadTS, ts string) error {
	if f.err != nil {
		return f.err
	}
	f.markUnreadTS = ts
	return nil
}

func (f *fakeSlack) PostReply(ctx context.Context, channel, threadTS, text string) (slack.Message, error) {
	f.replyCalls++
	if f.replyErr != nil {
		return slack.Message{}, f.replyErr
	}
	return f.replyMsg, nil
}

func (f *fakeSlack) AddReaction(ctx context.Context, channel, ts, name string) error {
	f.reactCalls++
	f.reactAddTS, f.reactName = ts, name
	return f.err
}

func (f *fakeSlack) RemoveReaction(ctx context.Context, channel, ts, name string) error {
	f.reactCalls++
	f.reactRemoveTS, f.reactName = ts, name
	return f.err
}

func (f *fakeSlack) SearchUsers(ctx context.Context, query, currentChannel string, limit int) ([]slack.User, error) {
	// Honours ctx, as the real client does — this is what lets a test observe
	// whether the lookup ran on a context detached from one requester's
	// cancellation.
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f.searchMu.Lock()
	f.searchQueries = append(f.searchQueries, "users:"+query)
	f.searchMu.Unlock()
	return f.searchUsers, f.searchErr
}

func (f *fakeSlack) SearchUserGroups(ctx context.Context, query string, limit int) ([]slack.UserGroup, error) {
	f.searchMu.Lock()
	f.searchQueries = append(f.searchQueries, "groups:"+query)
	f.searchMu.Unlock()
	return f.searchUserGroups, f.searchErr
}

func (f *fakeSlack) SearchChannels(ctx context.Context, query string, limit int) ([]slack.Channel, error) {
	f.searchMu.Lock()
	f.searchQueries = append(f.searchQueries, "channels:"+query)
	f.searchMu.Unlock()
	return f.searchChannels, f.searchErr
}

// queries returns a snapshot of searchQueries under lock. Tests must use
// this instead of reading the field directly — SearchUsers/SearchUserGroups
// can be invoked concurrently by the autocomplete handler, and a direct read
// races under -race.
func (f *fakeSlack) queries() []string {
	f.searchMu.Lock()
	defer f.searchMu.Unlock()
	out := make([]string, len(f.searchQueries))
	copy(out, f.searchQueries)
	return out
}

func newFakeSlack() *fakeSlack {
	return &fakeSlack{
		thread: slack.Thread{
			Channel:  "C1",
			ThreadTS: "1.0",
			LastRead: "1.0",
			Messages: []slack.Message{
				{TS: "1.0", UserID: "U1", Text: "hello"},
			},
		},
		users: map[string]slack.User{
			"U1": {ID: "U1", RealName: "Alice"},
		},
		emoji:    map[string]string{},
		replyMsg: slack.Message{TS: "1700.9", Text: "hi"},
	}
}

func TestSlackThreadEndpoint(t *testing.T) {
	fake := newFakeSlack()
	srv := &Server{SlackClient: fake, SlackDomain: "acme.slack.com"}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/thread?channel=C1&thread_ts=1.0")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("got %d", resp.StatusCode)
	}

	var tr ThreadResponse
	if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(tr.Messages) != 1 || tr.Messages[0].TS != "1.0" {
		t.Fatalf("unexpected messages: %+v", tr.Messages)
	}
	if _, ok := tr.Users["U1"]; !ok {
		t.Fatalf("author not resolved: %v", tr.Users)
	}
}

func TestSlackReplyNoAllowlist(t *testing.T) {
	fake := newFakeSlack()
	srv := &Server{SlackClient: fake, SlackDomain: "acme.slack.com"}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := strings.NewReader(`{"channel":"C_ANY","thread_ts":"1.0","text":"hi"}`)
	resp, err := http.Post(ts.URL+"/api/thread/reply", "application/json", body)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("reply should succeed for any channel, got %d", resp.StatusCode)
	}
	if fake.replyCalls != 1 {
		t.Fatalf("PostReply not called (calls=%d)", fake.replyCalls)
	}
}

// TestSlackReplyMarkReadRetrySucceeds pins the fix for the mark-read race:
// Slack's read-state index lags chat.postMessage, so the first MarkRead
// right after PostReply can fail even though the message posted fine. The
// handler must retry and, on eventual success, must not log a failure.
func TestSlackReplyMarkReadRetrySucceeds(t *testing.T) {
	fake := newFakeSlack()
	fake.markReadFailN = 1 // fail once, then succeed
	var logBuf bytes.Buffer
	srv := &Server{SlackClient: fake, SlackDomain: "acme.slack.com", Logger: log.New(&logBuf, "", 0)}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := strings.NewReader(`{"channel":"C1","thread_ts":"1.0","text":"hi"}`)
	resp, err := http.Post(ts.URL+"/api/thread/reply", "application/json", body)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if got := fake.markReadCallCount(); got != 2 {
		t.Fatalf("expected MarkRead retried once (2 calls), got %d", got)
	}
	if logBuf.Len() != 0 {
		t.Fatalf("expected no failure logged after eventual success, got: %q", logBuf.String())
	}
}

// TestSlackReplyMarkReadRetryExhausted pins that when MarkRead never
// succeeds, the handler gives up after markReadMaxAttempts, still returns
// 200 (mark-read is best-effort and must never fail the send), and logs the
// failure exactly once.
func TestSlackReplyMarkReadRetryExhausted(t *testing.T) {
	fake := newFakeSlack()
	fake.markReadFailN = 1000 // always fail
	var logBuf bytes.Buffer
	srv := &Server{SlackClient: fake, SlackDomain: "acme.slack.com", Logger: log.New(&logBuf, "", 0)}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := strings.NewReader(`{"channel":"C1","thread_ts":"1.0","text":"hi"}`)
	resp, err := http.Post(ts.URL+"/api/thread/reply", "application/json", body)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("mark-read failure must not fail the send, got %d", resp.StatusCode)
	}
	if got := fake.markReadCallCount(); got != markReadMaxAttempts {
		t.Fatalf("expected exactly %d MarkRead attempts, got %d", markReadMaxAttempts, got)
	}
	if !strings.Contains(logBuf.String(), "mark-read after send failed") {
		t.Fatalf("expected a failure to be logged, got: %q", logBuf.String())
	}
	if n := strings.Count(logBuf.String(), "mark-read after send failed"); n != 1 {
		t.Fatalf("expected failure logged exactly once, got %d times: %q", n, logBuf.String())
	}
}

// TestSlackReplyMarkReadAuthErrorNotRetried pins that slack.ErrAuth is not
// retried — an expired token will not fix itself between attempts, so
// retrying it only adds latency to a request that is already doomed.
func TestSlackReplyMarkReadAuthErrorNotRetried(t *testing.T) {
	fake := newFakeSlack()
	fake.markReadFailN = 1000
	fake.markReadErr = slack.ErrAuth
	var logBuf bytes.Buffer
	srv := &Server{SlackClient: fake, SlackDomain: "acme.slack.com", Logger: log.New(&logBuf, "", 0)}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := strings.NewReader(`{"channel":"C1","thread_ts":"1.0","text":"hi"}`)
	resp, err := http.Post(ts.URL+"/api/thread/reply", "application/json", body)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("mark-read failure must not fail the send, got %d", resp.StatusCode)
	}
	if got := fake.markReadCallCount(); got != 1 {
		t.Fatalf("expected slack.ErrAuth to NOT be retried (1 call), got %d", got)
	}
}

// TestSlackReplyMarkReadHappyPath pins that the existing happy-path
// behaviour is unchanged: a single successful MarkRead call after a
// successful reply.
func TestSlackReplyMarkReadHappyPath(t *testing.T) {
	fake := newFakeSlack()
	var logBuf bytes.Buffer
	srv := &Server{SlackClient: fake, SlackDomain: "acme.slack.com", Logger: log.New(&logBuf, "", 0)}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := strings.NewReader(`{"channel":"C1","thread_ts":"1.0","text":"hi"}`)
	resp, err := http.Post(ts.URL+"/api/thread/reply", "application/json", body)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if got := fake.markReadCallCount(); got != 1 {
		t.Fatalf("expected exactly one MarkRead call, got %d", got)
	}
	if fake.markedTS != fake.replyMsg.TS {
		t.Fatalf("expected mark-read up through the posted message TS %q, got %q", fake.replyMsg.TS, fake.markedTS)
	}
	if logBuf.Len() != 0 {
		t.Fatalf("expected no failure logged on happy path, got: %q", logBuf.String())
	}
}

func TestSlackThreadUnconfigured(t *testing.T) {
	srv := &Server{SlackClient: nil}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/thread?channel=C1&thread_ts=1.0")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 503 {
		t.Fatalf("expected 503 when Slack unconfigured, got %d", resp.StatusCode)
	}
}

// TestCollectUserGroupIDs pins that we gather subteam ids from BOTH render
// paths — typed usergroup elements and raw mrkdwn — since a thread can arrive
// either way and a missed id means a mention renders as a placeholder.
func TestCollectUserGroupIDs(t *testing.T) {
	th := slack.Thread{Messages: []slack.Message{
		{Text: "ping <!subteam^S111> and <!subteam^S222|@handle>"},
		{Blocks: []slack.Block{{Elements: []slack.Element{
			{Type: "usergroup", UserGroupID: "S333"},
			{Type: "usergroup", UserGroupID: "S111"}, // duplicate, must dedupe
			{Type: "text", Text: "hi"},
		}}}},
	}}
	got := collectUserGroupIDs(th)
	want := map[string]bool{"S111": true, "S222": true, "S333": true}
	if len(got) != 3 {
		t.Fatalf("want 3 unique ids, got %d: %v", len(got), got)
	}
	for _, id := range got {
		if !want[id] {
			t.Errorf("unexpected id %q in %v", id, got)
		}
	}
}

// TestCollectUserGroupIDsEmpty ensures a thread with no group mentions asks
// for nothing, so no lookup request is made at all.
func TestCollectUserGroupIDsEmpty(t *testing.T) {
	th := slack.Thread{Messages: []slack.Message{{Text: "no groups here"}}}
	if got := collectUserGroupIDs(th); len(got) != 0 {
		t.Fatalf("want no ids, got %v", got)
	}
}
