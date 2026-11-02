package cmd

import (
	"fmt"
	"strings"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/notes"
)

func TestNotesShowJSON(t *testing.T) {
	live, _ := seedReadFixture(t)
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := notes.Set(conn, live, "remember this", true, false); err != nil {
		t.Fatal(err)
	}
	conn.Close()

	out, err := runCLI(t, "notes", "show", "--worktree", live, "--json")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	var got struct {
		Text       string `json:"text"`
		SyncCmux   bool   `json:"sync_cmux"`
		ShowOnHome bool   `json:"show_on_home"`
	}
	decodeEnvelope(t, out, "notes", &got)
	if got.Text != "remember this" || !got.SyncCmux || got.ShowOnHome {
		t.Fatalf("notes = %+v\n%s", got, out)
	}
}

func TestNotesSetKeepsFlags(t *testing.T) {
	live, _ := seedReadFixture(t)
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := notes.Set(conn, live, "old", true, false); err != nil {
		t.Fatal(err)
	}
	conn.Close()

	if out, err := runCLI(t, "notes", "set", "--worktree", live, "new text"); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	conn, err = wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	n, err := notes.Get(conn, live)
	if err != nil {
		t.Fatal(err)
	}
	if n.Text != "new text" || n.ShowOnHome || !n.SyncCmux {
		t.Fatalf("after set = %+v, want text changed and flags kept", n)
	}

	// An empty string clears the notes.
	if out, err := runCLI(t, "notes", "set", "--worktree", live, ""); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if n, _ = notes.Get(conn, live); n.Text != "" || n.ShowOnHome {
		t.Fatalf("after clear = %+v", n)
	}
}

func TestNotesSetNewWorktreeUsesDefaults(t *testing.T) {
	live, _ := seedReadFixture(t)
	if out, err := runCLI(t, "notes", "set", "--worktree", live, "first"); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	n, _ := notes.Get(conn, live)
	if n.Text != "first" || !n.ShowOnHome || n.SyncCmux {
		t.Fatalf("got %+v, want defaults kept", n)
	}
}

func TestNotesErrors(t *testing.T) {
	live, _ := seedReadFixture(t)
	if _, err := runCLI(t, "notes", "set", "--worktree", live); err == nil {
		t.Fatal("set with no text should be a usage error")
	}
	_, err := runCLI(t, "notes", "show", "--worktree", t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "not a registered worktree") {
		t.Fatalf("err = %v", err)
	}
}

// `echo text | notes set -` must store "text": the shell's newline is not
// part of the note, while the note's own blank lines are.
func TestNotesSetStdinTrimsOneNewline(t *testing.T) {
	for _, tt := range []struct{ in, want string }{
		{"text\n", "text"},
		{"text\r\n", "text"},
		{"text", "text"},
		{"text\n\n", "text\n"},
		{"a\nb\n", "a\nb"},
	} {
		t.Run(fmt.Sprintf("%q", tt.in), func(t *testing.T) {
			live, _ := seedReadFixture(t)
			rootCmd.SetIn(strings.NewReader(tt.in))
			defer rootCmd.SetIn(nil)
			if out, err := runCLI(t, "notes", "set", "--worktree", live, "-"); err != nil {
				t.Fatalf("%v\n%s", err, out)
			}
			conn, err := wdb.Open()
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			n, err := notes.Get(conn, live)
			if err != nil {
				t.Fatal(err)
			}
			if n.Text != tt.want {
				t.Errorf("text = %q, want %q", n.Text, tt.want)
			}
		})
	}
}
