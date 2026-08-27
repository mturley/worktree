package cmd

import (
	"strings"
	"testing"
)

func TestClassifyAddInputRejectsNonCreatingForms(t *testing.T) {
	// The bug this prevents: runAdd used to FALL THROUGH to handleBranch, so
	// removing the Slack branch without an explicit rejection would create a
	// branch literally named "https://...".
	cases := []struct {
		name, arg, wantIn string
	}{
		{
			name:   "slack url redirects to resources add",
			arg:    "https://x.slack.com/archives/C123/p1700000000000200",
			wantIn: "worktree resources add",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := classifyAddInput(tc.arg)
			if err == nil {
				t.Fatal("want a redirect error, got nil — this would create a branch named after the URL")
			}
			if !strings.Contains(err.Error(), tc.wantIn) {
				t.Fatalf("error %q does not name the right command (want %q)", err, tc.wantIn)
			}
		})
	}
}

func TestClassifyAddInputCreatingForms(t *testing.T) {
	cases := []struct {
		arg  string
		want addKind
	}{
		{"https://github.com/o/r/pull/42", addPRURL},
		{"https://x.atlassian.net/browse/ABC-1", addJira},
		{"42", addPRNumber},
		{"my-feature-branch", addBranch},
	}
	for _, tc := range cases {
		t.Run(tc.arg, func(t *testing.T) {
			got, err := classifyAddInput(tc.arg)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("classifyAddInput(%q) = %v, want %v", tc.arg, got, tc.want)
			}
		})
	}
}
