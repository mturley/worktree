package webui

import (
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	watcher "github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/testgit"
)

func slackFixture(t *testing.T) (*Server, *sql.DB, string) {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	p := testgit.Worktree(t)
	must(t, registry.Register(conn, registry.Entry{Path: p, Repo: "r", RepoRoot: p, Branch: "b", CreatedAt: "now"}))
	return &Server{DB: conn}, conn, p
}

func followSlack(t *testing.T, conn *sql.DB, wt, id, state string) {
	t.Helper()
	ch, ts, _ := strings.Cut(id, ":")
	url := "https://x.slack.com/archives/" + ch + "/p" + strings.Replace(ts, ".", "", 1)
	must(t, resources.Add(conn, wt, resources.Resource{Type: "slack", ID: id, URL: url}))
	if state != "" {
		must(t, watcherdb.UpsertResourceState(conn, "slack", id, state, "2026-02-01T00:00:00Z", "x"))
	}
}

var slackEvN atomic.Int64

func slackEv(t *testing.T, conn *sql.DB, id, typ, ts, ext, author, body string) {
	t.Helper()
	e := watcher.Event{ID: fmt.Sprintf("se%d", slackEvN.Add(1)), TS: ts, ExternalTS: &ext, Source: "slack",
		Type: watcher.EventType(typ), Title: "t", Body: &body}
	if author != "" {
		a, aid := author, "U"+author
		e.Author, e.AuthorID = &a, &aid
	}
	must(t, watcherdb.InsertEvent(conn, e, watcher.Resource{Type: "slack", ID: id}))
}

func TestSlackMessageText(t *testing.T) {
	t.Parallel()
	for _, c := range []struct{ body, author, want string }{
		{"Ann: hello", "Ann", "hello"},
		{"Bob: hello", "Ann", "Bob: hello"},
		{"hello", "Ann", "hello"},
		{"Ann: hello", "", "Ann: hello"},
		{"Ann: Ann: hi", "Ann", "Ann: hi"},
	} {
		if got := slackMessageText(c.body, c.author); got != c.want {
			t.Errorf("slackMessageText(%q,%q) = %q, want %q", c.body, c.author, got, c.want)
		}
	}
}

func TestResolveSlackThreadByURLAndID(t *testing.T) {
	t.Parallel()
	s, conn, wt := slackFixture(t)
	followSlack(t, conn, wt, "C1:1700000000.000100", `{"title":"Deploy"}`)
	for _, ref := range []string{"slack:C1:1700000000.000100", "https://x.slack.com/archives/C1/p1700000000000100"} {
		got, err := s.ResolveSlackThread(ref)
		if err != nil || got != "C1:1700000000.000100" {
			t.Errorf("%s: got %q, %v", ref, got, err)
		}
	}
	if _, err := s.ResolveSlackThread("slack:C9:1.000001"); !errors.Is(err, ErrThreadNotFound) {
		t.Errorf("unknown id: %v", err)
	}
}

func TestResolveSlackThreadExactBeatsSubstring(t *testing.T) {
	t.Parallel()
	s, conn, wt := slackFixture(t)
	followSlack(t, conn, wt, "C1:1700000000.000100", `{"title":"Review"}`)
	followSlack(t, conn, wt, "C1:1700000001.000100", `{"title":"Review Focus 3 notes"}`)
	got, err := s.ResolveSlackThread("review")
	if err != nil || got != "C1:1700000000.000100" {
		t.Fatalf("got %q, %v", got, err)
	}
	must(t, resources.SetMeta(conn, "slack", "C1:1700000001.000100", "Review", ""))
	_, err = s.ResolveSlackThread("REVIEW")
	var amb *AmbiguousThreadError
	if !errors.As(err, &amb) || len(amb.Candidates) != 2 {
		t.Fatalf("want ambiguous exact, got %v", err)
	}
}

