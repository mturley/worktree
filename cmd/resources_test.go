package cmd

import (
	"encoding/json"
	"testing"

	"github.com/mturley/worktree/internal/resources"
)

func TestResourcesJSONContract(t *testing.T) {
	rs := []resources.Resource{
		{Type: "pr", ID: "o/r#1", URL: "http://x/1", Related: false},
		{Type: "jira", ID: "RH-2", URL: "http://x/2", Related: true},
	}
	b, err := resourcesJSON(rs)
	if err != nil {
		t.Fatal(err)
	}
	var got []map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d", len(got))
	}
	if got[0]["type"] != "pr" || got[0]["id"] != "o/r#1" || got[0]["primary"] != true {
		t.Fatalf("row0: %+v", got[0])
	}
	if got[1]["primary"] != false {
		t.Fatalf("related resource must be primary=false: %+v", got[1])
	}
	// exact field set — the contract handler binds to
	for _, k := range []string{"type", "id", "url", "primary"} {
		if _, ok := got[0][k]; !ok {
			t.Fatalf("missing field %q", k)
		}
	}
}

func TestResourcesJSONIncludesMetaFields(t *testing.T) {
	rs := []resources.Resource{
		{Type: "slack", ID: "C1:1.2", URL: "http://x", CustomName: "Release blocker",
			CustomDescription: "e2e regression", UpdatedAt: "2030-01-02T03:04:05Z"},
	}
	b, err := resourcesJSON(rs)
	if err != nil {
		t.Fatal(err)
	}
	var got []map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got[0]["custom_name"] != "Release blocker" ||
		got[0]["custom_description"] != "e2e regression" ||
		got[0]["updated_at"] != "2030-01-02T03:04:05Z" {
		t.Fatalf("meta fields missing/wrong: %+v", got[0])
	}
}

func TestResourcesJSONOmitsEmptyMeta(t *testing.T) {
	b, err := resourcesJSON([]resources.Resource{{Type: "pr", ID: "o/r#1", URL: "u"}})
	if err != nil {
		t.Fatal(err)
	}
	var got []map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"custom_name", "custom_description", "updated_at"} {
		if _, ok := got[0][k]; ok {
			t.Fatalf("empty meta field %q should be omitted, got %+v", k, got[0])
		}
	}
}

func TestResourcesJSONEmptyIsArray(t *testing.T) {
	b, err := resourcesJSON(nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "[]" {
		t.Fatalf("empty must serialize to [], got %s", b)
	}
}

func TestResolveResourceArgs(t *testing.T) {
	cases := []struct {
		name     string
		args     []string
		wantType string
		wantID   string
		wantURL  string
		wantErr  bool
		setup    func(t *testing.T)
	}{
		{
			name:     "url form infers type and id",
			args:     []string{"https://github.com/o/r/pull/42"},
			wantType: "pr",
			wantID:   "o/r#42",
			wantURL:  "https://github.com/o/r/pull/42",
		},
		{
			name:     "slack url form",
			args:     []string{"https://x.slack.com/archives/C123/p1700000000000200"},
			wantType: "slack",
			wantID:   "C123:1700000000.000200",
			wantURL:  "https://x.slack.com/archives/C123/p1700000000000200",
		},
		{
			name:     "explicit two-arg form still works",
			args:     []string{"jira", "ABC-1"},
			wantType: "jira",
			wantID:   "ABC-1",
		},
		{
			name:     "two-arg form carries the --url flag through",
			args:     []string{"jira", "ABC-1"},
			wantType: "jira",
			wantID:   "ABC-1",
			wantURL:  "https://x.atlassian.net/browse/ABC-1",
			setup: func(t *testing.T) {
				prev := resURL
				resURL = "https://x.atlassian.net/browse/ABC-1"
				t.Cleanup(func() { resURL = prev })
			},
		},
		{
			name:    "unrecognized single arg is an error, not a resource",
			args:    []string{"just-some-text"},
			wantErr: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.setup != nil {
				tc.setup(t)
			}
			gt, gi, gu, err := resolveResourceArgs(tc.args)
			if tc.wantErr {
				if err == nil {
					t.Fatal("want an error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if gt != tc.wantType || gi != tc.wantID || gu != tc.wantURL {
				t.Fatalf("= (%q,%q,%q), want (%q,%q,%q)",
					gt, gi, gu, tc.wantType, tc.wantID, tc.wantURL)
			}
		})
	}
}
