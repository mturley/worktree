package tasks

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
)

var (
	prLink   = LinkTarget{Kind: LinkResource, ResourceType: "pr", ResourceID: "o/r#1"}
	jiraLink = LinkTarget{Kind: LinkResource, ResourceType: "jira", ResourceID: "ABC-1"}
	pr2Link  = LinkTarget{Kind: LinkResource, ResourceType: "pr", ResourceID: "o/r#2"}
)

// canon returns the canonical form of a worktree path, as stored.
func canon(p string) string {
	c, _ := wdb.WorktreePathFromSubscriber(wdb.Subscriber(p))
	return c
}

func register(t *testing.T, conn *sql.DB, path string) {
	t.Helper()
	if err := registry.Register(conn, registry.Entry{Path: path, Repo: "r", RepoRoot: "/r", Branch: "b", CreatedAt: now()}); err != nil {
		t.Fatal(err)
	}
}

func mustGet(t *testing.T, conn *sql.DB, id int64) Task {
	t.Helper()
	tk, err := Get(conn, id)
	if err != nil {
		t.Fatal(err)
	}
	return tk
}

func mustAddLink(t *testing.T, conn *sql.DB, id int64, lt LinkTarget, focus bool) Link {
	t.Helper()
	l, err := AddLink(conn, user, id, lt, focus)
	if err != nil {
		t.Fatal(err)
	}
	return l
}

func eventsOfType(t *testing.T, conn *sql.DB, id int64, typ string) []Event {
	t.Helper()
	ev, err := Events(conn, id)
	if err != nil {
		t.Fatal(err)
	}
	var out []Event
	for _, e := range ev {
		if e.Type == typ {
			out = append(out, e)
		}
	}
	return out
}

func TestCreateWithFocusContext(t *testing.T) {
	conn := newDB(t)
	tk, err := Create(conn, user, NewTask{Title: "x", Focus: []LinkTarget{prLink}})
	if err != nil {
		t.Fatal(err)
	}
	got := mustGet(t, conn, tk.ID)
	if len(got.Links) != 1 || !got.Links[0].Primary || got.Links[0].LinkTarget != prLink {
		t.Fatalf("links %+v", got.Links)
	}
	if len(tk.Links) != 1 {
		t.Fatalf("Create's returned task lacks links: %+v", tk.Links)
	}
}

func TestCreateRejectsInvalidFocus(t *testing.T) {
	conn := newDB(t)
	_, err := Create(conn, user, NewTask{Title: "x", Focus: []LinkTarget{{Kind: LinkResource, ResourceType: "pr"}}})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
	if n := count(t, conn, "tasks"); n != 0 {
		t.Fatalf("tasks = %d, want 0", n)
	}
}

func TestAddLinkDefaultsAndRemoveDoesNotPromote(t *testing.T) {
	conn := newDB(t)
	tk, err := Create(conn, user, NewTask{Title: "x", Focus: []LinkTarget{prLink}})
	if err != nil {
		t.Fatal(err)
	}
	l := mustAddLink(t, conn, tk.ID, jiraLink, false)
	if l.Primary || l.LinkTarget != jiraLink || l.ID == 0 {
		t.Fatalf("added link %+v", l)
	}
	if err := RemoveLink(conn, user, tk.ID, prLink); err != nil {
		t.Fatal(err)
	}
	got := mustGet(t, conn, tk.ID)
	if len(got.Links) != 1 || got.Links[0].LinkTarget != jiraLink || got.Links[0].Primary {
		t.Fatalf("links after remove %+v", got.Links)
	}
	if err := RemoveLink(conn, user, tk.ID, prLink); !errors.Is(err, ErrNotFound) {
		t.Fatalf("removing a missing link: err = %v, want ErrNotFound", err)
	}
}

func TestAddLinkTwice(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "x")
	mustAddLink(t, conn, tk.ID, prLink, false)
	mustAddLink(t, conn, tk.ID, prLink, false)
	if n := count(t, conn, "task_links"); n != 1 {
		t.Fatalf("rows = %d, want 1", n)
	}
	l := mustAddLink(t, conn, tk.ID, prLink, true)
	if !l.Primary {
		t.Fatalf("focus not flipped: %+v", l)
	}
	if n := count(t, conn, "task_links"); n != 1 {
		t.Fatalf("rows = %d, want 1", n)
	}
}

