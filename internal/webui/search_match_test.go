package webui

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"

	"github.com/mturley/worktree/internal/tasks"
)

// The TS twin is ui/src/lib/searchParity.test.ts; both read one fixture, so
// the CLI's search and the web UI's cannot drift apart.

type parityWant struct {
	Field    string `json:"field"`
	Snippet  string `json:"snippet"`
	ViaKey   string `json:"via_key"`
	ViaField string `json:"via_field"`
}

type parityCase struct {
	Name            string          `json:"name"`
	Kind            string          `json:"kind"`
	Item            json.RawMessage `json:"item"`
	WorkspaceTitles []string        `json:"workspace_titles"`
	Resources       []resourceDTO   `json:"resources"`
	Query           string          `json:"query"`
	Want            *parityWant     `json:"want"`
	Rank            *int            `json:"rank"`
}

func TestSearchParityFixture(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile("../../ui/src/lib/testdata/search-parity.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		Cases []parityCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	if len(fx.Cases) == 0 {
		t.Fatal("fixture has no cases")
	}
	for _, c := range fx.Cases {
		t.Run(c.Name, func(t *testing.T) {
			t.Parallel()
			terms := parseSearchTerms(c.Query)
			var got *searchMatch
			var rank int
			switch c.Kind {
			case "resource":
				var r resourceDTO
				mustUnmarshal(t, c.Item, &r)
				got = matchResource(&r, terms)
				rank = rankResource(&r, terms)
			case "task":
				var in struct {
					ID          int64  `json:"id"`
					Title       string `json:"title"`
					Description string `json:"description"`
				}
				mustUnmarshal(t, c.Item, &in)
				task := tasks.Task{ID: in.ID, Title: in.Title, Description: in.Description}
				got = matchTask(task, terms)
				rank = rankTask(task, terms)
			case "worktree":
				var w worktreeSummary
				mustUnmarshal(t, c.Item, &w)
				got = matchWorktree(&w, c.WorkspaceTitles, c.Resources, terms)
				rank = rankText(w.Branch, terms)
			default:
				t.Fatalf("unknown kind %q", c.Kind)
			}
			if c.Want == nil {
				if got != nil {
					t.Fatalf("want no match, got %+v", got)
				}
			} else {
				if got == nil {
					t.Fatalf("want %+v, got no match", *c.Want)
				}
				have := fmt.Sprintf("%q %q %q %q", got.Field, got.Snippet, got.ViaKey, got.ViaField)
				want := fmt.Sprintf("%q %q %q %q", c.Want.Field, c.Want.Snippet, c.Want.ViaKey, c.Want.ViaField)
				if have != want {
					t.Fatalf("match\n got  %s\n want %s", have, want)
				}
			}
			if c.Rank != nil && rank != *c.Rank {
				t.Fatalf("rank = %d, want %d", rank, *c.Rank)
			}
		})
	}
}

func mustUnmarshal(t *testing.T, raw json.RawMessage, v any) {
	t.Helper()
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatal(err)
	}
}
