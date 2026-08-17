package jira

import (
	"testing"
)

func TestDetectKeys(t *testing.T) {
	projects := []string{"RHOAIENG", "RHOAI", "ODH"}

	tests := []struct {
		name     string
		branch   string
		prTitle  string
		prBody   string
		expected []string
	}{
		{
			name:     "from branch",
			branch:   "RHOAIENG-12345-fix-pagination",
			expected: []string{"RHOAIENG-12345"},
		},
		{
			name:     "from PR title",
			prTitle:  "[RHOAI-100] Fix something",
			expected: []string{"RHOAI-100"},
		},
		{
			name:     "multiple sources deduped",
			branch:   "RHOAIENG-123",
			prTitle:  "RHOAIENG-123: fix",
			expected: []string{"RHOAIENG-123"},
		},
		{
			name:     "multiple keys",
			branch:   "RHOAIENG-1",
			prBody:   "Also fixes ODH-2",
			expected: []string{"RHOAIENG-1", "ODH-2"},
		},
		{
			name:     "no match",
			branch:   "feature-branch",
			expected: nil,
		},
		{
			name:     "case insensitive",
			branch:   "rhoaieng-999",
			expected: []string{"RHOAIENG-999"},
		},
		{
			name:     "ignores keys inside HTML comments",
			prBody:   "<!-- e.g. RHOAIENG-123456 -->\nCloses RHOAIENG-777",
			expected: []string{"RHOAIENG-777"},
		},
		{
			name:     "ignores keys inside multiline HTML comments",
			prBody:   "<!--\nExample: RHOAIENG-123456\nAnother: ODH-999\n-->\nRHOAIENG-42",
			expected: []string{"RHOAIENG-42"},
		},
		{
			name:     "unterminated HTML comment strips to end",
			prBody:   "RHOAIENG-1\n<!-- trailing note RHOAIENG-123456",
			expected: []string{"RHOAIENG-1"},
		},
		{
			name:     "body with only a commented key yields nothing",
			prBody:   "<!-- RHOAIENG-123456 -->",
			expected: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := DetectKeys(tt.branch, tt.prTitle, tt.prBody, projects)
			if len(got) != len(tt.expected) {
				t.Fatalf("got %v, want %v", got, tt.expected)
			}
			for i := range got {
				if got[i] != tt.expected[i] {
					t.Errorf("got[%d] = %s, want %s", i, got[i], tt.expected[i])
				}
			}
		})
	}
}

func TestParseJiraURL(t *testing.T) {
	tests := []struct {
		url     string
		wantKey string
		wantOK  bool
	}{
		{"https://redhat.atlassian.net/browse/RHOAIENG-5678", "RHOAIENG-5678", true},
		{"https://my-org.atlassian.net/browse/PROJ-1", "PROJ-1", true},
		{"https://github.com/owner/repo/pull/123", "", false},
		{"not a url", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.url, func(t *testing.T) {
			key, ok := ParseJiraURL(tt.url)
			if ok != tt.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tt.wantOK)
			}
			if key != tt.wantKey {
				t.Errorf("key = %s, want %s", key, tt.wantKey)
			}
		})
	}
}

func TestIsJiraURL(t *testing.T) {
	if !IsJiraURL("https://redhat.atlassian.net/browse/RHOAIENG-123") {
		t.Error("expected true for Jira URL")
	}
	if IsJiraURL("https://github.com/foo/bar") {
		t.Error("expected false for GitHub URL")
	}
}