func TestAddLinkValidation(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "x")
	bad := []LinkTarget{
		{},
		{Kind: "other", ResourceType: "pr", ResourceID: "1"},
		{Kind: LinkResource, ResourceID: "1"},
		{Kind: LinkResource, ResourceType: "pr"},
		{Kind: LinkWorktree},
	}
	for _, b := range bad {
		if _, err := AddLink(conn, user, tk.ID, b, false); !errors.Is(err, ErrInvalid) {
			t.Errorf("AddLink(%+v) err = %v, want ErrInvalid", b, err)
		}
	}
	if _, err := AddLink(conn, Actor{}, tk.ID, prLink, false); !errors.Is(err, ErrInvalid) {
		t.Errorf("zero actor err = %v", err)
	}
	if _, err := AddLink(conn, user, 999, prLink, false); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing task err = %v", err)
	}
}

func TestSetLinkFocusLandsAtBottom(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "x")
	mustAddLink(t, conn, tk.ID, prLink, true)
	mustAddLink(t, conn, tk.ID, jiraLink, false)
	mustAddLink(t, conn, tk.ID, pr2Link, true)
	if err := SetLinkFocus(conn, user, tk.ID, prLink, false); err != nil {
		t.Fatal(err)
	}
	got := mustGet(t, conn, tk.ID).Links
	want := []LinkTarget{pr2Link, jiraLink, prLink}
	for i, w := range want {
		if got[i].LinkTarget != w {
			t.Fatalf("order %+v, want %+v", got, want)
		}
	}
	if !got[0].Primary || got[1].Primary || got[2].Primary {
		t.Fatalf("groups %+v", got)
	}
	// A no-op writes nothing.
	v := mustVersion(t, conn)
	if err := SetLinkFocus(conn, user, tk.ID, prLink, false); err != nil {
		t.Fatal(err)
	}
	if mustVersion(t, conn) != v {
		t.Fatal("a no-op SetLinkFocus bumped the version")
	}
	if err := SetLinkFocus(conn, user, tk.ID, LinkTarget{Kind: LinkResource, ResourceType: "pr", ResourceID: "nope"}, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing link err = %v", err)
	}
}

func TestSetLinkOrder(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "x")
	a, b, c := prLink, jiraLink, pr2Link
	mustAddLink(t, conn, tk.ID, a, false)
	mustAddLink(t, conn, tk.ID, b, false)
	mustAddLink(t, conn, tk.ID, c, false)
	if err := SetLinkOrder(conn, user, tk.ID, []LinkTarget{c}, []LinkTarget{b, a}); err != nil {
		t.Fatal(err)
	}
	got := mustGet(t, conn, tk.ID).Links
	if len(got) != 3 || got[0].LinkTarget != c || got[1].LinkTarget != b || got[2].LinkTarget != a {
		t.Fatalf("order %+v", got)
	}
	if !got[0].Primary || got[1].Primary || got[2].Primary {
		t.Fatalf("groups %+v", got)
	}
}

func TestSetLinkOrderForgiving(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "x")
	mustAddLink(t, conn, tk.ID, prLink, true)
	mustAddLink(t, conn, tk.ID, jiraLink, false)
	mustAddLink(t, conn, tk.ID, pr2Link, false)
	// pr2 is left out (keeps its group, goes to the end); an unknown target is
	// ignored; a duplicate is claimed once.
	unknown := LinkTarget{Kind: LinkResource, ResourceType: "pr", ResourceID: "gone"}
	if err := SetLinkOrder(conn, user, tk.ID, []LinkTarget{unknown, jiraLink}, []LinkTarget{prLink, jiraLink}); err != nil {
		t.Fatal(err)
	}
	got := mustGet(t, conn, tk.ID).Links
	if len(got) != 3 || got[0].LinkTarget != jiraLink || !got[0].Primary ||
		got[1].LinkTarget != prLink || got[1].Primary || got[2].LinkTarget != pr2Link || got[2].Primary {
		t.Fatalf("order %+v", got)
	}
	if err := SetLinkOrder(conn, user, 999, nil, nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing task err = %v", err)
	}
}

