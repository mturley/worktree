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

	repoRoot, err := findRepoRoot()
	if err != nil {
		return fmt.Errorf("not in a git repo: %w", err)
	}

	slug := github.Slugify(pr.Title)
	result, err := gitutil.CreatePRWorktree(repoRoot, cfg.WorktreesBase, number, pr.HeadRef, slug)
	if err != nil {
		return err
	}

	return finalizeWorktree(cfg, result, repoRoot, &resources.Resource{
		Type: "pr",
		ID:   fmt.Sprintf("%s/%s#%d", owner, repo, number),
		URL:  pr.URL,
	})
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
	})
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

	return finalizeWorktree(cfg, result, repoRoot, nil)
}

func finalizeWorktree(cfg config.Config, result gitutil.CreateResult, repoRoot string, prResource *resources.Resource) error {
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

	if prResource != nil {
		if err := resources.Add(result.Path, *prResource); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to save PR resource: %v\n", err)
		}
	}

	if result.Created {
		offerDotfiles(repoRoot, result.Path)
	}

	fmt.Printf("\n  Ports:    %s\n", alloc.Range())
	fmt.Printf("  Kube:     %s\n", ui.ShortPath(kubePath))
	fmt.Printf("\n  cd %s\n\n", ui.ShortPath(result.Path))

	if cmux.IsAvailable() {
		return openCmuxWorkspace(cfg, result, prResource)
	}
	return nil
}

func openCmuxWorkspace(cfg config.Config, result gitutil.CreateResult, primaryResource *resources.Resource) error {
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
