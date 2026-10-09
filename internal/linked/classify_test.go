package linked

import (
	"reflect"
	"testing"
)

func TestExtractMarkdownURLs(t *testing.T) {
	body := "Fixes [PROJ-1](https://example.atlassian.net/browse/PROJ-1).\n" +
		"Related: <https://github.com/example/repo/pull/2> and https://github.com/example/repo/pull/2.\n" +
		"See https://docs.example.com/a, then (https://docs.example.com/b)!\n" +
		"![screenshot](https://user-images.example.com/shot.png)\n" +
		"<img src=\"https://user-images.example.com/other.png\" />\n" +
		"<!-- https://hidden.example.com/x -->"
	got := ExtractMarkdownURLs(body)
	want := []string{
		"https://example.atlassian.net/browse/PROJ-1",
		"https://github.com/example/repo/pull/2",
		"https://docs.example.com/a",
		"https://docs.example.com/b",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v\nwant %v", got, want)
	}
}

func TestClassify(t *testing.T) {
	urls := []string{
		"https://github.com/example/repo/pull/2",
		"https://github.com/example/repo/pull/2/files", // same PR → deduped
		"https://example.atlassian.net/browse/PROJ-1",  // self → dropped
		"https://example.atlassian.net/browse/PROJ-9",
		"https://example.slack.com/archives/C0TEST/p1700000000000100",
		"https://Docs.Example.com/a#frag",
		"not a url",
	}
	got := Classify(urls, Key{Type: "jira", ID: "PROJ-1"})
	if len(got) != 4 {
		t.Fatalf("got %d items: %+v", len(got), got)
	}
	if got[0].Type != "pr" || got[0].ID != "example/repo#2" || got[0].URL != "https://github.com/example/repo/pull/2" {
		t.Errorf("pr = %+v", got[0])
	}
	if got[1].Type != "jira" || got[1].ID != "PROJ-9" {
		t.Errorf("jira = %+v", got[1])
	}
	if got[2].Type != "slack" || got[2].ID != "C0TEST:1700000000.000100" {
		t.Errorf("slack = %+v", got[2])
	}
	if got[3].Type != "link" || got[3].ID != "https://docs.example.com/a" || got[3].Domain != "docs.example.com" || !got[3].Resolved {
		t.Errorf("link = %+v", got[3])
	}
	for _, it := range got[:3] {
		if it.Resolved {
			t.Errorf("non-link items start unresolved: %+v", it)
		}
	}
}
