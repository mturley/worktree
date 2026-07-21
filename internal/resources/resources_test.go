package resources

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseLine(t *testing.T) {
	tests := []struct {
		line    string
		want    Resource
		wantErr bool
	}{
		{
			line: "pr:owner/repo#123 https://github.com/owner/repo/pull/123",
			want: Resource{Type: "pr", ID: "owner/repo#123", URL: "https://github.com/owner/repo/pull/123"},
		},
		{
			line: "jira:RHOAIENG-456 https://redhat.atlassian.net/browse/RHOAIENG-456",
			want: Resource{Type: "jira", ID: "RHOAIENG-456", URL: "https://redhat.atlassian.net/browse/RHOAIENG-456"},
		},
		{
			line: "~ jira:RHOAIENG-400 https://redhat.atlassian.net/browse/RHOAIENG-400",
			want: Resource{Type: "jira", ID: "RHOAIENG-400", URL: "https://redhat.atlassian.net/browse/RHOAIENG-400", Related: true},
		},
		{
			line:    "invalid",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.line, func(t *testing.T) {
			got, err := parseLine(tt.line)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestLoadSaveRoundTrip(t *testing.T) {
	dir := t.TempDir()
	resources := []Resource{
		{Type: "pr", ID: "owner/repo#1", URL: "https://github.com/owner/repo/pull/1"},
		{Type: "jira", ID: "PROJ-100", URL: "https://jira.example.com/browse/PROJ-100"},
		{Type: "jira", ID: "PROJ-200", URL: "https://jira.example.com/browse/PROJ-200", Related: true},
	}

	if err := Save(dir, resources); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(loaded) != len(resources) {
		t.Fatalf("got %d resources, want %d", len(loaded), len(resources))
	}
	for i := range resources {
		if loaded[i] != resources[i] {
			t.Errorf("resource %d: got %+v, want %+v", i, loaded[i], resources[i])
		}
	}
}

func TestLoadMissing(t *testing.T) {
	dir := t.TempDir()
	res, err := Load(filepath.Join(dir, "nonexistent"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(res) != 0 {
		t.Errorf("expected empty, got %d", len(res))
	}
}

func TestAddPrimaryDemotesExisting(t *testing.T) {
	dir := t.TempDir()
	Save(dir, []Resource{
		{Type: "jira", ID: "PROJ-1", URL: "https://example.com/PROJ-1"},
	})

	Add(dir, Resource{Type: "jira", ID: "PROJ-2", URL: "https://example.com/PROJ-2"})

	loaded, _ := Load(dir)
	if len(loaded) != 2 {
		t.Fatalf("expected 2 resources, got %d", len(loaded))
	}
	if !loaded[0].Related {
		t.Error("expected old primary to be demoted to related")
	}
	if loaded[1].Related {
		t.Error("expected new resource to be primary")
	}
}

func TestPrimaryOfType(t *testing.T) {
	resources := []Resource{
		{Type: "pr", ID: "owner/repo#1", URL: "https://github.com/owner/repo/pull/1"},
		{Type: "jira", ID: "PROJ-1", URL: "https://example.com/PROJ-1", Related: true},
		{Type: "jira", ID: "PROJ-2", URL: "https://example.com/PROJ-2"},
	}

	pr := PrimaryOfType(resources, "pr")
	if pr == nil || pr.ID != "owner/repo#1" {
		t.Errorf("expected PR, got %v", pr)
	}

	jira := PrimaryOfType(resources, "jira")
	if jira == nil || jira.ID != "PROJ-2" {
		t.Errorf("expected PROJ-2, got %v", jira)
	}

	missing := PrimaryOfType(resources, "slack")
	if missing != nil {
		t.Errorf("expected nil, got %v", missing)
	}
}

func TestRemove(t *testing.T) {
	dir := t.TempDir()
	Save(dir, []Resource{
		{Type: "jira", ID: "PROJ-1", URL: "https://example.com/PROJ-1"},
		{Type: "jira", ID: "PROJ-2", URL: "https://example.com/PROJ-2"},
	})

	Remove(dir, "jira", "PROJ-1")
	loaded, _ := Load(dir)
	if len(loaded) != 1 || loaded[0].ID != "PROJ-2" {
		t.Errorf("expected only PROJ-2 remaining, got %+v", loaded)
	}
	_ = os.Remove("") // satisfy import
}
