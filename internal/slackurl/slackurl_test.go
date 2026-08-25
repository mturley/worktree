package slackurl

import "testing"

func TestParse(t *testing.T) {
	ch, ts, ok := Parse("https://acme.slack.com/archives/C0123ABCD/p1699999999000100")
	if !ok || ch != "C0123ABCD" || ts != "1699999999.000100" {
		t.Fatalf("got %q %q %v", ch, ts, ok)
	}
	if _, _, ok := Parse("https://github.com/x/y/pull/1"); ok {
		t.Fatal("non-slack URL should not parse")
	}
}

func TestResourceID(t *testing.T) {
	if ResourceID("C1", "1699999999.000100") != "C1:1699999999.000100" {
		t.Fatal()
	}
}

// TestParsePrefersThreadTS pins the rule the frontend already follows: when a
// link points at a REPLY, Slack appends ?thread_ts= naming the thread's root,
// and that root is the thing worth tracking — not the individual reply.
//
// These two disagreeing was a real bug: the UI computed the resource id from
// thread_ts while this parser used the p-segment, so a thread added from a
// reply link was stored under an id the UI never looked for.
func TestParsePrefersThreadTS(t *testing.T) {
	cases := []struct {
		name, url, wantTS string
	}{
		{
			name:   "root permalink has no thread_ts",
			url:    "https://x.slack.com/archives/C1/p1787338589333879",
			wantTS: "1787338589.333879",
		},
		{
			name:   "reply link uses thread_ts",
			url:    "https://x.slack.com/archives/C1/p1787338589333879?thread_ts=1787148785.586539&cid=C1",
			wantTS: "1787148785.586539",
		},
		{
			name:   "html-escaped ampersand, as Slack sends in unfurls",
			url:    "https://x.slack.com/archives/C1/p1787338589333879?thread_ts=1787148785.586539&amp;cid=C1",
			wantTS: "1787148785.586539",
		},
		{
			name:   "cid before thread_ts",
			url:    "https://x.slack.com/archives/C1/p1787338589333879?cid=C1&thread_ts=1787148785.586539",
			wantTS: "1787148785.586539",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ch, ts, ok := Parse(c.url)
			if !ok {
				t.Fatalf("Parse(%q) not ok", c.url)
			}
			if ch != "C1" {
				t.Errorf("channel = %q, want C1", ch)
			}
			if ts != c.wantTS {
				t.Errorf("threadTS = %q, want %q", ts, c.wantTS)
			}
		})
	}
}
