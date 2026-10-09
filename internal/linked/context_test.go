package linked

import (
	"reflect"
	"strings"
	"testing"

	"github.com/mturley/watcher"
)

func TestTruncateBefore(t *testing.T) {
	if got := truncateBefore("short text"); got != "short text" {
		t.Errorf("untruncated = %q", got)
	}
	long := strings.Repeat("word ", 30) + "end"
	got := truncateBefore(long)
	if !strings.HasPrefix(got, "…") || !strings.HasSuffix(got, "word end") {
		t.Errorf("got %q", got)
	}
	if n := len([]rune(got)); n > contextRunes+1 {
		t.Errorf("too long: %d", n)
	}
	// Cut lands mid-word: the partial word is dropped.
	got = truncateBefore(strings.Repeat("a", 59) + " " + "bcdefgh ijk")
	if got != "…bcdefgh ijk" {
		t.Errorf("kept a partial word: %q", got)
	}
}

func TestTruncateAfter(t *testing.T) {
	if got := truncateAfter("short"); got != "short" {
		t.Errorf("untruncated = %q", got)
	}
	long := "start " + strings.Repeat("word ", 30)
	got := truncateAfter(long)
	if !strings.HasSuffix(got, "…") || !strings.HasPrefix(got, "start word") {
		t.Errorf("got %q", got)
	}
	if strings.Contains(got, " …") {
		t.Errorf("space before ellipsis: %q", got)
	}
	got = truncateAfter(strings.Repeat("x", 55) + " yyyyyyyyyyyyy")
	if got != strings.Repeat("x", 55)+"…" {
		t.Errorf("mid-word cut: %q", got)
	}
}

func TestClassifyLinksContextRules(t *testing.T) {
	refs := []watcher.LinkRef{
		// jira, label == key → no context
		{URL: "https://example.atlassian.net/browse/PROJ-1", Label: "proj-1", Before: "see", After: "now"},
		// jira, label == URL → none
		{URL: "https://example.atlassian.net/browse/PROJ-2", Label: "https://example.atlassian.net/browse/PROJ-2", Before: "a"},
		// jira with a descriptive label → shown
		{URL: "https://example.atlassian.net/browse/PROJ-3", Label: "the epic", Before: "part of", After: "for Q3"},
		// PR labelled "#7", "repo#8" and "example/repo#9" → none
		{URL: "https://github.com/example/repo/pull/7", Label: "#7", Before: "x"},
		{URL: "https://github.com/example/repo/pull/8", Label: "repo#8", Before: "x"},
		{URL: "https://github.com/example/repo/pull/9", Label: "Example/Repo#9", Before: "x"},
		// PR with a label → shown
		{URL: "https://github.com/example/repo/pull/10", Label: "the fix", Before: "see"},
		// plain link: bare URL alone → omitted; with text → shown; first wins
		{URL: "https://docs.example.com/a", Label: "https://docs.example.com/a"},
		{URL: "https://docs.example.com/b", Label: "https://docs.example.com/b", After: "is the spec"},
		{URL: "https://docs.example.com/c", Label: "spec", Before: "first"},
		{URL: "https://docs.example.com/c", Label: "other", Before: "second"},
		// the first occurrence decides even when a later one has more
		{URL: "https://docs.example.com/a", Label: "named", Before: "later"},
	}
	items := ClassifyLinks(refs, Key{"pr", "o/r#1"})
	ctx := map[string]*LinkContext{}
	for _, it := range items {
		ctx[it.ID] = it.Context
	}
	for _, id := range []string{"PROJ-1", "PROJ-2", "example/repo#7", "example/repo#8", "example/repo#9", "https://docs.example.com/a"} {
		if ctx[id] != nil {
			t.Errorf("%s: context = %+v, want none", id, ctx[id])
		}
	}
	want := map[string]LinkContext{
		"PROJ-3":                     {Before: "part of", Label: "the epic", After: "for Q3"},
		"example/repo#10":            {Before: "see", Label: "the fix"},
		"https://docs.example.com/b": {Label: "https://docs.example.com/b", After: "is the spec"},
		"https://docs.example.com/c": {Before: "first", Label: "spec"},
	}
	for id, w := range want {
		if ctx[id] == nil || *ctx[id] != w {
			t.Errorf("%s: context = %+v, want %+v", id, ctx[id], w)
		}
	}
}

func TestClassifyLinksTruncatesContext(t *testing.T) {
	long := strings.Repeat("lorem ", 40)
	items := ClassifyLinks([]watcher.LinkRef{{URL: "https://docs.example.com/a", Label: "doc", Before: long, After: long}}, Key{"pr", "o/r#1"})
	c := items[0].Context
	if c == nil || !strings.HasPrefix(c.Before, "…") || !strings.HasSuffix(c.After, "…") {
		t.Fatalf("context = %+v", c)
	}
}

func TestExtractMarkdownLinks(t *testing.T) {
	body := "# Summary\n\n" +
		"Fixes **[PROJ-1](https://example.atlassian.net/browse/PROJ-1)** per the `design`.\n" +
		"Still in the same paragraph with <https://github.com/example/repo/pull/2> here.\n\n" +
		"- first item, see [the _spec_](https://docs.example.com/a), thanks\n" +
		"- [ ] second item https://docs.example.com/b.\n\n" +
		"![shot](https://user-images.example.com/shot.png)\n" +
		"<!-- https://hidden.example.com/x -->\n"
	got := ExtractMarkdownLinks(body)
	want := []watcher.LinkRef{
		{URL: "https://example.atlassian.net/browse/PROJ-1", Label: "PROJ-1", Before: "Fixes", After: "per the design. Still in the same paragraph with https://github.com/example/repo/pull/2 here."},
		{URL: "https://github.com/example/repo/pull/2", Label: "https://github.com/example/repo/pull/2", Before: "Fixes PROJ-1 per the design. Still in the same paragraph with", After: "here."},
		{URL: "https://docs.example.com/a", Label: "the spec", Before: "first item, see", After: ", thanks"},
		{URL: "https://docs.example.com/b", Label: "https://docs.example.com/b", Before: "[ ] second item", After: "."},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v\nwant %#v", got, want)
	}
}

func TestExtractMarkdownLinksKeepsSnakeCase(t *testing.T) {
	got := ExtractMarkdownLinks("use my_var_name with _emphasis_ at https://docs.example.com/a")
	if len(got) != 1 || got[0].Before != "use my_var_name with emphasis at" {
		t.Fatalf("got %#v", got)
	}
}
