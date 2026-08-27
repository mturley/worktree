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
