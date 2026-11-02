package cmd

import (
	"os"
	"path/filepath"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/reviewcomments"
)

func TestReviewCommentsListJSON(t *testing.T) {
	live, gone := seedReadFixture(t)
	if err := os.WriteFile(filepath.Join(live, "f.txt"), []byte("one\ntwo\nthree\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	for _, p := range []string{live, gone} {
		if _, err := reviewcomments.Create(conn, p, reviewcomments.NewComment{
			File: "f.txt", Side: reviewcomments.SideNew, Body: "fix this\nsecond line",
			Anchor: reviewcomments.Anchor{Start: 2, End: 2, Snippet: []string{"two"}, Before: []string{"one"}, After: []string{"three"}},
		}); err != nil {
			t.Fatal(err)
		}
	}

	out, err := runCLI(t, "review-comments", "list", "--worktree", live, "--json")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	var got []struct {
		File   string `json:"file"`
		Body   string `json:"body"`
		Prompt struct {
			Status    string `json:"status"`
			StartLine int    `json:"start_line"`
		} `json:"prompt"`
	}
	decodeEnvelope(t, out, "comments", &got)
	if len(got) != 1 || got[0].File != "f.txt" || got[0].Prompt.Status != "current" || got[0].Prompt.StartLine != 2 {
		t.Fatalf("comments = %+v\n%s", got, out)
	}

	text, err := runCLI(t, "review-comments", "list", "--worktree", live)
	if err != nil {
		t.Fatal(err)
	}
	if want := "f.txt:2  [current]  fix this\n"; text != want {
		t.Fatalf("text = %q, want %q", text, want)
	}

	// A worktree whose directory is gone still lists, with outdated anchors.
	out, err = runCLI(t, "review-comments", "list", "--worktree", gone, "--json")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	got = nil
	decodeEnvelope(t, out, "comments", &got)
	if len(got) != 1 || got[0].Prompt.Status != "outdated" {
		t.Fatalf("gone comments = %+v", got)
	}
}
