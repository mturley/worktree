package cmd

import (
	"database/sql"
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	wconfig "github.com/mturley/watcher/config"
	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/config"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/dotfiles"
	"github.com/mturley/worktree/internal/env"
	"github.com/mturley/worktree/internal/github"
	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/jira"
	"github.com/mturley/worktree/internal/ports"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/ui"
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

var prURLPattern = regexp.MustCompile(`github\.com/([^/]+)/([^/]+)/pull/(\d+)`)

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

	var pr *github.PRInfo
	err = ui.SpinWhile(fmt.Sprintf("Fetching PR #%d from %s/%s", number, owner, repo), func() error {
		var fetchErr error
		pr, fetchErr = github.FetchPRByRepo(owner, repo, number)
		return fetchErr
	})
	if err != nil {
		return err
	}
	fmt.Printf("  %s\n", ui.Bold(pr.Title))
	fmt.Printf("  by @%s · %s\n\n", pr.Author, pr.State)

	repoRoot, err := findRepoForPR(cfg, owner, repo)
	if err != nil {
		return err
	}

	remote, err := gitutil.FindRemoteForRepo(repoRoot, owner, repo)
	if err != nil {
		return fmt.Errorf("resolving remote: %w", err)
	}
	fmt.Printf("  Using remote: %s\n", ui.Dim(remote))

	slug := github.Slugify(pr.Title)
	var prResult gitutil.PRWorktreeResult
	err = ui.SpinWhile("Creating worktree", func() error {
		var createErr error
		prResult, createErr = gitutil.CreatePRWorktree(repoRoot, cfg.WorktreesBase, remote, number, pr.HeadRef, slug)
		return createErr
	})
	if err != nil {
		return err
	}

	switch prResult.Status {
	case gitutil.PRWorktreeCreated:
		// Fresh — nothing to confirm

	case gitutil.PRWorktreeExistingDir:
		// Worktree directory exists — offer sync if behind
		offerPRSync(prResult)

	case gitutil.PRWorktreeBranchExists:
		// Branch exists but worktree was deleted — confirm reuse
		synced := prResult.LocalHead == prResult.RemoteHead
		if synced {
			fmt.Printf("  Branch %s exists and is up to date with PR\n", ui.Cyan(prResult.Branch))
		} else {
			fmt.Printf("  Branch %s exists but is not up to date with PR\n", ui.Yellow(prResult.Branch))
			fmt.Printf("    Local:  %s\n", shortSHA(prResult.LocalHead))
			fmt.Printf("    PR:     %s\n", shortSHA(prResult.RemoteHead))
		}
		if !ui.Confirm("  Reuse this branch?") {
			fmt.Println("Aborted.")
			return nil
		}
		if err := gitutil.CreateWorktreeFromExistingBranch(repoRoot, prResult.Path, prResult.Branch); err != nil {
			return err
		}
		if !synced {
			offerPRSync(prResult)
		}
	}

	if err := gitutil.SetPRTracking(repoRoot, prResult.Branch, remote, number); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to set PR tracking branch: %v\n", err)
	} else {
		fmt.Printf("  %s Tracking PR head — git pull will fetch new PR commits\n", ui.Green("✓"))
	}

	prRes := &resources.Resource{
		Type: "pr",
		ID:   fmt.Sprintf("%s/%s#%d", owner, repo, number),
		URL:  pr.URL,
	}
	return finalizeWorktree(cfg, prResult.CreateResult, repoRoot, prRes, pr)
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
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	repoRoot, err := findRepoRoot()
	if err != nil {
		return fmt.Errorf("not in a git repo: %w", err)
	}

	offerPull(repoRoot)

	branchName := strings.ToLower(key)
	var result gitutil.CreateResult
	err = ui.SpinWhile(fmt.Sprintf("Creating worktree for %s", key), func() error {
		var createErr error
		result, createErr = gitutil.CreateBranchWorktree(repoRoot, cfg.WorktreesBase, branchName)
		return createErr
	})
	if err != nil {
		return err
	}

	if url == "" {
		url = jira.IssueURL(jiraHostFromWatcherConfig(), key)
	}

	return finalizeWorktree(cfg, result, repoRoot, &resources.Resource{
		Type: "jira",
		ID:   key,
		URL:  url,
	}, nil)
}

