package cmd

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resourceurl"
	"github.com/mturley/worktree/internal/tasks"
	"github.com/spf13/cobra"
)

// actorFromEnv decides who a CLI invocation acts as. An agent is anything
// running under Claude Code (CLAUDECODE), under agent-handler
// (HANDLER_SESSION_ID, which is also the session), or passing --as-agent.
func actorFromEnv(asAgent bool, getenv func(string) string) tasks.Actor {
	session := getenv("HANDLER_SESSION_ID")
	if asAgent || session != "" || getenv("CLAUDECODE") != "" {
		return tasks.Actor{Kind: tasks.ActorAgent, Session: session}
	}
	return tasks.Actor{Kind: tasks.ActorUser}
}

// parseTaskID accepts "T42", "t42" or "42".
func parseTaskID(s string) (int64, error) {
	digits := strings.TrimPrefix(strings.TrimPrefix(s, "T"), "t")
	if digits == "" || strings.TrimLeft(digits, "0123456789") != "" {
		return 0, fmt.Errorf("invalid task id %q: want T<n> or <n>", s)
	}
	n, err := strconv.ParseInt(digits, 10, 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("invalid task id %q: want T<n> or <n>", s)
	}
	return n, nil
}

func formatTaskID(id int64) string { return "T" + strconv.FormatInt(id, 10) }

// parseLinkRef parses what a link points at: a URL, "<type>:<id>" (split on
// the FIRST ':' only, because Slack ids contain ':'), "wt:<path>", or "."
// for the current worktree.
func parseLinkRef(s string) (tasks.LinkTarget, error) {
	if s == "." {
		p, ok, err := currentWorktree()
		if err != nil {
			return tasks.LinkTarget{}, err
		}
		if !ok {
			return tasks.LinkTarget{}, fmt.Errorf("\".\" is not inside a registered worktree")
		}
		return tasks.LinkTarget{Kind: tasks.LinkWorktree, Worktree: p}, nil
	}
	if strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://") {
		typ, id, ok := resourceurl.InferAny(s)
		if !ok {
			return tasks.LinkTarget{}, fmt.Errorf("unrecognised URL %q", s)
		}
		return tasks.LinkTarget{Kind: tasks.LinkResource, ResourceType: typ, ResourceID: id}, nil
	}
	typ, rest, found := strings.Cut(s, ":")
	if !found || typ == "" || rest == "" {
		return tasks.LinkTarget{}, fmt.Errorf("invalid link %q: want a URL, <type>:<id>, wt:<path> or .", s)
	}
	if typ == "wt" {
		return tasks.LinkTarget{Kind: tasks.LinkWorktree, Worktree: rest}, nil
	}
	return tasks.LinkTarget{Kind: tasks.LinkResource, ResourceType: typ, ResourceID: rest}, nil
}

// canonicalWorktree is the canonical form wdb.Subscriber keys worktrees by.
func canonicalWorktree(p string) string {
	c, _ := wdb.WorktreePathFromSubscriber(wdb.Subscriber(p))
	return c
}

// currentWorktree returns the canonical path of the registered worktree
// containing the cwd, or ok=false when the cwd is not in one.
func currentWorktree() (string, bool, error) {
	p, err := resolveWorktreePath(nil)
	if err != nil {
		return "", false, err
	}
	conn, err := wdb.Open()
	if err != nil {
		return "", false, err
	}
	defer conn.Close()
	return registeredWorktree(conn, p)
}

func registeredWorktree(conn *sql.DB, p string) (string, bool, error) {
	want := canonicalWorktree(p)
	entries, err := registry.List(conn)
	if err != nil {
		return "", false, err
	}
	for _, e := range entries {
		if canonicalWorktree(e.Path) == want {
			return want, true, nil
		}
	}
	return "", false, nil
}

var (
	tasksJSON        bool
	tasksAsAgent     bool
	tasksAll         bool
	tasksWorktree    string
	tasksResource    string
	tasksCompleted   bool
	tasksArchived    bool
	tasksPriorities  []string
	tasksStarredOnly bool

	tasksPriority    string
	tasksStar        bool
	tasksDue         string
	tasksDescription string
	tasksTitle       string
	tasksFocus       []string
	tasksRelated     []string
	tasksGlobal      bool
)

