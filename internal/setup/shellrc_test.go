package setup

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestZshSnippetUsesWorktreeEnv(t *testing.T) {
	rc := ShellRC{Shell: "zsh"}
	s := rc.snippet()
	if strings.Contains(s, ".worktree-env") || strings.Contains(s, "source ") {
		t.Fatalf("snippet must not source a file:\n%s", s)
	}
	if !strings.Contains(s, `eval "$(command worktree env)"`) {
		t.Fatalf("snippet must eval worktree env:\n%s", s)
	}
}

func TestBashAndFishSnippetsEvalWorktreeEnv(t *testing.T) {
	for _, sh := range []string{"bash", "fish"} {
		s := ShellRC{Shell: sh}.snippet()
		if !strings.Contains(s, "worktree env") {
			t.Fatalf("%s snippet must call worktree env:\n%s", sh, s)
		}
	}
}

// v1ZshBlock is the managed block setup wrote before it carried a version
// line (and before the `worktree cd` shell function).
const v1ZshBlock = `# BEGIN worktree managed
# Load worktree environment when entering a worktree directory
_worktree_env_hook() {
  eval "$(worktree env)"
}
if [[ -z "$_WORKTREE_CHPWD_REGISTERED" ]]; then
  autoload -Uz add-zsh-hook
  add-zsh-hook chpwd _worktree_env_hook
  _WORKTREE_CHPWD_REGISTERED=1
  _worktree_env_hook
fi
# END worktree managed`

func TestSnippetsCarryVersionLine(t *testing.T) {
	for _, sh := range []string{"zsh", "bash", "fish"} {
		s := ShellRC{Shell: sh}.snippet()
		lines := strings.Split(s, "\n")
		if len(lines) < 2 || lines[1] != "# worktree shell integration v2" {
			t.Errorf("%s snippet's second line = %q, want the version line", sh, lines[1])
		}
	}
}

func TestSnippetsDefineWorktreeAndWtFunctions(t *testing.T) {
	for _, sh := range []string{"zsh", "bash"} {
		s := ShellRC{Shell: sh}.snippet()
		for _, want := range []string{"function worktree {", "function wt {", "WORKTREE_SHELL_FN=1 command"} {
			if !strings.Contains(s, want) {
				t.Errorf("%s snippet missing %q", sh, want)
			}
		}
	}
	s := ShellRC{Shell: "fish"}.snippet()
	for _, want := range []string{"function worktree --wraps worktree", "function wt --wraps wt", "WORKTREE_SHELL_FN=1 command"} {
		if !strings.Contains(s, want) {
			t.Errorf("fish snippet missing %q", want)
		}
	}
}

func TestSnippetsExplainWhy(t *testing.T) {
	for _, sh := range []string{"zsh", "bash", "fish"} {
		if !strings.Contains(ShellRC{Shell: sh}.snippet(), "parent shell") {
			t.Errorf("%s snippet must explain that a program can't cd its parent shell", sh)
		}
	}
}

func writeRC(t *testing.T, content string) ShellRC {
	t.Helper()
	p := filepath.Join(t.TempDir(), ".zshrc")
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return ShellRC{Shell: "zsh", Path: p}
}

