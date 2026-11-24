package cmd

import (
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/webui"
)

func TestMatchWhySkipsVisibleFields(t *testing.T) {
	if got := matchWhy(&webui.SearchMatch{Field: "title", Snippet: "x"}); got != "" {
		t.Errorf("visible field explained: %q", got)
	}
	if got := matchWhy(&webui.SearchMatch{Field: "notes", Snippet: "x"}); !strings.Contains(got, "notes: x") {
		t.Errorf("hidden field lost its why: %q", got)
	}
	if got := matchWhy(&webui.SearchMatch{Field: "title", ViaKey: "PROJ-1"}); !strings.Contains(got, "via PROJ-1") {
		t.Errorf("via match lost its why: %q", got)
	}
}
