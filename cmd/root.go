package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/dotfiles"
	"github.com/mturley/worktree/internal/env"
	"github.com/mturley/worktree/internal/github"
	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/jira"
	"github.com/mturley/worktree/internal/ports"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/ui"
	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "worktree [PR-number | PR-URL | branch-name | path]",
	Short: "CLI for managing git worktrees",
	Long:  "CLI for managing git worktrees with GitHub/Jira integration and optional cmux support.",
	Args:  cobra.MaximumNArgs(1),
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

var prURLPattern = regexp.MustCompile(`github\.com/([^/]+)/([^/]+)/pull/(\d+)`)

func runRoot(cmd *cobra.Command, args []string) error {
	if len(args) == 0 {
		return runList(cmd, args)
	}

	arg := args[0]

	if m := prURLPattern.FindStringSubmatch(arg); m != nil {
		owner, repo := m[1], m[2]
		number, _ := strconv.Atoi(m[3])
		return handlePR(owner, repo, number)
	}

	if jira.IsJiraURL(arg) {
		return handleJiraURL(arg)
	}

	if _, err := strconv.Atoi(arg); err == nil {
		return handlePRNumber(arg)
	}

	if info, err := os.Stat(arg); err == nil && info.IsDir() {
		if _, err := os.Stat(filepath.Join(arg, ".git")); err == nil {
			return runInfo(cmd, args)
		}
		gitFile := filepath.Join(arg, ".git")
		if data, err := os.ReadFile(gitFile); err == nil && strings.HasPrefix(string(data), "gitdir:") {
			return runInfo(cmd, args)
		}
	}

	return handleBranch(arg)
}

func handlePR(owner, repo string, number int) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	fmt.Printf("Fetching PR #%d from %s/%s...\n", number, owner, repo)
	pr, err := github.FetchPRByRepo(owner, repo, number)
	if err != nil {
		return fmt.Errorf("fetching PR: %w", err)
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
	prResult, err := gitutil.CreatePRWorktree(repoRoot, cfg.WorktreesBase, remote, number, pr.HeadRef, slug)
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

	branchName := strings.ToLower(key)
	fmt.Printf("Creating worktree for Jira issue %s...\n", ui.Cyan(key))

	result, err := gitutil.CreateBranchWorktree(repoRoot, cfg.WorktreesBase, branchName)
	if err != nil {
		return err
	}

	if url == "" {
		url = jira.IssueURL(cfg.Jira.Host, key)
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

	fmt.Printf("Creating worktree for branch %s...\n", ui.Cyan(branchName))
	result, err := gitutil.CreateBranchWorktree(repoRoot, cfg.WorktreesBase, branchName)
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

	alloc, err := ports.Allocate(cfg.WorktreesBase, wtName)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to allocate port range: %v\n", err)
	}

	kubePath := env.KubeconfigPath(repoName, wtName)
	if err := env.SeedKubeconfig(kubePath); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to seed kubeconfig: %v\n", err)
	}

	we := env.WorktreeEnv{
		Ports: alloc.Range(),
		Title: fmt.Sprintf("wt %s", result.Branch),
		Path:  result.Path,
		Kube:  kubePath,
	}
	if err := env.Generate(result.Path, we); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to generate .worktree-env: %v\n", err)
	}

	if err := gitutil.AddExcludes(repoRoot); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to update git excludes: %v\n", err)
	}

	if primaryResource != nil {
		if err := resources.Add(result.Path, *primaryResource); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to save resource: %v\n", err)
		}
	}

	if len(cfg.Jira.Projects) > 0 {
		detectAndSaveJiraIssues(cfg, result, pr)
	}

	if result.Created {
		offerDotfiles(repoRoot, result.Path)
	}

	fmt.Printf("\n  Ports:    %s\n", alloc.Range())
	fmt.Printf("  Kube:     %s\n", ui.ShortPath(kubePath))
	fmt.Printf("\n  cd %s\n\n", ui.ShortPath(result.Path))

	if cmux.IsAvailable() {
		return openCmuxWorkspace(cfg, result)
	}
	return nil
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

func detectAndSaveJiraIssues(cfg config.Config, result gitutil.CreateResult, pr *github.PRInfo) {
	var prTitle, prBody string
	if pr != nil {
		prTitle = pr.Title
		prBody = pr.Body
	}

	existing, _ := resources.Load(result.Path)
	existingKeys := make(map[string]bool)
	for _, r := range existing {
		if r.Type == "jira" {
			existingKeys[r.ID] = true
		}
	}

	keys := jira.DetectKeys(result.Branch, prTitle, prBody, cfg.Jira.Projects)
	for _, key := range keys {
		if existingKeys[key] {
			continue
		}
		url := jira.IssueURL(cfg.Jira.Host, key)
		r := resources.Resource{Type: "jira", ID: key, URL: url}
		if err := resources.Add(result.Path, r); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to save Jira resource %s: %v\n", key, err)
		} else {
			fmt.Printf("  %s Detected Jira issue %s\n", ui.Green("✓"), ui.Cyan(key))
		}
	}
}

func openCmuxWorkspace(cfg config.Config, result gitutil.CreateResult) error {
	existing, err := cmux.FindByDirectory(result.Path)
	if err == nil && existing != nil {
		fmt.Printf("%s Switching to existing cmux workspace %s\n", ui.Cyan("→"), existing.CustomTitle)
		return cmux.SelectWorkspace(existing.Ref)
	}

	var urls []string
	res, _ := resources.Load(result.Path)
	for _, r := range res {
		if !r.Related && r.URL != "" {
			urls = append(urls, r.URL)
		}
	}

	title := fmt.Sprintf("wt %s", result.Branch)

	var paneConfigs []cmux.PaneConfig
	for _, p := range cfg.Cmux.Layout.Panes {
		paneConfigs = append(paneConfigs, cmux.PaneConfig{
			Role:     p.Role,
			Position: p.Position,
			Size:     p.Size,
		})
	}

	layout := cmux.BuildLayout(paneConfigs, urls)

	opts := cmux.NewWorkspaceOptions{
		Name:  title,
		Cwd:   result.Path,
		Focus: true,
	}
	if layout != "" {
		opts.Layout = layout
	}

	ref, err := cmux.NewWorkspace(opts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to create cmux workspace: %v\n", err)
		return nil
	}
	fmt.Printf("%s Created cmux workspace %s\n", ui.Green("✓"), ref)
	return nil
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

	for _, df := range dfs {
		if err := dotfiles.Copy(df.Path, wtPath, df); err != nil {
			fmt.Fprintf(os.Stderr, "  Warning: failed to copy %s: %v\n", df.Name, err)
		} else {
			fmt.Printf("  %s %s\n", ui.Green("✓"), df.Name)
		}
	}
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

	// Search across configured roots
	fmt.Printf("Searching for local clone of %s/%s...\n", owner, repo)
	root, err := gitutil.FindRepoBySlug(owner, repo, cfg.Search.Roots, cfg.Search.Depth, cfg.Search.Prune)
	if err != nil {
		return "", fmt.Errorf("cannot find local clone of %s/%s — run this command from inside the repo, or add its parent to search.roots in config", owner, repo)
	}
	fmt.Printf("  Found: %s\n", ui.ShortPath(root))
	return root, nil
}