func TestWorktreeLinkCanonicalisesSymlink(t *testing.T) {
	conn := newDB(t)
	dir := t.TempDir()
	d := filepath.Join(dir, "real")
	if err := os.Mkdir(d, 0o755); err != nil {
		t.Fatal(err)
	}
	s := filepath.Join(dir, "link")
	if err := os.Symlink(d, s); err != nil {
		t.Fatal(err)
	}
	register(t, conn, d)
	tk := mustCreate(t, conn, "x")
	mustAddLink(t, conn, tk.ID, LinkTarget{Kind: LinkWorktree, Worktree: s}, false)
	got := mustGet(t, conn, tk.ID)
	if len(got.Links) != 1 || got.Links[0].Worktree != canon(d) || got.Links[0].Archived {
		t.Fatalf("links %+v, want worktree %q", got.Links, canon(d))
	}
	if got.Archived {
		t.Fatal("task archived")
	}
	ts, err := List(conn, Filter{Scope: Scope{Kind: ScopeWorktree, Worktree: d}})
	if err != nil {
		t.Fatal(err)
	}
	if len(ts) != 1 || ts[0].ID != tk.ID {
		t.Fatalf("List(worktree D) = %+v", ts)
	}
	// The same link given via the real path is the same link.
	mustAddLink(t, conn, tk.ID, LinkTarget{Kind: LinkWorktree, Worktree: d}, false)
	if n := count(t, conn, "task_links"); n != 1 {
		t.Fatalf("rows = %d, want 1", n)
	}
}

func TestWorktreeLinkMissingPath(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "x")
	p := filepath.Join(t.TempDir(), "gone", "..", "gone")
	l := mustAddLink(t, conn, tk.ID, LinkTarget{Kind: LinkWorktree, Worktree: p}, false)
	if l.Worktree != filepath.Clean(canon(p)) || !l.Archived {
		t.Fatalf("link %+v", l)
	}
}

func TestSetLinkOrderAppliesGroupChanges(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "x")
	mustAddLink(t, conn, tk.ID, prLink, true)
	mustAddLink(t, conn, tk.ID, jiraLink, false)
	mustAddLink(t, conn, tk.ID, pr2Link, false)

	// pr -> Related, jira -> Focus; pr2 stays Related.
	if err := SetLinkOrder(conn, user, tk.ID, []LinkTarget{jiraLink}, []LinkTarget{prLink, pr2Link}); err != nil {
		t.Fatal(err)
	}
	got := mustGet(t, conn, tk.ID).Links
	want := []struct {
		target  LinkTarget
		primary bool
	}{{jiraLink, true}, {prLink, false}, {pr2Link, false}}
	if len(got) != len(want) {
		t.Fatalf("links %+v", got)
	}
	for i, w := range want {
		if got[i].LinkTarget != w.target || got[i].Primary != w.primary {
			t.Fatalf("links %+v, want %+v", got, want)
		}
	}
	if n := count(t, conn, "task_events"); n != 1 {
		t.Fatalf("task_events = %d, want only task_created", n)
	}

	if err := SetLinkOrder(conn, Actor{}, tk.ID, nil, nil); !errors.Is(err, ErrInvalid) {
		t.Fatalf("zero actor err = %v", err)
	}
}

func TestNormalizeTrimsStoredValues(t *testing.T) {
	conn := newDB(t)
	wt := filepath.Join(t.TempDir(), "trim")
	if err := os.Mkdir(wt, 0o755); err != nil {
		t.Fatal(err)
	}
	tk := mustCreate(t, conn, "t")
	if _, err := AddLink(conn, user, tk.ID, LinkTarget{Kind: LinkResource, ResourceType: " pr ", ResourceID: " o/r#1"}, false); err != nil {
		t.Fatal(err)
	}
	if _, err := AddLink(conn, user, tk.ID, LinkTarget{Kind: LinkWorktree, Worktree: " " + wt + " "}, false); err != nil {
		t.Fatal(err)
	}
	got := mustGet(t, conn, tk.ID).Links
	if len(got) != 2 || got[0].LinkTarget != prLink || got[1].Worktree != canon(wt) {
		t.Fatalf("links = %+v", got)
	}
	var stored string
	if err := conn.QueryRow(`SELECT resource_id FROM task_links WHERE kind = 'resource'`).Scan(&stored); err != nil || stored != "o/r#1" {
		t.Fatalf("stored resource_id = %q, %v", stored, err)
	}
	// Lookups match the trimmed form too.
	if err := RemoveLink(conn, user, tk.ID, LinkTarget{Kind: LinkResource, ResourceType: "pr", ResourceID: "o/r#1 "}); err != nil {
		t.Fatalf("remove with padding: %v", err)
	}
}

