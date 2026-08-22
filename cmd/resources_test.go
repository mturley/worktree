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