func handleBranch(branchName string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	repoRoot, err := findRepoRoot()
	if err != nil {
		return fmt.Errorf("not in a git repo: %w", err)
	}

	offerPull(repoRoot)

	var result gitutil.CreateResult
	err = ui.SpinWhile(fmt.Sprintf("Creating worktree for branch %s", branchName), func() error {
		var createErr error
		result, createErr = gitutil.CreateBranchWorktree(repoRoot, cfg.WorktreesBase, branchName)
		return createErr
	})
	if err != nil {
		return err
	}

	return finalizeWorktree(cfg, result, repoRoot, nil, nil)
}

func finalizeWorktree(cfg config.Config, result gitutil.CreateResult, repoRoot string, primaryResource *resources.Resource, pr *github.PRInfo) error {
	if result.Created {
		fmt.Printf("%s Created worktree at %s\n", ui.Green("✓"), ui.ShortPath(result.Path))
	} else {
		fmt.Printf("%s Reusing existing worktree at %s\n", ui.Yellow("→"), ui.ShortPath(result.Path))
	}

	repoName := filepath.Base(repoRoot)
	wtName := filepath.Base(result.Path)

	conn, err := wdb.Open()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to open worktree db: %v\n", err)
	}

	var alloc ports.Allocation
	if conn != nil {
		alloc, err = ports.Allocate(conn, wtName)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to allocate port range: %v\n", err)
		}
		if err := registry.Register(conn, buildRegistryEntry(result, repoRoot, time.Now().UTC().Format(time.RFC3339))); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to register worktree: %v\n", err)
		}
	}

	kubePath := env.KubeconfigPath(repoName, wtName)
	if err := env.SeedKubeconfig(kubePath); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to seed kubeconfig: %v\n", err)
	}

	if primaryResource != nil && conn != nil {
		if err := resources.Add(conn, result.Path, *primaryResource); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to save resource: %v\n", err)
		}
	}

	if len(cfg.Jira.Projects) > 0 && conn != nil {
		detectAndSaveJiraIssues(conn, cfg, result, pr)
	}

	if result.Created {
		offerDotfiles(repoRoot, result.Path)
	}

	fmt.Printf("\n  %s\n", ui.Dim("Environment (via eval \"$(worktree env)\"):"))
	fmt.Printf("    WORKTREE_PATH  = %s\n", ui.ShortPath(result.Path))
	fmt.Printf("    WORKTREE_TITLE = wt %s\n", result.Branch)
	fmt.Printf("    WORKTREE_PORTS = %s\n", alloc.Range())
	fmt.Printf("    KUBECONFIG     = %s\n\n", ui.ShortPath(kubePath))

	if cmux.IsAvailable() {
		defer func() {
			if conn != nil {
				conn.Close()
			}
		}()
		return openCmuxWorkspace(conn, cfg, result)
	}

	if conn != nil {
		conn.Close()
	}
	return nil
}

// buildRegistryEntry constructs a registry.Entry from a create result.
func buildRegistryEntry(result gitutil.CreateResult, repoRoot, nowRFC3339 string) registry.Entry {
	return registry.Entry{
		Path:      result.Path,
		Repo:      filepath.Base(repoRoot),
		RepoRoot:  repoRoot,
		Branch:    result.Branch,
		CreatedAt: nowRFC3339,
	}
}

func offerPRSync(pr gitutil.PRWorktreeResult) {
	if pr.LocalHead == "" || pr.RemoteHead == "" {
		return
	}

	if pr.LocalHead == pr.RemoteHead {
		fmt.Printf("  %s Already up to date with PR\n", ui.Green("✓"))
		return
	}

	fmt.Printf("  %s Local (%s) differs from PR latest (%s)\n",
		ui.Yellow("!"), shortSHA(pr.LocalHead), shortSHA(pr.RemoteHead))

	if ui.Confirm("  Reset to the PR's latest commit?") {
		if err := gitutil.ResetHard(pr.Path, pr.FetchRef); err != nil {
			fmt.Fprintf(os.Stderr, "  Warning: %v\n", err)
		} else {
			fmt.Printf("  %s Reset to %s\n", ui.Green("✓"), shortSHA(pr.RemoteHead))
		}
	}
}