func readRC(t *testing.T, rc ShellRC) string {
	t.Helper()
	b, err := os.ReadFile(rc.Path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestIsInstalledFalseForOldBlock(t *testing.T) {
	if writeRC(t, "x\n\n"+v1ZshBlock+"\n").IsInstalled() {
		t.Fatal("a v1 block must not count as installed")
	}
}

func TestInstallReplacesOldBlockInPlace(t *testing.T) {
	rc := writeRC(t, "before\n"+v1ZshBlock+"\nafter\n")
	if err := rc.Install(); err != nil {
		t.Fatal(err)
	}
	got := readRC(t, rc)
	if want := "before\n" + zshSnippet + "\nafter\n"; got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
	if !rc.IsInstalled() {
		t.Fatal("installed after Install")
	}
}

func TestInstallIdempotent(t *testing.T) {
	rc := writeRC(t, "before\n")
	if err := rc.Install(); err != nil {
		t.Fatal(err)
	}
	first := readRC(t, rc)
	if err := rc.Install(); err != nil {
		t.Fatal(err)
	}
	if got := readRC(t, rc); got != first {
		t.Fatalf("second Install changed the file:\n%s", got)
	}
	if strings.Count(first, markerBegin) != 1 {
		t.Fatalf("want exactly one managed block:\n%s", first)
	}
}

func TestUninstallRemovesNewBlock(t *testing.T) {
	rc := writeRC(t, "before\n")
	if err := rc.Install(); err != nil {
		t.Fatal(err)
	}
	if err := rc.Uninstall(); err != nil {
		t.Fatal(err)
	}
	if got := readRC(t, rc); got != "before\n" {
		t.Fatalf("got %q", got)
	}
}

// fakeWorktreeBin writes a stand-in `worktree` (and `wt` link) that records
// how the shell function calls it.
func fakeWorktreeBin(t *testing.T, target string) string {
	t.Helper()
	bin := t.TempDir()
	script := `#!/bin/sh
case "$1" in
  cd)
    if [ "$2" = --help ]; then echo usage; exit 0; fi
    [ "$WORKTREE_SHELL_FN" = 1 ] || { echo "no WORKTREE_SHELL_FN" >&2; exit 1; }
    echo "` + target + `" ;;
  info) echo INFO ;;
  env) ;;
  *) echo "PASS:$*" ;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "worktree"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("worktree", filepath.Join(bin, "wt")); err != nil {
		t.Fatal(err)
	}
	return bin
}

func TestShellFunctionCdAndPassthrough(t *testing.T) {
	for _, sh := range []string{"bash", "zsh", "fish"} {
		t.Run(sh, func(t *testing.T) {
			shPath, err := exec.LookPath(sh)
			if err != nil {
				t.Skipf("%s not installed", sh)
			}
			target, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			bin := fakeWorktreeBin(t, target)
			script := ShellRC{Shell: sh}.snippet() + "\nworktree cd x; pwd; worktree list; wt cd --help; wt status\n"
			c := exec.Command(shPath, append(hermeticShellArgs(sh), script)...)
			c.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "_WORKTREE_CHPWD_REGISTERED=")
			out, err := c.CombinedOutput()
			if err != nil {
				t.Fatalf("%v\n%s", err, out)
			}
			want := "INFO\n" + target + "\nPASS:list\nusage\nPASS:status\n"
			if string(out) != want {
				t.Fatalf("got:\n%s\nwant:\n%s", out, want)
			}
		})
	}
}

func TestUninstallPreviewIncludesOldBlock(t *testing.T) {
	rc := writeRC(t, "before\n"+v1ZshBlock+"\n")
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	out := captureStdout(t, func() { PreviewUninstall(rc, configPath) })
	if !strings.Contains(out, "Remove auto-source from "+rc.Path) {
		t.Fatalf("an outdated block must still be offered for removal:\n%s", out)
	}
}

func TestDescriptionSaysUpdateForOldBlock(t *testing.T) {
	if d := writeRC(t, v1ZshBlock+"\n").Description(); !strings.HasPrefix(d, "Update ") {
		t.Errorf("old block: %q", d)
	}
	if d := writeRC(t, "").Description(); !strings.HasPrefix(d, "Add ") {
		t.Errorf("no block: %q", d)
	}
}

// A user's existing `alias wt=…` must not break the block (or the rest of
// the rc file after it).
func TestShellFunctionSurvivesExistingAliases(t *testing.T) {
	for _, sh := range []string{"bash", "zsh"} {
		t.Run(sh, func(t *testing.T) {
			shPath, err := exec.LookPath(sh)
			if err != nil {
				t.Skipf("%s not installed", sh)
			}
			target, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			bin := fakeWorktreeBin(t, target)
			script := "shopt -s expand_aliases 2>/dev/null\nalias wt='echo ALIAS'\nalias worktree='echo ALIAS'\n" +
				ShellRC{Shell: sh}.snippet() + "\necho AFTER\nunalias wt worktree\nwt cd x; pwd\n"
			c := exec.Command(shPath, append(hermeticShellArgs(sh), script)...)
			c.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "_WORKTREE_CHPWD_REGISTERED=")
			out, err := c.CombinedOutput()
			if err != nil {
				t.Fatalf("%v\n%s", err, out)
			}
			if want := "AFTER\nINFO\n" + target + "\n"; string(out) != want {
				t.Fatalf("got:\n%s\nwant:\n%s", out, want)
			}
		})
	}
}

// hermeticShellArgs runs sh -c without the user's startup files.
func hermeticShellArgs(sh string) []string {
	switch sh {
	case "zsh":
		return []string{"-f", "-c"}
	case "bash":
		return []string{"--norc", "--noprofile", "-c"}
	}
	return []string{"--no-config", "-c"}
}

func TestUninstallRemovesOldBlock(t *testing.T) {
	// As Install wrote it: a blank line, then the block.
	rc := writeRC(t, "before\n\n"+v1ZshBlock+"\n")
	if err := rc.Uninstall(); err != nil {
		t.Fatal(err)
	}
	if got := readRC(t, rc); got != "before\n" {
		t.Fatalf("got %q", got)
	}
}