func TestErrLinkNotFound(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "t")
	err := RemoveLink(conn, user, tk.ID, prLink)
	if !errors.Is(err, ErrLinkNotFound) || !errors.Is(err, ErrNotFound) {
		t.Fatalf("RemoveLink missing link err = %v", err)
	}
	if err := SetLinkFocus(conn, user, tk.ID, prLink, true); !errors.Is(err, ErrLinkNotFound) {
		t.Fatalf("SetLinkFocus missing link err = %v", err)
	}
	// A missing task is ErrNotFound but not ErrLinkNotFound.
	if err := RemoveLink(conn, user, 999, prLink); !errors.Is(err, ErrNotFound) || errors.Is(err, ErrLinkNotFound) {
		t.Fatalf("RemoveLink missing task err = %v", err)
	}
}

// staleTS backdates a task's updated_at so a later bump is visible despite
// the one-second timestamp resolution.
const staleTS = "2000-01-01T00:00:00Z"

func backdate(t *testing.T, conn *sql.DB, id int64) {
	t.Helper()
	if _, err := conn.Exec(`UPDATE tasks SET updated_at = ? WHERE id = ?`, staleTS, id); err != nil {
		t.Fatal(err)
	}
}

func updatedAt(t *testing.T, conn *sql.DB, id int64) string {
	t.Helper()
	return mustGet(t, conn, id).UpdatedAt
}

type step struct {
	name string
	do   func() error
}

// checkBumps runs each step from a backdated updated_at and checks whether
// it bumped it.
func checkBumps(t *testing.T, conn *sql.DB, id int64, wantBump bool, steps []step) {
	t.Helper()
	for _, s := range steps {
		backdate(t, conn, id)
		if err := s.do(); err != nil {
			t.Fatalf("%s: %v", s.name, err)
		}
		got := updatedAt(t, conn, id)
		if wantBump && got == staleTS {
			t.Errorf("%s did not bump updated_at", s.name)
		}
		if !wantBump && got != staleTS {
			t.Errorf("%s bumped updated_at to %s", s.name, got)
		}
	}
}

func TestLinkWritesBumpUpdatedAt(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "t")
	checkBumps(t, conn, tk.ID, true, []step{
		{"AddLink", func() error { _, err := AddLink(conn, user, tk.ID, prLink, false); return err }},
		{"AddLink jira", func() error { _, err := AddLink(conn, user, tk.ID, jiraLink, false); return err }},
		{"AddLink other group", func() error { _, err := AddLink(conn, user, tk.ID, prLink, true); return err }},
		{"SetLinkFocus", func() error { return SetLinkFocus(conn, user, tk.ID, prLink, false) }},
		{"SetLinkOrder group change", func() error {
			return SetLinkOrder(conn, user, tk.ID, []LinkTarget{jiraLink}, []LinkTarget{prLink})
		}},
		{"AddLink pr2", func() error { _, err := AddLink(conn, user, tk.ID, pr2Link, false); return err }},
		{"SetLinkOrder reorder", func() error {
			return SetLinkOrder(conn, user, tk.ID, []LinkTarget{jiraLink}, []LinkTarget{pr2Link, prLink})
		}},
		{"RemoveLink", func() error { return RemoveLink(conn, user, tk.ID, prLink) }},
	})
	checkBumps(t, conn, tk.ID, false, []step{
		{"AddLink same group", func() error { _, err := AddLink(conn, user, tk.ID, jiraLink, true); return err }},
		{"SetLinkFocus same group", func() error { return SetLinkFocus(conn, user, tk.ID, jiraLink, true) }},
		{"SetLinkOrder unchanged", func() error {
			return SetLinkOrder(conn, user, tk.ID, []LinkTarget{jiraLink}, []LinkTarget{pr2Link})
		}},
	})
}
