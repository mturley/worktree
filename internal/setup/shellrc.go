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

const zshSnippet = `# BEGIN worktree managed
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

const bashSnippet = `# BEGIN worktree managed
# Load worktree environment on each prompt
_worktree_env_hook() {
  eval "$(worktree env)"
}
case "$PROMPT_COMMAND" in
  *_worktree_env_hook*) ;;
  *) PROMPT_COMMAND="_worktree_env_hook${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;
esac
# END worktree managed`

const fishSnippet = `# BEGIN worktree managed
# Load worktree environment when the directory changes
function _worktree_env_hook --on-variable PWD
  eval (worktree env)
end
_worktree_env_hook
# END worktree managed`

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

func (rc ShellRC) IsInstalled() bool {
	content, err := os.ReadFile(rc.Path)
	if err != nil {
		return false
	}
	return strings.Contains(string(content), markerBegin)
}

func (rc ShellRC) Install() error {
	if rc.IsInstalled() {
		return nil
	}

	content, _ := os.ReadFile(rc.Path)
	text := string(content)
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
	return fmt.Sprintf("Load worktree env via `worktree env` in %s (%s)", rc.Shell, rc.Path)
}