var tasksCmd = &cobra.Command{
	Use:     "tasks",
	Short:   "Manage tasks (to-dos linked to worktrees and resources)",
	GroupID: "worktree",
}

var tasksListCmd = &cobra.Command{
	Use:   "list",
	Short: "List open tasks (default: the current worktree's, else all)",
	Args:  cobra.NoArgs,
	RunE:  runTasksList,
}

var tasksShowCmd = &cobra.Command{
	Use:   "show <id>",
	Short: "Show a task with its links, subtasks and recent history",
	Args:  cobra.ExactArgs(1),
	RunE:  runTasksShow,
}

var tasksAddCmd = &cobra.Command{
	Use:   "add <title>",
	Short: "Create a task",
	Long: "Create a task. With no --focus, --related or --global, a task created " +
		"inside a registered worktree gets that worktree as a Focus link.",
	Args: cobra.ExactArgs(1),
	RunE: runTasksAdd,
}

var tasksEditCmd = &cobra.Command{
	Use:   "edit <id>",
	Short: "Edit a task's title, description, priority or due date",
	Args:  cobra.ExactArgs(1),
	RunE:  runTasksEdit,
}

var tasksStateCmd = &cobra.Command{
	Use:   "state <id> <not_started|in_progress|done>",
	Short: "Set a task's state",
	Args:  cobra.ExactArgs(2),
	RunE:  runTasksState,
}

var tasksStarCmd = &cobra.Command{
	Use:   "star <id>",
	Short: "Star a task",
	Args:  cobra.ExactArgs(1),
	RunE:  func(cmd *cobra.Command, args []string) error { return runTasksSetStar(cmd, args, true) },
}

var tasksUnstarCmd = &cobra.Command{
	Use:   "unstar <id>",
	Short: "Unstar a task",
	Args:  cobra.ExactArgs(1),
	RunE:  func(cmd *cobra.Command, args []string) error { return runTasksSetStar(cmd, args, false) },
}

var tasksDeleteCmd = &cobra.Command{
	Use:   "delete <id>",
	Short: "Delete a task",
	Args:  cobra.ExactArgs(1),
	RunE:  runTasksDelete,
}

func init() {
	tasksCmd.PersistentFlags().BoolVar(&tasksAsAgent, "as-agent", false, "record changes as made by an agent")
	for _, c := range []*cobra.Command{tasksListCmd, tasksShowCmd, tasksAddCmd, tasksEditCmd,
		tasksStateCmd, tasksStarCmd, tasksUnstarCmd, tasksDeleteCmd} {
		c.Flags().BoolVar(&tasksJSON, "json", false, "machine-readable JSON output")
	}

	lf := tasksListCmd.Flags()
	lf.BoolVar(&tasksAll, "all", false, "list tasks from everywhere")
	lf.StringVar(&tasksWorktree, "worktree", "", "list tasks for this worktree path")
	lf.StringVar(&tasksResource, "resource", "", "list tasks for this resource (URL or <type>:<id>)")
	lf.BoolVar(&tasksCompleted, "completed", false, "include done tasks")
	lf.BoolVar(&tasksArchived, "archived", false, "include archived tasks")
	lf.StringArrayVar(&tasksPriorities, "priority", nil, "only this priority (repeatable)")
	lf.BoolVar(&tasksStarredOnly, "starred", false, "only starred tasks")

	af := tasksAddCmd.Flags()
	af.StringVar(&tasksPriority, "priority", "", "high, medium, low or none")
	af.BoolVar(&tasksStar, "star", false, "star the task")
	af.StringVar(&tasksDue, "due", "", "due date, YYYY-MM-DD")
	af.StringVar(&tasksDescription, "description", "", "description")
	af.StringArrayVar(&tasksFocus, "focus", nil, "Focus link: URL, <type>:<id>, wt:<path> or . (repeatable)")
	af.StringArrayVar(&tasksRelated, "related", nil, "Related link: URL, <type>:<id>, wt:<path> or . (repeatable)")
	af.BoolVar(&tasksGlobal, "global", false, "do not link the current worktree")

	ef := tasksEditCmd.Flags()
	ef.StringVar(&tasksTitle, "title", "", "new title")
	ef.StringVar(&tasksDescription, "description", "", "new description")
	ef.StringVar(&tasksPriority, "priority", "", "high, medium, low or none")
	ef.StringVar(&tasksDue, "due", "", "due date, YYYY-MM-DD (\"\" clears)")

	tasksCmd.AddCommand(tasksListCmd, tasksShowCmd, tasksAddCmd, tasksEditCmd,
		tasksStateCmd, tasksStarCmd, tasksUnstarCmd, tasksDeleteCmd)
	rootCmd.AddCommand(tasksCmd)
}

