package webui

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/mturley/worktree/internal/uisession"
)

func batchFor(path string) notifyBatch {
	return notifyBatch{WorktreePath: path, ResourceType: "pr", ResourceID: "o/r#1", Title: "t", Tag: notifyTag(path, "pr", "o/r#1")}
}

func TestCandidateOrder(t *testing.T) {
	wt := t.TempDir()
	r := newTabRegistry()
	r.register("other", "s1", "/worktree/%2Felsewhere", true)
	r.register("home-hidden", "s1", "/", false)
	r.register("home-visible", "s1", "/", true)
	r.register("detail", "s1", "/worktree/"+urlPathEscape(wt), false)
	r.register("phone", "s2", "/worktree/"+urlPathEscape(wt), true)

	got := r.candidates(wt, "s1", "")
	want := []string{"detail", "home-visible", "home-hidden", "other"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
	if p := r.candidates(wt, "s1", "other"); p[0] != "other" {
		t.Fatalf("a preferred tab goes first, got %v", p)
	}
}

// answer acks every message arriving on send with shown.
func answer(r *tabRegistry, tab, session string, send <-chan notificationMsg, shown bool) {
	go func() {
		for m := range send {
			r.ack(tab, session, m.ID, shown)
		}
	}()
}

func TestDeliverFallsThroughDeclineAndTimeout(t *testing.T) {
	wt := t.TempDir()
	r := newTabRegistry()
	r.ackTimeout = 30 * time.Millisecond
	detailSend, _ := r.register("detail", "s1", "/worktree/"+urlPathEscape(wt), true)
	frozenSend, _ := r.register("frozen", "s1", "/", true)
	okSend, _ := r.register("ok", "s1", "/x", true)
	answer(r, "detail", "s1", detailSend, false) // no permission
	_ = frozenSend                               // never answers
	got := make(chan notificationMsg, 1)
	go func() {
		m := <-okSend
		got <- m
		r.ack("ok", "s1", m.ID, true)
	}()

	if !r.deliverToSession(batchFor(wt), "s1", "") {
		t.Fatal("delivery should succeed on the third candidate")
	}
	if m := <-got; m.Tag != notifyTag(wt, "pr", "o/r#1") || m.WorktreePath != wt {
		t.Fatalf("message = %+v", m)
	}
}

func TestDeliverDropsWhenNobodyShows(t *testing.T) {
	r := newTabRegistry()
	r.ackTimeout = 20 * time.Millisecond
	send, _ := r.register("a", "s1", "/", true)
	answer(r, "a", "s1", send, false)
	if r.deliverToSession(batchFor(t.TempDir()), "s1", "") {
		t.Fatal("no tab showed it")
	}
}

func TestReconnectKeepsNewRegistration(t *testing.T) {
	r := newTabRegistry()
	_, doneOld := r.register("a", "s1", "/", true)
	newSend, _ := r.register("a", "s1", "/", true) // reconnect, same tab id
	doneOld()                                      // the old stream's deferred cleanup runs late
	if len(r.candidates(t.TempDir(), "s1", "")) != 1 {
		t.Fatal("the old connection's cleanup removed the new registration")
	}
	answer(r, "a", "s1", newSend, true)
	if !r.deliverToSession(batchFor(t.TempDir()), "s1", "") {
		t.Fatal("delivery must use the new connection")
	}
}

func TestPresenceAndAckRefuseOtherSessions(t *testing.T) {
	s := &Server{}
	s.tabRegistry().register("a", "s1", "/", true)
	post := func(path, body, session string) int {
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(body))
		req = req.WithContext(context.WithValue(req.Context(), sessionContextKey{}, uisession.Session{Handle: session}))
		rec := httptest.NewRecorder()
		s.Handler().ServeHTTP(rec, withJSON(req))
		return rec.Code
	}
	if c := post("/api/tabs/presence", `{"tab":"a","route":"/x","visible":false}`, "s2"); c != http.StatusNotFound {
		t.Fatalf("presence from another session: %d, want 404", c)
	}
	if c := post("/api/tabs/ack", `{"tab":"a","notification_id":"n","shown":true}`, "s2"); c != http.StatusNotFound {
		t.Fatalf("ack from another session: %d, want 404", c)
	}
	if c := post("/api/tabs/presence", `{"tab":"a","route":"/x","visible":false}`, "s1"); c != http.StatusNoContent {
		t.Fatalf("own presence: %d, want 204", c)
	}
}

func withJSON(r *http.Request) *http.Request {
	r.Header.Set("Content-Type", "application/json")
	return r
}
