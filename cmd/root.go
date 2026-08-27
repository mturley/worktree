package cmd

import (
	"database/sql"
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/config"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/dotfiles"
	"github.com/mturley/worktree/internal/env"
	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/jira"
	"github.com/mturley/worktree/internal/ports"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/ui"
	"github.com/mturley/worktree/internal/worktreenew"
	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "worktree",
	Short: "CLI for managing git worktrees",
	Long:  "CLI for managing git worktrees with GitHub/Jira integration and optional cmux support.",
	Args:  cobra.NoArgs,
	RunE:  runRoot,
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func init() {
	rootCmd.AddGroup(
		&cobra.Group{ID: "worktree", Title: "Worktree commands:"},
		&cobra.Group{ID: "integration", Title: "Integrations:"},
		&cobra.Group{ID: "admin", Title: "Admin:"},
	)
}

var globalWebFS embed.FS

// SetWebFS receives the embedded web UI assets from main.
func SetWebFS(f embed.FS) { globalWebFS = f }

func runRoot(cmd *cobra.Command, args []string) error {
	cmd.Help()
	fmt.Println()
	fmt.Println(ui.Dim("─────────────────────────────────────────"))
	fmt.Println()
	runInfo(cmd, args)
	return nil
}

func handlePR(owner, repo string, number int) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	repoRoot, err := findRepoForPR(cfg, owner, repo)
	if err != nil {
		return err
	}
	return runCreate(fmt.Sprintf("https://github.com/%s/%s/pull/%d", owner, repo, number), repoRoot)
}

func handlePRNumber(arg string) error {
	number, _ := strconv.Atoi(arg)
	repoRoot, err := findRepoRoot()
	if err != nil {
		return fmt.Errorf("not in a git repo (needed to determine which repo's PR to fetch): %w", err)
	}

	slug := gitutil.RepoSlug(repoRoot)
	parts := strings.SplitN(slug, "/", 2)
	if len(parts) != 2 {
		return fmt.Errorf("cannot determine repo owner/name from remotes")
	}

	return handlePR(parts[0], parts[1], number)
}

func handleJiraURL(url string) error {
	key, ok := jira.ParseJiraURL(url)
	if !ok {
		return fmt.Errorf("could not parse Jira issue key from URL: %s", url)
	}
	return handleJiraIssue(key, url)
}

func handleJiraIssue(key, url string) error {
	repoRoot, err := findRepoRoot()
	if err != nil {
		return fmt.Errorf("not in a git repo: %w", err)
	}
	if url == "" {
		url = jira.IssueURL(jira.HostFromWatcherConfig(), key)
	}
	return runCreate(url, repoRoot)
}

func handleBranch(branchName string) error {
	repoRoot, err := findRepoRoot()
	if err != nil {
		return fmt.Errorf("not in a git repo: %w", err)
	}
	return runCreate(branchName, repoRoot)
}

