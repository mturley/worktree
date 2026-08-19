// internal/slackapi/client_test.go
package slackapi

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// TestTeamInfoUsesURLHost ensures TeamInfo derives the workspace host from
// team.url (not team.domain + ".slack.com"), which matters on Enterprise
// Grid where the two diverge.
func TestTeamInfoUsesURLHost(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/team.info" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true,"team":{"url":"https://myteam.enterprise.slack.com/","domain":"myteam"}}`))
	}))
	defer srv.Close()

	c := NewWithBaseURL("xoxc-token", "xoxd-cookie", srv.URL)
	got, err := c.TeamInfo(context.Background())
	if err != nil {
		t.Fatalf("TeamInfo() error: %v", err)
	}
	if got != "myteam.enterprise.slack.com" {
		t.Fatalf("expected host from team.url, got %q", got)
	}
}

// TestTeamInfoAuthError ensures TeamInfo wraps ErrAuth when Slack rejects
// the credentials.
func TestTeamInfoAuthError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":false,"error":"invalid_auth"}`))
	}))
	defer srv.Close()

	c := NewWithBaseURL("xoxc-token", "xoxd-cookie", srv.URL)
	_, err := c.TeamInfo(context.Background())
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !errors.Is(err, ErrAuth) {
		t.Fatalf("expected wrapped ErrAuth, got: %v", err)
	}
}

// TestPostReplyReturnsCreatedMessage ensures PostReply decodes the
// chat.postMessage response's "message" object into a normalized Message.
func TestPostReplyReturnsCreatedMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true,"ts":"1700.9","message":{"ts":"1700.9","user":"U1","text":"hi"}}`))
	}))
	defer srv.Close()

	c := NewWithBaseURL("xoxc-t", "xoxd-c", srv.URL)
	msg, err := c.PostReply(context.Background(), "C1", "1.1", "hi")
	if err != nil {
		t.Fatal(err)
	}
	if msg.TS != "1700.9" || msg.Text != "hi" {
		t.Fatalf("msg=%+v", msg)
	}
}

// TestPostReplyAuthError ensures PostReply wraps ErrAuth when Slack rejects
// the credentials.
func TestPostReplyAuthError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":false,"error":"invalid_auth"}`))
	}))
	defer srv.Close()

	c := NewWithBaseURL("x", "y", srv.URL)
	if _, err := c.PostReply(context.Background(), "C", "1.1", "hi"); !errors.Is(err, ErrAuth) {
		t.Fatalf("err=%v want ErrAuth", err)
	}
}

// TestMarkUnreadPostsReadZero ensures MarkUnread calls
// subscriptions.thread.mark with read=0 (the inverse of MarkRead's read=1).
func TestMarkUnreadPostsReadZero(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	c := NewWithBaseURL("xoxc-t", "xoxd-c", srv.URL)
	if err := c.MarkUnread(context.Background(), "C1", "1.1", "1.2"); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"channel=C1", "thread_ts=1.1", "ts=1.2", "read=0"} {
		if !strings.Contains(gotBody, want) {
			t.Fatalf("body %q missing %q", gotBody, want)
		}
	}
}

func TestAddReaction_SendsParams(t *testing.T) {
	var gotPath string
	var gotForm url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = r.ParseForm()
		gotForm = r.Form
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	c := NewWithBaseURL("tok", "cook", srv.URL)
	if err := c.AddReaction(context.Background(), "C1", "1700000000.000100", "tada"); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/reactions.add" {
		t.Errorf("path = %q, want /reactions.add", gotPath)
	}
	if gotForm.Get("channel") != "C1" || gotForm.Get("timestamp") != "1700000000.000100" || gotForm.Get("name") != "tada" {
		t.Errorf("form = %v", gotForm)
	}
}

func TestAddReaction_AlreadyReactedIsSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":false,"error":"already_reacted"}`))
	}))
	defer srv.Close()
	c := NewWithBaseURL("tok", "cook", srv.URL)
	if err := c.AddReaction(context.Background(), "C1", "1", "tada"); err != nil {
		t.Errorf("already_reacted should be success, got %v", err)
	}
}

func TestRemoveReaction_NoReactionIsSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":false,"error":"no_reaction"}`))
	}))
	defer srv.Close()
	c := NewWithBaseURL("tok", "cook", srv.URL)
	if err := c.RemoveReaction(context.Background(), "C1", "1", "tada"); err != nil {
		t.Errorf("no_reaction should be success, got %v", err)
	}
}

func TestRemoveReaction_OtherErrorPropagates(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":false,"error":"message_not_found"}`))
	}))
	defer srv.Close()
	c := NewWithBaseURL("tok", "cook", srv.URL)
	if err := c.RemoveReaction(context.Background(), "C1", "1", "tada"); err == nil {
		t.Error("expected message_not_found to propagate")
	}
}
