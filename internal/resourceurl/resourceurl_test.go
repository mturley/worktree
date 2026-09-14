package resourceurl

import "testing"

func TestInfer(t *testing.T) {
	cases := []struct {
		name, url, wantType, wantID string
		wantOK                      bool
	}{
		{"pr url", "https://github.com/o/r/pull/42", "pr", "o/r#42", true},
		{"jira url", "https://x.atlassian.net/browse/ABC-1", "jira", "ABC-1", true},
		{"unknown", "https://example.com/nope", "", "", false},
		{"empty", "", "", "", false},
		{"real pr url", "https://github.com/opendatahub-io/odh-dashboard/pull/9097", "pr", "opendatahub-io/odh-dashboard#9097", true},
		{"real jira url", "https://redhat.atlassian.net/browse/RHOAIENG-123", "jira", "RHOAIENG-123", true},
		{"slack url", "https://x.slack.com/archives/C069KSM8T9N/p1787087256917159", "slack", "C069KSM8T9N:1787087256.917159", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gt, gi, ok := Infer(tc.url)
			if ok != tc.wantOK || gt != tc.wantType || gi != tc.wantID {
				t.Fatalf("Infer(%q) = (%q,%q,%v), want (%q,%q,%v)",
					tc.url, gt, gi, ok, tc.wantType, tc.wantID, tc.wantOK)
			}
		})
	}
}

func TestNormalizeLinkURL(t *testing.T) {
	cases := []struct{ in, want string; ok bool }{
		{"https://Example.COM/Path?q=1", "https://example.com/Path?q=1", true},
		{"https://example.com:443/x", "https://example.com/x", true},
		{"http://example.com:80/x", "http://example.com/x", true},
		{"https://example.com/x#frag", "https://example.com/x", true},
		{"https://example.com/dir/", "https://example.com/dir/", true},
		{"https://example.com:8443/x", "https://example.com:8443/x", true},
		{"ftp://example.com/x", "", false},
		{"/just/a/path", "", false},
		{"", "", false},
		{"https://", "", false},
	}
	for _, tc := range cases {
		got, ok := NormalizeLinkURL(tc.in)
		if ok != tc.ok || got != tc.want {
			t.Fatalf("NormalizeLinkURL(%q) = (%q,%v), want (%q,%v)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func TestInferAnyFallsBackToLink(t *testing.T) {
	typ, id, ok := InferAny("https://Example.com/docs#x")
	if !ok || typ != "link" || id != "https://example.com/docs" {
		t.Fatalf("got (%q,%q,%v)", typ, id, ok)
	}
}

func TestInferAnyPrefersKnownTypes(t *testing.T) {
	typ, id, _ := InferAny("https://github.com/o/r/pull/42")
	if typ != "pr" || id != "o/r#42" {
		t.Fatalf("got (%q,%q)", typ, id)
	}
}

func TestInferAnyRejectsNonURLs(t *testing.T) {
	for _, in := range []string{"./some/path", "file:///etc/passwd", "", "not a url"} {
		if _, _, ok := InferAny(in); ok {
			t.Fatalf("InferAny(%q) should be rejected", in)
		}
	}
}

func TestInferUnchangedByLinkSupport(t *testing.T) {
	// The strict detector must keep rejecting unknown URLs, so that
	// `worktree add ./typo` still errors instead of following a page.
	if _, _, ok := Infer("https://example.com/nope"); ok {
		t.Fatal("Infer must not gain the link fallback")
	}
}
