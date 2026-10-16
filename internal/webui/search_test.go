package webui

import (
	"strings"
	"testing"
)

func TestParseSearchTerms(t *testing.T) {
	cases := map[string][]string{
		"":                 nil,
		"   ":              nil,
		"OAuth":            {"oauth"},
		"  oauth   Proxy ": {"oauth", "proxy"},
		"a a b":            {"a", "b"},
	}
	for in, want := range cases {
		got := parseSearchTerms(in)
		if strings.Join(got, "|") != strings.Join(want, "|") || (want == nil) != (got == nil) {
			t.Errorf("parseSearchTerms(%q) = %#v, want %#v", in, got, want)
		}
	}
}

func TestLikeContainsEscapes(t *testing.T) {
	if got := likeContains(`ci_x%\`); got != `%ci\_x\%\\%` {
		t.Fatalf("got %q", got)
	}
}

func TestSearchSQLShape(t *testing.T) {
	if s, a := searchSQL(nil); s != "" || a != nil {
		t.Fatalf("empty terms must produce no clause, got %q %v", s, a)
	}
	s, args := searchSQL([]string{"a", "b"})
	if strings.Count(s, "AND (") != 2 {
		t.Fatalf("one AND group per term, got %q", s)
	}
	if len(args) != 2*searchArgsPerTerm {
		t.Fatalf("args = %d", len(args))
	}
	if args[0] != "%a%" || args[searchArgsPerTerm] != "%b%" {
		t.Fatalf("args = %v", args)
	}
}

func TestMatchEvent(t *testing.T) {
	te := &TimelineEvent{
		Title: "New comment", Body: "the oauth cookie is cleared before redirect", Author: "andrew",
		ResourceID: "RHOAIENG-1",
		Resource:   &resourceDTO{Type: "jira", ID: "RHOAIENG-1", Title: "Migrate proxy", CustomName: ""},
	}
	if m := matchEvent(te, []string{"comment"}); m == nil || m.Field != "title" {
		t.Fatalf("title match: %+v", m)
	}
	m := matchEvent(te, []string{"oauth"})
	if m == nil || m.Field != "body" || !strings.Contains(m.Snippet, "oauth cookie") {
		t.Fatalf("body match: %+v", m)
	}
	if m := matchEvent(te, []string{"andrew"}); m == nil || m.Field != "author" || m.Snippet != "andrew" {
		t.Fatalf("author match: %+v", m)
	}
	m = matchEvent(te, []string{"migrate"})
	if m == nil || m.Field != "resource" || m.Snippet != "RHOAIENG-1" {
		t.Fatalf("resource match: %+v", m)
	}
	// Terms may hit different fields; every one must hit something.
	if m := matchEvent(te, []string{"oauth", "migrate"}); m == nil {
		t.Fatal("multi-field AND should match")
	}
	if m := matchEvent(te, []string{"oauth", "nope"}); m != nil {
		t.Fatalf("missing term must not match, got %+v", m)
	}
	// No resource enrichment: still matches on the raw id.
	bare := &TimelineEvent{Title: "x", ResourceID: "o/r#5"}
	if m := matchEvent(bare, []string{"r#5"}); m == nil || m.Field != "resource" {
		t.Fatalf("bare id match: %+v", m)
	}
}

func TestSnippet(t *testing.T) {
	long := strings.Repeat("alpha ", 10) + "the OAuth   cookie\nis cleared " + strings.Repeat("omega ", 10)
	got := snippet(long, "oauth")
	if !strings.HasPrefix(got, "…") || !strings.HasSuffix(got, "…") {
		t.Fatalf("both ends cut: %q", got)
	}
	if !strings.Contains(got, "the OAuth cookie is cleared") {
		t.Fatalf("whitespace collapsed, original case kept: %q", got)
	}
	if strings.Contains(got, "alph…") || strings.HasPrefix(strings.TrimPrefix(got, "…"), "lpha") {
		t.Fatalf("cut mid-word: %q", got)
	}
	if got := snippet("short oauth text", "oauth"); got != "short oauth text" {
		t.Fatalf("short text kept whole: %q", got)
	}
	if got := snippet("nothing here", "oauth"); got != "" {
		t.Fatalf("no hit: %q", got)
	}
}