func shortSHA(sha string) string {
	if len(sha) > 8 {
		return sha[:8]
	}
	return sha
}

// jiraHostFromWatcherConfig returns the Jira host configured in the shared
// watcher auth.yaml (wcfg.Services.Jira), or "" if Jira isn't configured
// there. worktree's own config.yaml no longer stores Jira credentials —
// only Projects (see internal/config.JiraConfig) — so building a Jira issue
// URL requires reading the host from the watcher config.
func jiraHostFromWatcherConfig() string {
	wcfg, err := wconfig.Load(wconfig.DefaultPath())
	if err != nil {
		return ""
	}
	creds, err := wcfg.Jira()
	if err != nil {
		return ""
	}
	return creds.Host
}

func detectAndSaveJiraIssues(conn *sql.DB, cfg config.Config, result gitutil.CreateResult, pr *github.PRInfo) {
	var prTitle, prBody string
	if pr != nil {
		prTitle = pr.Title
		prBody = pr.Body
	}

	existing, _ := resources.Load(conn, result.Path)
	existingKeys := make(map[string]bool)
	for _, r := range existing {
		if r.Type == "jira" {
			existingKeys[r.ID] = true
		}
	}

	keys := jira.DetectKeys(result.Branch, prTitle, prBody, cfg.Jira.Projects)
	host := jiraHostFromWatcherConfig()
	for _, key := range keys {
		if existingKeys[key] {
			continue
		}
		url := jira.IssueURL(host, key)
		r := resources.Resource{Type: "jira", ID: key, URL: url}
		if err := resources.Add(conn, result.Path, r); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to save Jira resource %s: %v\n", key, err)
		} else {
			fmt.Printf("  %s Detected Jira issue %s\n", ui.Green("✓"), ui.Cyan(key))
		}
	}
}

func openCmuxWorkspace(conn *sql.DB, cfg config.Config, result gitutil.CreateResult) error {
	existing, err := cmux.FindByDirectory(result.Path)
	if err == nil && existing != nil {
		fmt.Printf("%s Switching to existing cmux workspace %s\n", ui.Cyan("→"), existing.CustomTitle)
		return cmux.SelectWorkspace(existing.Ref)
	}

	var res []resources.Resource
	if conn != nil {
		res, _ = resources.Load(conn, result.Path)
	}
	uiURL := runningUIDetailURL(conn, result.Path)
	urls := buildWorkspaceURLs(res)

	defaultTitle := fmt.Sprintf("wt %s", result.Branch)
	fmt.Println()
	title := ui.PromptLineDefault("  Workspace name", defaultTitle)

	groupRef := promptCmuxGroup()
	color := promptCmuxColor()

	layout := cmux.BuildLayout(uiURL, urls)

	opts := cmux.NewWorkspaceOptions{
		Name:     title,
		Cwd:      result.Path,
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

func offerDotfiles(repoRoot, wtPath string) {
	dfs, err := dotfiles.Discover(repoRoot)
	if err != nil || len(dfs) == 0 {
		return
	}

	fmt.Printf("\nFound %d gitignored dotfiles in main worktree:\n", len(dfs))
	for _, df := range dfs {
		kind := "file"
		if df.IsDir {
			kind = "dir"
		}
		fmt.Printf("  %s %s\n", ui.Dim(kind), df.Name)
	}

	if !ui.Confirm("\nCopy these dotfiles to the new worktree?") {
		return
	}

	ui.SpinWhile("Copying dotfiles", func() error {
		for _, df := range dfs {
			if err := dotfiles.Copy(df.Path, wtPath, df); err != nil {
				fmt.Fprintf(os.Stderr, "\n  Warning: failed to copy %s: %v", df.Name, err)
			}
		}
		return nil
	})
}

func offerPull(repoRoot string) {
	if ui.ConfirmDefault("git pull before creating worktree?", true) {
		ui.SpinWhile("Pulling", func() error {
			return gitutil.Pull(repoRoot)
		})
	}
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
