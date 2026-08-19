package webui

import "testing"

func TestInferResource(t *testing.T) {
	cases := []struct {
		url, wantType, wantID string
		wantOK                bool
	}{
		{"https://github.com/opendatahub-io/odh-dashboard/pull/9097", "pr", "opendatahub-io/odh-dashboard#9097", true},
		{"https://redhat.atlassian.net/browse/RHOAIENG-123", "jira", "RHOAIENG-123", true},
		{"https://x.slack.com/archives/C069KSM8T9N/p1787087256917159", "slack", "C069KSM8T9N:1787087256.917159", true},
		{"https://example.com/nope", "", "", false},
		{"", "", "", false},
	}
	for _, c := range cases {
		gotType, gotID, gotOK := inferResource(c.url)
		if gotType != c.wantType || gotID != c.wantID || gotOK != c.wantOK {
			t.Errorf("inferResource(%q) = (%q,%q,%v), want (%q,%q,%v)",
				c.url, gotType, gotID, gotOK, c.wantType, c.wantID, c.wantOK)
		}
	}
}
