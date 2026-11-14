package cmd

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/ui"
	"github.com/spf13/cobra"
)

// cdShellFnHint is printed (to stderr) when `worktree cd` runs without the
// shell function from `worktree setup`, which is what actually changes the
// shell's directory: a program cannot change its parent shell's cwd.
const cdShellFnHint = "worktree cd needs its shell function to change directory: open a new shell, or run `worktree setup` if you haven't since updating"

var cdCmd = &cobra.Command{
	Use:   "cd <name>",
	Short: "Change into a worktree by directory name or branch (needs the shell function from setup)",
	Long: "Resolve a worktree by its directory name or branch and change the shell into it, then show `worktree info`.\n\n" +
		"The binary prints only the chosen path on stdout; the shell function `worktree setup` adds to your rc file " +
		"does the cd. When the name matches several worktrees it asks which one (on stderr).",
	GroupID:           "worktree",
	Args:              cobra.ExactArgs(1),
	RunE:              runCd,
	ValidArgsFunction: completeWorktreeNames,
}

func init() {
	rootCmd.AddCommand(cdCmd)
}

func runCd(cmd *cobra.Command, args []string) error {
	conn, err := wdb.OpenRead()
	if err != nil {
		return err
	}
	defer conn.Close()
	entries, err := registry.List(conn)
	if err != nil {
		return fmt.Errorf("listing worktrees: %w", err)
	}
	errw := cmd.ErrOrStderr()
	interactive := ui.StdinIsTerminal() && !ui.NonInteractive()
	path, err := resolveCd(entries, args[0], cmd.InOrStdin(), errw, interactive)
	if err != nil {
		return err
	}
	if cdHintNeeded(os.Getenv) {
		fmt.Fprintln(errw, ui.Dim(cdShellFnHint))
	}
	fmt.Fprintln(cmd.OutOrStdout(), path)
	return nil
}

// cdHintNeeded reports whether the shell function is absent: it sets
// WORKTREE_SHELL_FN=1 when it calls `worktree cd`.
func cdHintNeeded(getenv func(string) string) bool {
	return getenv("WORKTREE_SHELL_FN") != "1"
}

// resolveCd picks the worktree `worktree cd <name>` should enter.
func resolveCd(entries []registry.Entry, name string, in io.Reader, errw io.Writer, interactive bool) (string, error) {
	matches := matchWorktrees(entries, name)
	if len(matches) == 0 {
		return "", fmt.Errorf("no worktree named %q (matched against directory names and branches)", name)
	}
	e, err := chooseWorktree(matches, in, errw, interactive)
	if err != nil {
		return "", err
	}
	// The registry doesn't stat paths, so a directory removed outside
	// worktree still has a row. Say so rather than print a path the shell
	// function can't enter.
	if fi, err := os.Stat(e.Path); err != nil || !fi.IsDir() {
		return "", fmt.Errorf("worktree directory %s no longer exists; run `worktree cleanup` to reconcile", e.Path)
	}
	return e.Path, nil
}

// matchWorktrees returns the entries whose directory basename or branch is
// exactly name, in registry order. An entry matching both appears once.
func matchWorktrees(entries []registry.Entry, name string) []registry.Entry {
	var out []registry.Entry
	for _, e := range entries {
		if filepath.Base(e.Path) == name || e.Branch == name {
			out = append(out, e)
		}
	}
	return out
}

// chooseWorktree returns the single match, or asks on errw which of several
// to use, reading the answer from in. It never defaults: an empty or
// invalid answer is an error, as is ambiguity when nobody can answer.
func chooseWorktree(matches []registry.Entry, in io.Reader, errw io.Writer, interactive bool) (registry.Entry, error) {
	if len(matches) == 1 {
		return matches[0], nil
	}
	if !interactive {
		var b strings.Builder
		b.WriteString("several worktrees match; pass a name that is unique, or run in a terminal to choose:")
		for _, m := range matches {
			b.WriteString("\n  ")
			b.WriteString(m.Path)
		}
		return registry.Entry{}, fmt.Errorf("%s", b.String())
	}
	fmt.Fprintln(errw, "Several worktrees match:")
	for i, m := range matches {
		fmt.Fprintf(errw, "  [%d] %s  %s  %s\n", i+1, m.Repo, ui.Bold(m.Branch), ui.Dim(ui.ShortPath(m.Path)))
	}
	fmt.Fprint(errw, "Which worktree?: ")
	line, _ := bufio.NewReader(in).ReadString('\n')
	line = strings.TrimSpace(line)
	n, err := strconv.Atoi(line)
	if err != nil || n < 1 || n > len(matches) {
		return registry.Entry{}, fmt.Errorf("invalid choice: %q", line)
	}
	return matches[n-1], nil
}

// completeWorktreeNames offers every registered worktree's directory name
// and branch.
func completeWorktreeNames(_ *cobra.Command, args []string, _ string) ([]string, cobra.ShellCompDirective) {
	if len(args) > 0 {
		return nil, cobra.ShellCompDirectiveNoFileComp
	}
	conn, err := wdb.OpenRead()
	if err != nil {
		return nil, cobra.ShellCompDirectiveNoFileComp
	}
	defer conn.Close()
	entries, err := registry.List(conn)
	if err != nil {
		return nil, cobra.ShellCompDirectiveNoFileComp
	}
	seen := map[string]bool{}
	var out []string
	for _, e := range entries {
		for _, n := range []string{filepath.Base(e.Path), e.Branch} {
			if n != "" && !seen[n] {
				seen[n] = true
				out = append(out, n)
			}
		}
	}
	sort.Strings(out)
	return out, cobra.ShellCompDirectiveNoFileComp
}
