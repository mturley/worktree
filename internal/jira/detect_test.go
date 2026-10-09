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

func TestParseKey(t *testing.T) {
	tests := []struct {
		in      string
		wantKey string
		wantOK  bool
	}{
		{"RHOAIENG-123", "RHOAIENG-123", true},
		{"my-branch", "", false},
		{"abc-1", "ABC-1", true},
	}

	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			key, ok := ParseKey(tt.in)
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

func TestParseJiraURLAliasHosts(t *testing.T) {
	SetAliasHosts([]string{"Issues.Example.com"})
	t.Cleanup(func() { SetAliasHosts(nil) })

	cases := []struct {
		url  string
		key  string
		want bool
	}{
		{"https://issues.example.com/browse/PROJ-12", "PROJ-12", true},
		{"https://issues.example.com:443/browse/proj-12?focusedId=1", "PROJ-12", true},
		{"https://example.atlassian.net/browse/PROJ-3", "PROJ-3", true},
		// Not an alias host, and not an issue path on one.
		{"https://other.example.com/browse/PROJ-12", "", false},
		{"https://issues.example.com/projects/PROJ", "", false},
		{"https://evil.com/?u=https://issues.example.com/browse/PROJ-1", "", false},
	}
	for _, c := range cases {
		key, ok := ParseJiraURL(c.url)
		if ok != c.want || key != c.key {
			t.Errorf("ParseJiraURL(%q) = %q, %v; want %q, %v", c.url, key, ok, c.key, c.want)
		}
		if IsJiraURL(c.url) != c.want {
			t.Errorf("IsJiraURL(%q) != %v", c.url, c.want)
		}
	}
}

func TestParseJiraURLNoAliasesByDefault(t *testing.T) {
	SetAliasHosts(nil)
	if _, ok := ParseJiraURL("https://issues.example.com/browse/PROJ-12"); ok {
		t.Fatal("an unconfigured host must not be treated as Jira")
	}
}
