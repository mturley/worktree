package setup

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	markerBegin = "# BEGIN worktree managed"
	markerEnd   = "# END worktree managed"
)

// shellRCVersion is stamped into the managed block's second line. Bump it
// whenever a snippet changes, so `worktree setup` replaces an older block in
// place instead of treating it as installed.
const shellRCVersion = 2

var versionLine = fmt.Sprintf("# worktree shell integration v%d", shellRCVersion)

// shFunctions is the `worktree cd` shell function, shared by zsh and bash.
const shFunctions = `# Shell function for ` + "`worktree cd <name>`" + ` (and ` + "`wt cd`" + `).
# A program can't change its parent shell's directory, so the cd has to
# happen here, in the shell. The binary resolves the name (asking on stderr
# if several worktrees match) and prints only the chosen path on stdout;
# this function cds there and shows ` + "`worktree info`" + `. Every other
# subcommand passes straight through to the binary. WORKTREE_SHELL_FN=1
# tells the binary this function is present, so it doesn't print the
# "re-run worktree setup" hint.
function _worktree_dispatch {
  local bin=$1; shift
  if [ "$1" = cd ]; then
    shift
    local dir
    dir=$(WORKTREE_SHELL_FN=1 command "$bin" cd "$@") || return
    # Not a directory (e.g. ` + "`wt cd --help`" + `): just show the output.
    [ -d "$dir" ] || { printf '%s\n' "$dir"; return; }
    builtin cd -- "$dir" && command "$bin" info
  else
    command "$bin" "$@"
  fi
}
# The "function name {" form, unlike "name() {", is not alias-expanded,
# so an existing alias named wt or worktree can't break this block.
function worktree { _worktree_dispatch worktree "$@"; }
function wt { _worktree_dispatch wt "$@"; }`

var zshSnippet = markerBegin + "\n" + versionLine + `
# Load worktree environment when entering a worktree directory
_worktree_env_hook() {
  eval "$(command worktree env)"
}
if [[ -z "$_WORKTREE_CHPWD_REGISTERED" ]]; then
  autoload -Uz add-zsh-hook
  add-zsh-hook chpwd _worktree_env_hook
  _WORKTREE_CHPWD_REGISTERED=1
  _worktree_env_hook
fi
` + shFunctions + "\n" + markerEnd

var bashSnippet = markerBegin + "\n" + versionLine + `
# Load worktree environment on each prompt
_worktree_env_hook() {
  eval "$(command worktree env)"
}
case "$PROMPT_COMMAND" in
  *_worktree_env_hook*) ;;
  *) PROMPT_COMMAND="_worktree_env_hook${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;
esac
` + shFunctions + "\n" + markerEnd

var fishSnippet = markerBegin + "\n" + versionLine + `
# Load worktree environment when the directory changes
function _worktree_env_hook --on-variable PWD
  eval (command worktree env)
end
_worktree_env_hook
# Shell function for ` + "`worktree cd <name>`" + ` (and ` + "`wt cd`" + `).
# A program can't change its parent shell's directory, so the cd has to
# happen here, in the shell. The binary resolves the name (asking on stderr
# if several worktrees match) and prints only the chosen path on stdout;
# this function cds there and shows ` + "`worktree info`" + `. Every other
# subcommand passes straight through to the binary. WORKTREE_SHELL_FN=1
# tells the binary this function is present, so it doesn't print the
# "re-run worktree setup" hint.
function worktree --wraps worktree
  if test "$argv[1]" = cd
    set -l dir (WORKTREE_SHELL_FN=1 command worktree cd $argv[2..-1]); or return
    # Not a directory (e.g. ` + "`wt cd --help`" + `): just show the output.
    test -d "$dir"; or begin; printf '%s\n' $dir; return; end
    builtin cd -- $dir; and command worktree info
  else
    command worktree $argv
  end
end
function wt --wraps wt; worktree $argv; end
` + markerEnd

type ShellRC struct {
	Shell string
	Path  string
}

func DetectShellRC() ShellRC {
	shell := os.Getenv("SHELL")
	home, _ := os.UserHomeDir()

	switch {
	case strings.HasSuffix(shell, "zsh"):
		return ShellRC{Shell: "zsh", Path: filepath.Join(home, ".zshrc")}
	case strings.HasSuffix(shell, "bash"):
		return ShellRC{Shell: "bash", Path: filepath.Join(home, ".bashrc")}
	case strings.HasSuffix(shell, "fish"):
		return ShellRC{Shell: "fish", Path: filepath.Join(home, ".config", "fish", "config.fish")}
	default:
		return ShellRC{Shell: "zsh", Path: filepath.Join(home, ".zshrc")}
	}
}

func (rc ShellRC) snippet() string {
	switch rc.Shell {
	case "zsh":
		return zshSnippet
	case "bash":
		return bashSnippet
	case "fish":
		return fishSnippet
	default:
		return zshSnippet
	}
}

// IsInstalled reports whether the rc file holds a managed block of the
// current version. An older block (or none) is not installed.
func (rc ShellRC) IsInstalled() bool {
	content, err := os.ReadFile(rc.Path)
	if err != nil {
		return false
	}
	begin, end, ok := managedBlock(string(content))
	return ok && strings.Contains(string(content)[begin:end], "\n"+versionLine+"\n")
}

// hasBlock reports whether the rc file holds a managed block of any version.
func (rc ShellRC) hasBlock() bool {
	content, err := os.ReadFile(rc.Path)
	if err != nil {
		return false
	}
	_, _, ok := managedBlock(string(content))
	return ok
}

// managedBlock locates the managed block: begin is markerBegin's offset and
// end is just past markerEnd.
func managedBlock(text string) (begin, end int, ok bool) {
	begin = strings.Index(text, markerBegin)
	if begin < 0 {
		return 0, 0, false
	}
	rel := strings.Index(text[begin:], markerEnd)
	if rel < 0 {
		return 0, 0, false
	}
	return begin, begin + rel + len(markerEnd), true
}

func (rc ShellRC) Install() error {
	if rc.IsInstalled() {
		return nil
	}

	content, _ := os.ReadFile(rc.Path)
	text := string(content)
	// An older block is replaced where it sits, leaving the rest of the
	// file byte-for-byte as it was.
	if begin, end, ok := managedBlock(text); ok {
		text = text[:begin] + rc.snippet() + text[end:]
		return os.WriteFile(rc.Path, []byte(text), 0644)
	}
	if text != "" && !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	text += "\n" + rc.snippet() + "\n"

	return os.WriteFile(rc.Path, []byte(text), 0644)
}

func (rc ShellRC) Uninstall() error {
	content, err := os.ReadFile(rc.Path)
	if err != nil {
		return nil
	}

	text := string(content)
	beginIdx := strings.Index(text, markerBegin)
	endIdx := strings.Index(text, markerEnd)
	if beginIdx < 0 || endIdx < 0 {
		return nil
	}

	endIdx += len(markerEnd)
	if endIdx < len(text) && text[endIdx] == '\n' {
		endIdx++
	}
	if beginIdx > 0 && text[beginIdx-1] == '\n' {
		beginIdx--
	}

	text = text[:beginIdx] + text[endIdx:]
	return os.WriteFile(rc.Path, []byte(text), 0644)
}

func (rc ShellRC) Description() string {
	verb := "Add"
	if rc.hasBlock() {
		verb = "Update"
	}
	return fmt.Sprintf("%s shell integration (`worktree env` hook, `worktree cd` function) in %s (%s)", verb, rc.Shell, rc.Path)
}
