package cmd

import (
	"path/filepath"
	"testing"
)

func TestResolveWorktreePathRejectsEmpty(t *testing.T) {
	for _, arg := range []string{"", "  "} {
		if p, err := resolveWorktreePath([]string{arg}); err == nil {
			t.Fatalf("resolveWorktreePath(%q) = %q, want an error", arg, p)
		}
	}
}

func TestResolveWorktreePathMakesAbsolute(t *testing.T) {
	p, err := resolveWorktreePath([]string{"some/wt"})
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(p) || filepath.Base(p) != "wt" {
		t.Fatalf("resolveWorktreePath = %q, want an absolute path ending in wt", p)
	}
}