// runCreate drives the shared creation runner, keeping the CLI's existing
// output. Confirmations are answered by re-running with the flag set — the
// same replay the web UI performs, so both surfaces exercise one code path.
func runCreate(input, repoRoot string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	conn, err := wdb.Open()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to open worktree db: %v\n", err)
	} else {
		defer conn.Close()
	}

	opts := worktreenew.Options{
		Input:        input,
		RepoRoot:     repoRoot,
		Pull:         ui.ConfirmDefault("git pull before creating worktree?", true),
		CopyDotfiles: confirmDotfiles(repoRoot),
	}

	for {
		res := worktreenew.Run(conn, cfg, opts, func(s worktreenew.Step) {
			switch s.Status {
			case worktreenew.StatusDone:
				line := fmt.Sprintf("  %s %s", ui.Green("✓"), s.Label)
				if s.Detail != "" {
					line += ": " + ui.Dim(s.Detail)
				}
				fmt.Println(line)
			case worktreenew.StatusFailed:
				fmt.Fprintf(os.Stderr, "  %s %s: %s\n", ui.Yellow("!"), s.Label, s.Detail)
			}
		})
		if res.Err != nil {
			return res.Err
		}
		if res.Confirm == nil {
			fmt.Printf("\n%s Worktree ready at %s\n", ui.Green("✓"), ui.ShortPath(res.Path))
			printWorktreeEnv(conn, repoRoot, res)
			return offerCmuxAfterCreate(conn, cfg, res)
		}

		c := res.Confirm
		switch c.Key {
		case worktreenew.ConfirmReuseBranch:
			fmt.Printf("  Branch %s already exists\n", ui.Yellow(c.Branch))
			if !ui.Confirm("  Reuse this branch?") {
				fmt.Println("Aborted.")
				return nil
			}
			opts.ReuseBranch = true
		case worktreenew.ConfirmResetToPR:
			fmt.Printf("  %s Local (%s) differs from PR latest (%s)\n",
				ui.Yellow("!"), shortSHA(c.LocalHead), shortSHA(c.RemoteHead))
			if !ui.Confirm("  Reset to the PR's latest commit?") {
				// Declining is NOT an abort. By this point gitutil has already
				// created the worktree directory, so returning here would strand
				// it: on disk, unregistered, holding no port range, invisible to
				// the tool. Set DeclineReset and loop, so the runner skips the
				// reset and carries on to finalize — the worktree is perfectly
				// usable at its current commit.
				opts.DeclineReset = true
				continue
			}
			opts.ResetToPR = true
		}
	}
}

// printWorktreeEnv reproduces the environment summary the CLI has always
// printed after creating a worktree. The runner allocates the port range, so
// the range is read back rather than allocated again.
func printWorktreeEnv(conn *sql.DB, repoRoot string, res worktreenew.Result) {
	mainRoot := gitutil.MainRoot(repoRoot)
	if mainRoot == "" {
		mainRoot = repoRoot
	}
	wtName := filepath.Base(res.Path)
	kubePath := env.KubeconfigPath(filepath.Base(mainRoot), wtName)

	portRange := "unassigned"
	if conn != nil {
		if alloc, ok, err := ports.Lookup(conn, wtName); err == nil && ok {
			portRange = alloc.Range()
		}
	}

	fmt.Printf("\n  %s\n", ui.Dim("Environment (via eval \"$(worktree env)\"):"))
	fmt.Printf("    WORKTREE_PATH  = %s\n", ui.ShortPath(res.Path))
	fmt.Printf("    WORKTREE_TITLE = wt %s\n", res.Branch)
	fmt.Printf("    WORKTREE_PORTS = %s\n", portRange)
	fmt.Printf("    KUBECONFIG     = %s\n\n", ui.ShortPath(kubePath))
}

// offerCmuxAfterCreate opens a cmux workspace for the new worktree when cmux
// is available.
func offerCmuxAfterCreate(conn *sql.DB, cfg config.Config, res worktreenew.Result) error {
	if !cmux.IsAvailable() {
		return nil
	}
	return openCmuxWorkspace(conn, cfg, res.Path, res.Branch)
}

func shortSHA(sha string) string {
	if len(sha) > 8 {
		return sha[:8]
	}
	return sha
}