func TestResolveSlackThreadAmbiguous(t *testing.T) {
	t.Parallel()
	s, conn, wt := slackFixture(t)
	followSlack(t, conn, wt, "C1:1700000000.000100", `{"title":"Rollout plan"}`)
	followSlack(t, conn, wt, "C1:1700000001.000100", `{"title":"Rollout retro"}`)
	followSlack(t, conn, wt, "C1:1700000002.000100", `{"title":"Other"}`)
	slackEv(t, conn, "C1:1700000000.000100", "slack_thread_root", "2026-01-01T00:00:00Z", "1700000000.000100", "Ann", "Ann: hi")
	_, err := s.ResolveSlackThread("rollout")
	var amb *AmbiguousThreadError
	if !errors.As(err, &amb) || len(amb.Candidates) != 2 {
		t.Fatalf("got %v", err)
	}
	if err.Error() != `ambiguous: 2 threads match "rollout"` {
		t.Errorf("message %q", err.Error())
	}
	for _, c := range amb.Candidates {
		if c.FirstMessage != "" {
			t.Errorf("candidate carries a first message: %+v", c)
		}
	}
	if _, err := s.ResolveSlackThread("nothing"); !errors.Is(err, ErrThreadNotFound) {
		t.Errorf("none: %v", err)
	}
}

const sumState = `{"author":"StateAuthor","channel_name":"dev","created_ts":"1795041474.372839","updated_ts":"1795041999.000000","reply_count":3,"has_unread":true,"title":"Deploy"}`

func TestSlackThreadSummary(t *testing.T) {
	t.Parallel()
	s, conn, wt := slackFixture(t)
	id := "C1:1795041474.372839"
	followSlack(t, conn, wt, id, sumState)
	slackEv(t, conn, id, "slack_thread_root", "2026-11-17T01:00:00Z", "1795041474.372839", "Ann", "Ann: "+strings.Repeat("word ", 80))
	slackEv(t, conn, id, "slack_reply", "2026-11-17T01:05:00Z", "1795041500.000000", "Bob", "Bob: ok")
	slackEv(t, conn, id, "slack_reply", "2026-11-17T01:06:00Z", "1795041600.000000", "Cy", "Cy: ok")
	got, err := s.SlackThread(id)
	if err != nil {
		t.Fatal(err)
	}
	if got.Author != "Ann" || got.StartedAt != "2026-11-17T01:00:00Z" || got.ChannelName != "dev" || got.Title != "Deploy" {
		t.Errorf("fields: %+v", got)
	}
	if got.UpdatedAt != slackTSToRFC3339("1795041999.000000") || got.UpdatedAt == "" {
		t.Errorf("updated: %q", got.UpdatedAt)
	}
	if got.ReplyCount != 3 || got.RepliesCached != 2 || got.Complete || !got.Unread || got.Archived {
		t.Errorf("counts: %+v", got)
	}
	if n := len([]rune(got.FirstMessage)); n > 200 || !strings.HasSuffix(got.FirstMessage, "…") || strings.HasPrefix(got.FirstMessage, "Ann:") {
		t.Errorf("first message (%d runes): %q", n, got.FirstMessage)
	}
	if len(got.Worktrees) != 1 || got.Worktrees[0] != wt {
		t.Errorf("worktrees: %+v", got.Worktrees)
	}
}

func TestSlackThreadSummaryWithoutState(t *testing.T) {
	t.Parallel()
	s, conn, wt := slackFixture(t)
	id := "C1:1795041474.372839"
	followSlack(t, conn, wt, id, "")
	got, err := s.SlackThread(id)
	if err != nil {
		t.Fatal(err)
	}
	if got.ReplyCount != 0 || got.RepliesCached != 0 || !got.Complete || got.StartedAt != "" || got.FirstMessage != "" {
		t.Errorf("summary: %+v", got)
	}
	msgs, err := s.SlackThreadMessages(id)
	if err != nil || len(msgs) != 0 {
		t.Errorf("messages: %+v, %v", msgs, err)
	}
}

