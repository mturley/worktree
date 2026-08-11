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

func TestResourcesJSONEmptyIsArray(t *testing.T) {
	b, err := resourcesJSON(nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "[]" {
		t.Fatalf("empty must serialize to [], got %s", b)
	}
}