func tasksActor() tasks.Actor { return actorFromEnv(tasksAsAgent, os.Getenv) }

// taskErr turns the tasks package's sentinel errors into CLI messages.
func taskErr(id int64, err error) error {
	if errors.Is(err, tasks.ErrNotFound) {
		return fmt.Errorf("task %s not found", formatTaskID(id))
	}
	return err
}

// printTask prints one task as JSON or as its list line.
func printTask(cmd *cobra.Command, t tasks.Task) error {
	if tasksJSON {
		return writeJSON(cmd.OutOrStdout(), toTaskJSON(t))
	}
	fmt.Fprintln(cmd.OutOrStdout(), taskLine(t))
	return nil
}

// listScope resolves list's scope flags. With none, it is the current
// worktree when the cwd is in a registered one, otherwise everything.
func listScope(conn *sql.DB) (tasks.Scope, error) {
	set := 0
	for _, b := range []bool{tasksAll, tasksWorktree != "", tasksResource != ""} {
		if b {
			set++
		}
	}
	if set > 1 {
		return tasks.Scope{}, fmt.Errorf("--all, --worktree and --resource are mutually exclusive")
	}
	switch {
	case tasksAll:
		return tasks.Scope{Kind: tasks.ScopeAll}, nil
	case tasksWorktree != "":
		return tasks.Scope{Kind: tasks.ScopeWorktree, Worktree: tasksWorktree}, nil
	case tasksResource != "":
		t, err := parseLinkRef(tasksResource)
		if err != nil {
			return tasks.Scope{}, err
		}
		if t.Kind == tasks.LinkWorktree {
			return tasks.Scope{Kind: tasks.ScopeWorktree, Worktree: t.Worktree}, nil
		}
		return tasks.Scope{Kind: tasks.ScopeResource, ResourceType: t.ResourceType, ResourceID: t.ResourceID}, nil
	}
	p, err := resolveWorktreePath(nil)
	if err != nil {
		return tasks.Scope{}, err
	}
	wt, ok, err := registeredWorktree(conn, p)
	if err != nil {
		return tasks.Scope{}, err
	}
	if ok {
		return tasks.Scope{Kind: tasks.ScopeWorktree, Worktree: wt}, nil
	}
	return tasks.Scope{Kind: tasks.ScopeAll}, nil
}

func runTasksList(cmd *cobra.Command, args []string) error {
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	scope, err := listScope(conn)
	if err != nil {
		return err
	}
	f := tasks.Filter{
		Scope: scope, IncludeCompleted: tasksCompleted, IncludeArchived: tasksArchived,
		StarredOnly: tasksStarredOnly,
	}
	for _, p := range tasksPriorities {
		f.Priorities = append(f.Priorities, tasks.Priority(p))
	}
	ts, err := tasks.List(conn, f)
	if err != nil {
		return err
	}
	out := cmd.OutOrStdout()
	if tasksJSON {
		rows := make([]taskJSON, 0, len(ts))
		for _, t := range ts {
			rows = append(rows, toTaskJSON(t))
		}
		return writeJSON(out, rows)
	}
	for _, t := range ts {
		fmt.Fprintln(out, taskLine(t))
	}
	return nil
}

const showEventLimit = 20

