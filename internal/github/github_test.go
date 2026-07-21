package github

import (
	"testing"
)

func TestParsePRURL(t *testing.T) {
	tests := []struct {
		url        string
		wantOwner  string
		wantRepo   string
		wantNumber int
		wantOK     bool
	}{
		{
			url:        "https://github.com/opendatahub-io/odh-dashboard/pull/1234",
			wantOwner:  "opendatahub-io",
			wantRepo:   "odh-dashboard",
			wantNumber: 1234,
			wantOK:     true,
		},
		{
			url:        "https://github.com/owner/repo/pull/1",
			wantOwner:  "owner",
			wantRepo:   "repo",
			wantNumber: 1,
			wantOK:     true,
		},
		{
			url:    "https://github.com/owner/repo",
			wantOK: false,
		},
		{
			url:    "https://redhat.atlassian.net/browse/RHOAIENG-123",
			wantOK: false,
		},
		{
			url:    "not a url",
			wantOK: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.url, func(t *testing.T) {
			owner, repo, number, ok := ParsePRURL(tt.url)
			if ok != tt.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tt.wantOK)
			}
			if !tt.wantOK {
				return
			}
			if owner != tt.wantOwner || repo != tt.wantRepo || number != tt.wantNumber {
				t.Errorf("got (%s, %s, %d), want (%s, %s, %d)",
					owner, repo, number, tt.wantOwner, tt.wantRepo, tt.wantNumber)
			}
		})
	}
}

func TestSlugify(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"Fix pagination in list view", "fix-pagination-in-list-view"},
		{"[RHOAIENG-123] Add feature", "rhoaieng-123-add-feature"},
		{"Simple", "simple"},
		{"", ""},
		{"A very long title that should be truncated at some point because it exceeds the maximum length allowed", "a-very-long-title-that-should-be"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := Slugify(tt.input)
			if len(got) > 50 {
				t.Errorf("slug too long: %d chars", len(got))
			}
		})
	}
}

func TestIsPRNumber(t *testing.T) {
	if !IsPRNumber("1234") {
		t.Error("expected true for 1234")
	}
	if IsPRNumber("abc") {
		t.Error("expected false for abc")
	}
	if IsPRNumber("") {
		t.Error("expected false for empty")
	}
}
