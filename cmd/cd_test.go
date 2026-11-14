package cmd

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/registry"
)

var cdEntries = []registry.Entry{
	{Path: "/w/a/foo", Repo: "a", Branch: "foo"},
	{Path: "/w/b/foo", Repo: "b", Branch: "foo"},
	{Path: "/w/a/pr-1-x", Repo: "a", Branch: "fix-x"},
	{Path: "/w/a/bar", Repo: "a", Branch: "baz"},
}

func cdPaths(es []registry.Entry) []string {
	out := make([]string, len(es))
	for i, e := range es {
		out[i] = e.Path
	}
	return out
}

func TestMatchWorktreesByBasenameOrBranch(t *testing.T) {
	t.Parallel()
	cases := map[string][]string{
		"foo":    {"/w/a/foo", "/w/b/foo"},
		"fix-x":  {"/w/a/pr-1-x"},
		"pr-1-x": {"/w/a/pr-1-x"},
		"baz":    {"/w/a/bar"},
		"nope":   {},
		"fo":     {},
	}
	for name, want := range cases {
		got := cdPaths(matchWorktrees(cdEntries, name))
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("matchWorktrees(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestChooseWorktreeSingleMatchNoPrompt(t *testing.T) {
	t.Parallel()
	var errw bytes.Buffer
	got, err := chooseWorktree(cdEntries[2:3], strings.NewReader(""), &errw, true)
	if err != nil || got.Path != "/w/a/pr-1-x" {
		t.Fatalf("got %v, %v", got.Path, err)
	}
	if errw.Len() != 0 {
		t.Fatalf("single match must not prompt, wrote %q", errw.String())
	}
}

func TestChooseWorktreePromptsAndPicks(t *testing.T) {
	t.Parallel()
	var errw bytes.Buffer
	got, err := chooseWorktree(cdEntries[:2], strings.NewReader("2\n"), &errw, true)
	if err != nil || got.Path != "/w/b/foo" {
		t.Fatalf("got %v, %v", got.Path, err)
	}
	for _, s := range []string{"[1]", "[2]", "/w/a/foo", "/w/b/foo", " a ", " b "} {
		if !strings.Contains(errw.String(), s) {
			t.Errorf("prompt missing %q:\n%s", s, errw.String())
		}
	}
}

func TestChooseWorktreeInvalidChoiceErrors(t *testing.T) {
	t.Parallel()
	for _, in := range []string{"", "\n", "0\n", "3\n", "x\n"} {
		var errw bytes.Buffer
		if got, err := chooseWorktree(cdEntries[:2], strings.NewReader(in), &errw, true); err == nil {
			t.Errorf("input %q: want error, got %s", in, got.Path)
		}
	}
}

func TestChooseWorktreeNonInteractiveAmbiguousErrors(t *testing.T) {
	t.Parallel()
	var errw bytes.Buffer
	_, err := chooseWorktree(cdEntries[:2], strings.NewReader("1\n"), &errw, false)
	if err == nil {
		t.Fatal("want error")
	}
	for _, p := range []string{"/w/a/foo", "/w/b/foo"} {
		if !strings.Contains(err.Error(), p) {
			t.Errorf("error %q missing candidate %s", err, p)
		}
	}
}

func TestCdNoMatchErrors(t *testing.T) {
	t.Parallel()
	var errw bytes.Buffer
	_, err := resolveCd(cdEntries, "nope", strings.NewReader(""), &errw, true)
	if err == nil || !strings.Contains(err.Error(), "nope") {
		t.Fatalf("want error naming the worktree, got %v", err)
	}
}

func TestCdHintWithoutShellFn(t *testing.T) {
	t.Parallel()
	env := func(v string) func(string) string {
		return func(k string) string {
			if k == "WORKTREE_SHELL_FN" {
				return v
			}
			return ""
		}
	}
	if !cdHintNeeded(env("")) {
		t.Error("no shell function: hint needed")
	}
	if cdHintNeeded(env("1")) {
		t.Error("shell function present: no hint")
	}
	if !strings.Contains(cdShellFnHint, "new shell") {
		t.Errorf("hint %q must say a new shell picks up the function (setup may have just run)", cdShellFnHint)
	}
	if !strings.Contains(cdShellFnHint, "worktree setup") {
		t.Errorf("hint %q must mention worktree setup", cdShellFnHint)
	}
}

func TestCdMissingDirectoryErrors(t *testing.T) {
	t.Parallel()
	gone := filepath.Join(t.TempDir(), "gone")
	es := []registry.Entry{{Path: gone, Repo: "a", Branch: "gone"}}
	var errw bytes.Buffer
	_, err := resolveCd(es, "gone", strings.NewReader(""), &errw, true)
	if err == nil || !strings.Contains(err.Error(), "worktree cleanup") {
		t.Fatalf("want an error pointing at worktree cleanup, got %v", err)
	}
}

func TestCdExistingDirectoryResolves(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	es := []registry.Entry{{Path: dir, Repo: "a", Branch: filepath.Base(dir)}}
	var errw bytes.Buffer
	got, err := resolveCd(es, filepath.Base(dir), strings.NewReader(""), &errw, true)
	if err != nil || got != dir {
		t.Fatalf("got %q, %v", got, err)
	}
}