func TestSlackThreadMessagesOrderAndStrip(t *testing.T) {
	t.Parallel()
	s, conn, wt := slackFixture(t)
	id := "C1:1795041474.372839"
	followSlack(t, conn, wt, id, sumState)
	slackEv(t, conn, id, "slack_reply", "2026-11-17T01:06:00Z", "1795041600.000000", "Cy", "Cy: <https://e.com|late>")
	slackEv(t, conn, id, "watcher_error", "2026-11-17T01:07:00Z", "1795041700.000000", "", "boom")
	slackEv(t, conn, id, "slack_reply", "2026-11-17T01:05:00Z", "1795041500.000000", "Bob", "Bob: ok")
	slackEv(t, conn, id, "watch_started", "2026-11-17T01:01:00Z", "1795041474.372839", "", "root text")
	slackEv(t, conn, id, "slack_thread_root", "2026-11-17T01:00:00Z", "1795041474.372839", "Ann", "Ann: root text")
	msgs, err := s.SlackThreadMessages(id)
	if err != nil {
		t.Fatal(err)
	}
	var texts []string
	for _, m := range msgs {
		texts = append(texts, m.Author+"|"+m.Text)
	}
	want := "Ann|root text,Bob|ok,Cy|<https://e.com|late>"
	if strings.Join(texts, ",") != want {
		t.Errorf("got %v", texts)
	}
	if !msgs[0].Root || msgs[0].Synthesized || msgs[1].Root || msgs[0].SentAt != "2026-11-17T01:00:00Z" || msgs[0].AuthorID != "UAnn" {
		t.Errorf("flags: %+v", msgs)
	}
}

func TestSlackThreadMessagesSynthesizedRoot(t *testing.T) {
	t.Parallel()
	s, conn, wt := slackFixture(t)
	id := "C1:1795041474.372839"
	followSlack(t, conn, wt, id, sumState)
	slackEv(t, conn, id, "watch_started", "2026-11-17T01:01:00Z", "1795041474.372839", "", "the root words")
	slackEv(t, conn, id, "slack_reply", "2026-11-17T01:05:00Z", "1795041500.000000", "Bob", "Bob: ok")
	msgs, err := s.SlackThreadMessages(id)
	if err != nil || len(msgs) != 2 {
		t.Fatalf("%+v, %v", msgs, err)
	}
	r := msgs[0]
	if !r.Root || !r.Synthesized || r.Author != "StateAuthor" || r.Text != "the root words" || r.TS != "1795041474.372839" || r.SentAt == "" {
		t.Errorf("root: %+v", r)
	}
	sum, _ := s.SlackThread(id)
	if sum.FirstMessage != "the root words" || sum.Author != "StateAuthor" {
		t.Errorf("summary: %+v", sum)
	}
}

func TestSlackThreadArchived(t *testing.T) {
	t.Parallel()
	s, conn, wt := slackFixture(t)
	id := "C1:1795041474.372839"
	followSlack(t, conn, wt, id, sumState)
	slackEv(t, conn, id, "slack_thread_root", "2026-11-17T01:00:00Z", "1795041474.372839", "Ann", "Ann: gone but cached")
	must(t, resources.Remove(conn, wt, "slack", id))
	got, err := s.ResolveSlackThread("deploy")
	if err != nil || got != id {
		t.Fatalf("resolve: %q, %v", got, err)
	}
	sum, err := s.SlackThread(id)
	if err != nil || !sum.Archived || len(sum.Worktrees) != 0 || len(sum.LastFollowedBy) != 1 || sum.FirstMessage != "gone but cached" {
		t.Errorf("summary: %+v, %v", sum, err)
	}
	msgs, err := s.SlackThreadMessages(id)
	if err != nil || len(msgs) != 1 || msgs[0].Text != "gone but cached" {
		t.Errorf("messages: %+v, %v", msgs, err)
	}
}

func TestFirstMessageExcerptBound(t *testing.T) {
	t.Parallel()
	// A space at index 200: the first 200 runes end exactly on a word.
	onBoundary := strings.Repeat("a", 199) + " b" + strings.Repeat(" c", 50)
	longURL := "https://example.com/" + strings.Repeat("x", 400)
	for name, text := range map[string]string{"space at 200": strings.Repeat("a", 200) + " tail", "boundary": onBoundary, "long word": longURL} {
		got := firstMessageExcerpt(text)
		if n := len([]rune(got)); n > 200 || !strings.HasSuffix(got, "…") {
			t.Errorf("%s: %d runes: %q", name, n, got)
		}
	}
	if got := firstMessageExcerpt(longURL); len([]rune(got)) < 100 {
		t.Errorf("long first word reduced to %q", got)
	}
	if got := firstMessageExcerpt("short  text"); got != "short text" {
		t.Errorf("short: %q", got)
	}
}