func openCmuxWorkspace(conn *sql.DB, cfg config.Config, wtPath, branch string) error {
	existing, err := cmux.FindByDirectory(wtPath)
	if err == nil && existing != nil {
		fmt.Printf("%s Switching to existing cmux workspace %s\n", ui.Cyan("→"), existing.CustomTitle)
		return cmux.SelectWorkspace(existing.Ref)
	}

	var res []resources.Resource
	if conn != nil {
		res, _ = resources.Load(conn, wtPath)
	}
	uiURL := runningUIDetailURL(conn, wtPath)
	urls := buildWorkspaceURLs(res)

	defaultTitle := fmt.Sprintf("wt %s", branch)
	fmt.Println()
	title := ui.PromptLineDefault("  Workspace name", defaultTitle)

	groupRef := promptCmuxGroup()
	color := promptCmuxColor()

	layout := cmux.BuildLayout(uiURL, urls)

	opts := cmux.NewWorkspaceOptions{
		Name:     title,
		Cwd:      wtPath,
		Focus:    true,
		GroupRef: groupRef,
	}
	if layout != "" {
		opts.Layout = layout
	}

	ref, err := cmux.NewWorkspace(opts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to create cmux workspace: %v\n", err)
		return nil
	}

	if color != "" {
		cmux.SetWorkspaceColor(ref, color)
	}
	fmt.Printf("%s Created cmux workspace %s\n", ui.Green("✓"), ref)

	// Pin the worktree UI / GitHub / Jira tabs (every URL we laid out, in both
	// panes) so they survive the close-others/close-right tab actions, then
	// land on the first tab of the left-hand browser pane.
	if uiURL != "" || len(urls) > 0 {
		cmux.PinBrowserTabs(ref)
		cmux.FocusFirstBrowserTab(ref)
	}
	return nil
}

// buildWorkspaceURLs orders the browser tabs of a new cmux workspace's
// left-hand pane: GitHub PRs first, then the primary Jira issues. (The
// running worktree UI gets its own tab in the main terminal's pane, so it is
// not part of this list.) Resources with no URL, and Jira issues merely
// related to the worktree, are skipped.
func buildWorkspaceURLs(res []resources.Resource) []string {
	var urls []string
	for _, r := range resources.OfType(res, "pr") {
		if r.URL != "" {
			urls = append(urls, r.URL)
		}
	}
	for _, r := range resources.OfType(res, "jira") {
		if !r.Related && r.URL != "" {
			urls = append(urls, r.URL)
		}
	}
	return urls
}

// confirmDotfiles lists the main worktree's gitignored dotfiles and asks
// whether to copy them. The copying itself belongs to the runner (so the web
// UI does it too); only the question stays here.
func confirmDotfiles(repoRoot string) bool {
	mainRoot := gitutil.MainRoot(repoRoot)
	if mainRoot == "" {
		mainRoot = repoRoot
	}
	dfs, err := dotfiles.Discover(mainRoot)
	if err != nil || len(dfs) == 0 {
		return false
	}

	fmt.Printf("\nFound %d gitignored dotfiles in main worktree:\n", len(dfs))
	for _, df := range dfs {
		kind := "file"
		if df.IsDir {
			kind = "dir"
		}
		fmt.Printf("  %s %s\n", ui.Dim(kind), df.Name)
	}
	return ui.Confirm("\nCopy these dotfiles to the new worktree?")
}

func promptCmuxGroup() string {
	groups, err := cmux.ListGroups()
	if err != nil || len(groups) == 0 {
		return ""
	}

	fmt.Println("  Workspace group (Enter for none):")
	for i, g := range groups {
		fmt.Printf("    %s %s\n", ui.Dim(fmt.Sprintf("[%d]", i+1)), g.Name)
	}
	choice := ui.PromptChoiceOptional("  Group", len(groups))
	if choice == 0 {
		return ""
	}
	return groups[choice-1].Ref
}

func promptCmuxColor() string {
	fmt.Println("  Workspace color (Enter for none):")
	for i, c := range cmux.NamedColors {
		fmt.Printf("    %s %s %s\n", ui.Dim(fmt.Sprintf("[%d]", i+1)), cmux.ColorDot(c.Hex), c.Name)
	}
	choice := ui.PromptChoiceOptional("  Color", len(cmux.NamedColors))
	if choice == 0 {
		return ""
	}
	return cmux.NamedColors[choice-1].Name
}

func findRepoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	return gitutil.RepoRoot(dir)
}

func findRepoForPR(cfg config.Config, owner, repo string) (string, error) {
	// Try current directory first
	if root, err := findRepoRoot(); err == nil {
		if gitutil.MatchesRemote(root, owner, repo) {
			return root, nil
		}
	}

	return "", fmt.Errorf("cannot find local clone of %s/%s — run this command from inside the repo", owner, repo)
}
