package webui

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/slackapi"
)

// fakeSlack is a configurable in-memory slackapi.Client for tests.
type fakeSlack struct {
	thread      slackapi.Thread
	users       map[string]slackapi.User
	emoji       map[string]string
	channelName string
	currentUser string
	err         error

	markedTS     string
	markUnreadTS string
	replyMsg     slackapi.Message
	replyErr     error
	replyCalls   int

	reactAddTS, reactRemoveTS, reactName string
	reactCalls                           int
}

func (f *fakeSlack) AuthTest(ctx context.Context) error { return f.err }

func (f *fakeSlack) WhoAmI(ctx context.Context) (string, error) { return f.currentUser, nil }

func (f *fakeSlack) Channel(ctx context.Context, id string) (string, error) {
	return f.channelName, nil
}

func (f *fakeSlack) Replies(ctx context.Context, channel, threadTS string) (slackapi.Thread, error) {
	if f.err != nil {
		return slackapi.Thread{}, f.err
	}
	return f.thread, nil
}

func (f *fakeSlack) Users(ctx context.Context, ids []string) (map[string]slackapi.User, error) {
	out := make(map[string]slackapi.User, len(ids))
	for _, id := range ids {
		if u, ok := f.users[id]; ok {
			out[id] = u
		}
	}
	return out, nil
}

func (f *fakeSlack) Emoji(ctx context.Context) (map[string]string, error) { return f.emoji, nil }

func (f *fakeSlack) MarkRead(ctx context.Context, channel, threadTS, ts string) error {
	if f.err != nil {
		return f.err
	}
	f.markedTS = ts
	return nil
}

func (f *fakeSlack) MarkUnread(ctx context.Context, channel, threadTS, ts string) error {
	if f.err != nil {
		return f.err
	}
	f.markUnreadTS = ts
	return nil
}

func (f *fakeSlack) PostReply(ctx context.Context, channel, threadTS, text string) (slackapi.Message, error) {
	f.replyCalls++
	if f.replyErr != nil {
		return slackapi.Message{}, f.replyErr
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

func newFakeSlack() *fakeSlack {
	return &fakeSlack{
		thread: slackapi.Thread{
			Channel:  "C1",
			ThreadTS: "1.0",
			LastRead: "1.0",
			Messages: []slackapi.Message{
				{TS: "1.0", UserID: "U1", Text: "hello"},
			},
		},
		users: map[string]slackapi.User{
			"U1": {ID: "U1", RealName: "Alice"},
		},
		emoji:    map[string]string{},
		replyMsg: slackapi.Message{TS: "1700.9", Text: "hi"},
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