func runTasksShow(cmd *cobra.Command, args []string) error {
	id, err := parseTaskID(args[0])
	if err != nil {
		return err
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	t, err := tasks.Get(conn, id)
	if err != nil {
		return taskErr(id, err)
	}
	events, err := tasks.Events(conn, id)
	if err != nil {
		return err
	}
	if len(events) > showEventLimit {
		events = events[:showEventLimit]
	}
	if tasksJSON {
		j := toTaskJSON(t)
		j.Events = toEventsJSON(events)
		return writeJSON(cmd.OutOrStdout(), j)
	}
	writeTaskDetail(cmd.OutOrStdout(), t, events)
	return nil
}

func runTasksAdd(cmd *cobra.Command, args []string) error {
	n := tasks.NewTask{
		Title: args[0], Description: tasksDescription, Priority: tasks.Priority(tasksPriority),
		Starred: tasksStar, Due: tasksDue,
	}
	var related []tasks.LinkTarget
	for _, r := range tasksFocus {
		t, err := parseLinkRef(r)
		if err != nil {
			return err
		}
		n.Focus = append(n.Focus, t)
	}
	for _, r := range tasksRelated {
		t, err := parseLinkRef(r)
		if err != nil {
			return err
		}
		related = append(related, t)
	}

	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()

	if !tasksGlobal && len(n.Focus) == 0 && len(related) == 0 {
		p, err := resolveWorktreePath(nil)
		if err != nil {
			return err
		}
		wt, ok, err := registeredWorktree(conn, p)
		if err != nil {
			return err
		}
		if ok {
			n.Focus = []tasks.LinkTarget{{Kind: tasks.LinkWorktree, Worktree: wt}}
		}
	}

	a := tasksActor()
	t, err := tasks.Create(conn, a, n)
	if err != nil {
		return err
	}
	for _, r := range related {
		if _, err := tasks.AddLink(conn, a, t.ID, r, false); err != nil {
			return fmt.Errorf("created %s, but linking %s failed: %w", formatTaskID(t.ID), linkLabel(r), err)
		}
	}
	if len(related) > 0 {
		if t, err = tasks.Get(conn, t.ID); err != nil {
			return err
		}
	}
	if tasksJSON {
		return writeJSON(cmd.OutOrStdout(), toTaskJSON(t))
	}
	fmt.Fprintln(cmd.OutOrStdout(), formatTaskID(t.ID))
	return nil
}

func runTasksEdit(cmd *cobra.Command, args []string) error {
	id, err := parseTaskID(args[0])
	if err != nil {
		return err
	}
	var p tasks.Patch
	fl := cmd.Flags()
	if fl.Changed("title") {
		p.Title = &tasksTitle
	}
	if fl.Changed("description") {
		p.Description = &tasksDescription
	}
	if fl.Changed("priority") {
		pr := tasks.Priority(tasksPriority)
		p.Priority = &pr
	}
	if fl.Changed("due") {
		p.Due = &tasksDue
	}
	if p == (tasks.Patch{}) {
		return fmt.Errorf("nothing to edit: pass --title, --description, --priority or --due")
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	t, err := tasks.Update(conn, tasksActor(), id, p)
	if err != nil {
		return taskErr(id, err)
	}
	return printTask(cmd, t)
}

func runTasksState(cmd *cobra.Command, args []string) error {
	id, err := parseTaskID(args[0])
	if err != nil {
		return err
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := tasks.SetState(conn, tasksActor(), id, tasks.State(args[1])); err != nil {
		return taskErr(id, err)
	}
	t, err := tasks.Get(conn, id)
	if err != nil {
		return taskErr(id, err)
	}
	return printTask(cmd, t)
}

func runTasksSetStar(cmd *cobra.Command, args []string, starred bool) error {
	id, err := parseTaskID(args[0])
	if err != nil {
		return err
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	t, err := tasks.Update(conn, tasksActor(), id, tasks.Patch{Starred: &starred})
	if err != nil {
		return taskErr(id, err)
	}
	return printTask(cmd, t)
}

func runTasksDelete(cmd *cobra.Command, args []string) error {
	id, err := parseTaskID(args[0])
	if err != nil {
		return err
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	if err := tasks.Delete(conn, tasksActor(), id); err != nil {
		return taskErr(id, err)
	}
	if tasksJSON {
		return writeJSON(cmd.OutOrStdout(), map[string]any{"id": formatTaskID(id), "deleted": true})
	}
	fmt.Fprintf(cmd.OutOrStdout(), "deleted %s\n", formatTaskID(id))
	return nil
}
