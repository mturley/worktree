package cmd

import (
	"bytes"
	"path/filepath"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/testgit"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// runCLI runs one in-process rootCmd invocation with every flag back at its
// default, so a flag from one test cannot leak into the next.
func runCLI(t *testing.T, args ...string) (string, error) {
	t.Helper()
	var reset func(c *cobra.Command)
	reset = func(c *cobra.Command) {
		for _, fs := range []*pflag.FlagSet{c.Flags(), c.PersistentFlags()} {
			fs.VisitAll(func(f *pflag.Flag) {
				if sv, ok := f.Value.(pflag.SliceValue); ok {
					_ = sv.Replace(nil)
				} else {
					_ = f.Value.Set(f.DefValue)
				}
				f.Changed = false
			})
		}
		for _, sub := range c.Commands() {
			reset(sub)
		}
	}
	reset(rootCmd)
	var out bytes.Buffer
	rootCmd.SetOut(&out)
	rootCmd.SetErr(&out)
	rootCmd.SetArgs(args)
	err := rootCmd.Execute()
	rootCmd.SetOut(nil)
	rootCmd.SetErr(nil)
	rootCmd.SetArgs(nil)
	return out.String(), err
}

// seedReadFixture selects a fresh DB through WORKTREE_DB and registers two
// worktrees: live is a real linked worktree, gone is not on disk.
func seedReadFixture(t *testing.T) (live, gone string) {
	t.Helper()
	t.Setenv("CMUX_SOCKET_PATH", "")
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	live = testgit.Worktree(t)
	gone = filepath.Join(t.TempDir(), "deleted-wt")
	for _, e := range []registry.Entry{
		{Path: live, Repo: "odh", RepoRoot: "/r", Branch: "feat", CreatedAt: "2026-08-13T00:00:00Z"},
		{Path: gone, Repo: "odh", RepoRoot: "/r", Branch: "old", CreatedAt: "2026-08-12T00:00:00Z"},
	} {
		if err := registry.Register(conn, e); err != nil {
			t.Fatal(err)
		}
	}
	return live, gone
}

func TestListJSONShape(t *testing.T) {
	live, gone := seedReadFixture(t)
	out, err := runCLI(t, "list", "--json")
	if err != nil {
		t.Fatalf("list --json: %v\n%s", err, out)
	}
	var got []map[string]any
	decodeEnvelope(t, out, "worktrees", &got)
	if len(got) != 2 {
		t.Fatalf("got %d worktrees: %s", len(got), out)
	}
	byPath := map[string]map[string]any{}
	for _, w := range got {
		byPath[w["path"].(string)] = w
	}
	if byPath[live]["on_disk"] != true || byPath[gone]["on_disk"] != false {
		t.Fatalf("on_disk wrong: %v", got)
	}
	for _, w := range got {
		if w["open_in_cmux"] != false {
			t.Fatalf("open_in_cmux = %v, want false", w["open_in_cmux"])
		}
		if _, ok := w["focus_resources"].([]any); !ok {
			t.Fatalf("focus_resources = %#v, want an array", w["focus_resources"])
		}
		if _, ok := w["git"]; ok {
			t.Fatalf("git present without --git: %v", w)
		}
	}
}

// updated_at is the custom-name time and resource_updated_at the resource's
// own, as in every other output carrying resources.
func TestListJSONFocusResourcesTimes(t *testing.T) {
	live, _ := seedReadFixture(t)
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	for _, r := range []resources.Resource{
		{Type: "pr", ID: "o/r#1", URL: "https://pr/1"},
		{Type: "pr", ID: "o/r#2", URL: "https://pr/2"},
	} {
		if err := resources.Add(conn, live, r); err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Exec(`INSERT INTO watcher_resource_state (resource_type, resource_id, state_json, resource_updated_at, watcher_updated_at)
			VALUES ('pr', ?, '{"title":"t"}', '2026-09-01T00:00:00Z', 'x')`, r.ID); err != nil {
			t.Fatal(err)
		}
	}
	if err := resources.SetMetaAt(conn, "pr", "o/r#1", "named", "", "2026-10-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	out, err := runCLI(t, "list", "--json")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	var got []map[string]any
	decodeEnvelope(t, out, "worktrees", &got)
	focus := map[string]map[string]any{}
	for _, w := range got {
		if w["path"] != live {
			continue
		}
		for _, f := range w["focus_resources"].([]any) {
			m := f.(map[string]any)
			focus[m["id"].(string)] = m
		}
	}
	named, plain := focus["o/r#1"], focus["o/r#2"]
	if named == nil || plain == nil {
		t.Fatalf("focus resources missing: %s", out)
	}
	if named["updated_at"] != "2026-10-01T00:00:00Z" || named["resource_updated_at"] != "2026-09-01T00:00:00Z" {
		t.Errorf("named = %v", named)
	}
	if _, ok := plain["updated_at"]; ok || plain["resource_updated_at"] != "2026-09-01T00:00:00Z" {
		t.Errorf("plain = %v", plain)
	}
}

func TestListJSONGitFlag(t *testing.T) {
	live, gone := seedReadFixture(t)
	out, err := runCLI(t, "list", "--json", "--git")
	if err != nil {
		t.Fatalf("list --json --git: %v\n%s", err, out)
	}
	var got []map[string]any
	decodeEnvelope(t, out, "worktrees", &got)
	for _, w := range got {
		g, ok := w["git"].(map[string]any)
		switch w["path"] {
		case live:
			if !ok || g["branch"] == nil || g["branch"] == "" {
				t.Fatalf("on-disk worktree lacks git.branch: %v", w)
			}
			if _, ok := g["dirty"].(bool); !ok {
				t.Fatalf("git.dirty missing: %v", g)
			}
		case gone:
			if ok {
				t.Fatalf("missing worktree must omit git: %v", w)
			}
		}
	}
}

func TestListJSONEmptyIsArray(t *testing.T) {
	t.Setenv("CMUX_SOCKET_PATH", "")
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	out, err := runCLI(t, "list", "--json")
	if err != nil {
		t.Fatal(err)
	}
	if out != "{\"schema_version\":1,\"worktrees\":[]}\n" {
		t.Fatalf("got %q", out)
	}
}

func TestPortsJSON(t *testing.T) {
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(`INSERT INTO port_allocations (name, slot) VALUES ('wt1', 0)`); err != nil {
		t.Fatal(err)
	}
	conn.Close()
	out, err := runCLI(t, "ports", "--json")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	var got []map[string]any
	decodeEnvelope(t, out, "allocations", &got)
	if len(got) != 1 || got[0]["name"] != "wt1" || got[0]["start"] == nil || got[0]["end"].(float64) <= got[0]["start"].(float64) {
		t.Fatalf("allocations = %v", got)
	}
}
