package cmd

import (
	"database/sql"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/tasks"
	"github.com/spf13/cobra"
)

// The blocker commands: thin wrappers over internal/tasks. A write here
// resolves task blockers at once, as every tasks write does; resource
// blockers wait for `worktree ui`'s next pass (only it looks PRs and Jira
// issues up).

var (
	tasksBlockTask     string
	tasksBlockResource string
	tasksBlockOther    string
	tasksUnresolve     bool
)

var tasksBlockCmd = &cobra.Command{
	Use:   "block <id> (--task <id> | --resource <ref> | --other <text>)",
	Short: "Add a blocker to a task (prints the blocker's id)",
	Long: "Add a blocker to a task: another task (--task), a resource (--resource: a URL " +
		"or <type>:<id>) or free text (--other). The task is blocked while any blocker " +
		"is unresolved. A task blocker resolves when its task is done; a PR or Jira " +
		"blocker resolves when `worktree ui` sees it merged, closed or done; Slack, " +
		"link and free-text blockers are resolved by hand (tasks resolve).",
	Args: cobra.ExactArgs(1),
	RunE: runTasksBlock,
}

var tasksUnblockCmd = &cobra.Command{
	Use:   "unblock <blocker-id>",
	Short: "Remove a blocker",
	Args:  cobra.ExactArgs(1),
	RunE:  runTasksUnblock,
}

var tasksResolveCmd = &cobra.Command{
	Use:   "resolve <blocker-id>",
	Short: "Resolve a Slack, link or free-text blocker by hand (--unresolve to undo)",
	Args:  cobra.ExactArgs(1),
	RunE:  runTasksResolve,
}

func init() {
	for _, c := range []*cobra.Command{tasksBlockCmd, tasksUnblockCmd, tasksResolveCmd} {
		c.Flags().BoolVar(&tasksJSON, "json", false, "machine-readable JSON output")
	}
	bf := tasksBlockCmd.Flags()
	bf.StringVar(&tasksBlockTask, "task", "", "blocked by this task")
	bf.StringVar(&tasksBlockResource, "resource", "", "blocked by this resource: URL or <type>:<id>")
	bf.StringVar(&tasksBlockOther, "other", "", "blocked by this, as free text")
	tasksResolveCmd.Flags().BoolVar(&tasksUnresolve, "unresolve", false, "mark the blocker unresolved again")
	tasksCmd.AddCommand(tasksBlockCmd, tasksUnblockCmd, tasksResolveCmd)
}

func parseBlockerID(s string) (int64, error) {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("invalid blocker id %q: want a positive integer", s)
	}
	return n, nil
}

// blockerErr reports a missing blocker as such.
func blockerErr(id int64, err error) error {
	if errors.Is(err, tasks.ErrBlockerNotFound) {
		return fmt.Errorf("blocker %d not found", id)
	}
	return err
}

// blockTarget turns block's flags into a BlockerTarget.
func blockTarget(cmd *cobra.Command) (tasks.BlockerTarget, error) {
	fl := cmd.Flags()
	set := 0
	for _, f := range []string{"task", "resource", "other"} {
		if fl.Changed(f) {
			set++
		}
	}
	if set != 1 {
		return tasks.BlockerTarget{}, fmt.Errorf("pass exactly one of --task, --resource or --other")
	}
	switch {
	case fl.Changed("task"):
		id, err := parseTaskID(tasksBlockTask)
		if err != nil {
			return tasks.BlockerTarget{}, err
		}
		return tasks.BlockerTarget{Kind: tasks.BlockerTask, BlockingTaskID: id}, nil
	case fl.Changed("resource"):
		ref := strings.TrimSpace(tasksBlockResource)
		lt, err := parseLinkRef(ref)
		if err != nil {
			return tasks.BlockerTarget{}, err
		}
		if lt.Kind != tasks.LinkResource {
			return tasks.BlockerTarget{}, fmt.Errorf("a blocker's resource must be a URL or <type>:<id>, not a worktree")
		}
		bt := tasks.BlockerTarget{Kind: tasks.BlockerResource, ResourceType: lt.ResourceType, ResourceID: lt.ResourceID}
		if strings.HasPrefix(ref, "http://") || strings.HasPrefix(ref, "https://") {
			bt.URL = ref // kept for the resource's hold
		}
		return bt, nil
	}
	return tasks.BlockerTarget{Kind: tasks.BlockerOther, Text: tasksBlockOther}, nil
}

func runTasksBlock(cmd *cobra.Command, args []string) error {
	id, err := parseTaskID(args[0])
	if err != nil {
		return err
	}
	bt, err := blockTarget(cmd)
	if err != nil {
		return err
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	b, err := tasks.AddBlocker(conn, tasksActor(), id, bt)
	if err != nil {
		if errors.Is(err, tasks.ErrNotFound) {
			return taskErr(id, err)
		}
		return err
	}
	if tasksJSON {
		heads, err := blockerHeads(conn, []tasks.Blocker{b})
		if err != nil {
			return err
		}
		return writeJSON(cmd.OutOrStdout(), toBlockerJSON(b, heads))
	}
	fmt.Fprintln(cmd.OutOrStdout(), b.ID)
	return nil
}

func runTasksUnblock(cmd *cobra.Command, args []string) error {
	bid, err := parseBlockerID(args[0])
	if err != nil {
		return err
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	if err := tasks.RemoveBlocker(conn, tasksActor(), bid); err != nil {
		return blockerErr(bid, err)
	}
	if tasksJSON {
		return writeJSON(cmd.OutOrStdout(), map[string]any{"id": bid, "removed": true})
	}
	fmt.Fprintf(cmd.OutOrStdout(), "removed blocker %d\n", bid)
	return nil
}

func runTasksResolve(cmd *cobra.Command, args []string) error {
	bid, err := parseBlockerID(args[0])
	if err != nil {
		return err
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	resolved := !tasksUnresolve
	if err := tasks.SetBlockerResolved(conn, tasksActor(), bid, resolved); err != nil {
		return blockerErr(bid, err)
	}
	if tasksJSON {
		return writeJSON(cmd.OutOrStdout(), map[string]any{"id": bid, "resolved": resolved})
	}
	if resolved {
		fmt.Fprintf(cmd.OutOrStdout(), "resolved blocker %d\n", bid)
	} else {
		fmt.Fprintf(cmd.OutOrStdout(), "unresolved blocker %d\n", bid)
	}
	return nil
}

// blockerJSON is one of a task's blockers in `tasks show --json` and
// `tasks block --json`. Only the target fields its kind uses are set;
// task_id is the BLOCKING task.
type blockerJSON struct {
	ID               int64  `json:"id"`
	Kind             string `json:"kind"`
	Label            string `json:"label"`
	Resolved         bool   `json:"resolved"`
	ResolvedAuto     bool   `json:"resolved_auto"`
	ResolvedReason   string `json:"resolved_reason"`
	ResolvedAt       string `json:"resolved_at,omitempty"`
	ManualResolvable bool   `json:"manual_resolvable"`
	TaskID           string `json:"task_id,omitempty"`
	ResourceType     string `json:"resource_type,omitempty"`
	ResourceID       string `json:"resource_id,omitempty"`
	URL              string `json:"url,omitempty"`
	Text             string `json:"text,omitempty"`
	CreatedAt        string `json:"created_at"`
}

// blocksJSON is a task this one blocks.
type blocksJSON struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	State string `json:"state"`
}

// blockerHeads loads the blocking tasks of bs, deleted ones included.
func blockerHeads(conn *sql.DB, bs []tasks.Blocker) (map[int64]tasks.Head, error) {
	var ids []int64
	for _, b := range bs {
		if b.Kind == tasks.BlockerTask {
			ids = append(ids, b.BlockingTaskID)
		}
	}
	return tasks.Heads(conn, ids)
}

// cliBlockerLabel names a blocker as its events do: "T<id> <title>" for a
// task, "type:id" for a resource, the text for other.
func cliBlockerLabel(b tasks.Blocker, heads map[int64]tasks.Head) string {
	switch b.Kind {
	case tasks.BlockerTask:
		if h, ok := heads[b.BlockingTaskID]; ok {
			return formatTaskID(b.BlockingTaskID) + " " + h.Title
		}
		return formatTaskID(b.BlockingTaskID)
	case tasks.BlockerResource:
		return b.ResourceType + ":" + b.ResourceID
	}
	return b.Text
}

func toBlockerJSON(b tasks.Blocker, heads map[int64]tasks.Head) blockerJSON {
	j := blockerJSON{
		ID: b.ID, Kind: b.Kind, Label: cliBlockerLabel(b, heads),
		Resolved: b.ResolvedAt != "", ResolvedAuto: b.ResolvedAuto, ResolvedReason: b.ResolvedReason,
		ResolvedAt: b.ResolvedAt, ManualResolvable: tasks.ManuallyResolvable(b.BlockerTarget),
		ResourceType: b.ResourceType, ResourceID: b.ResourceID, URL: b.URL, Text: b.Text,
		CreatedAt: b.CreatedAt,
	}
	if b.Kind == tasks.BlockerTask {
		j.TaskID = formatTaskID(b.BlockingTaskID)
	}
	return j
}

// allBlockerLabels maps every blocked task to its unresolved blockers'
// labels, oldest first, for a listing.
func allBlockerLabels(conn *sql.DB) (map[int64][]string, error) {
	byTask, err := tasks.UnresolvedBlockers(conn)
	if err != nil {
		return nil, err
	}
	var all []tasks.Blocker
	for _, bs := range byTask {
		all = append(all, bs...)
	}
	heads, err := blockerHeads(conn, all)
	if err != nil {
		return nil, err
	}
	out := make(map[int64][]string, len(byTask))
	for id, bs := range byTask {
		for _, b := range bs {
			out[id] = append(out[id], cliBlockerLabel(b, heads))
		}
	}
	return out, nil
}

// withBlockerLabels is toTaskJSON with blocker_labels filled from labels
// (a done task, never blocked, names none).
func withBlockerLabels(t tasks.Task, labels map[int64][]string) taskJSON {
	j := toTaskJSON(t)
	if t.Blocked {
		j.BlockerLabels = append(j.BlockerLabels, labels[t.ID]...)
	}
	return j
}

// taskJSONFor is one task's JSON with its blocker labels.
func taskJSONFor(conn *sql.DB, t tasks.Task) (taskJSON, error) {
	if !t.Blocked {
		return toTaskJSON(t), nil
	}
	bs, err := tasks.Blockers(conn, t.ID)
	if err != nil {
		return taskJSON{}, err
	}
	heads, err := blockerHeads(conn, bs)
	if err != nil {
		return taskJSON{}, err
	}
	labels := map[int64][]string{}
	for _, b := range bs {
		if b.ResolvedAt == "" {
			labels[t.ID] = append(labels[t.ID], cliBlockerLabel(b, heads))
		}
	}
	return withBlockerLabels(t, labels), nil
}

// showBlockers is what `tasks show` adds: the task's blockers (unresolved
// first) and the tasks it blocks.
type showBlockers struct {
	blockers []tasks.Blocker
	heads    map[int64]tasks.Head
	blocks   []blocksJSON
}

func loadShowBlockers(conn *sql.DB, id int64) (showBlockers, error) {
	var sb showBlockers
	var err error
	if sb.blockers, err = tasks.Blockers(conn, id); err != nil {
		return sb, err
	}
	if sb.heads, err = blockerHeads(conn, sb.blockers); err != nil {
		return sb, err
	}
	ids, err := tasks.Blocking(conn, id)
	if err != nil {
		return sb, err
	}
	heads, err := tasks.Heads(conn, ids)
	if err != nil {
		return sb, err
	}
	sb.blocks = make([]blocksJSON, 0, len(ids))
	for _, bid := range ids {
		h := heads[bid]
		sb.blocks = append(sb.blocks, blocksJSON{ID: formatTaskID(bid), Title: h.Title, State: string(h.State)})
	}
	return sb, nil
}

func (sb showBlockers) json() []blockerJSON {
	out := make([]blockerJSON, 0, len(sb.blockers))
	for _, b := range sb.blockers {
		out = append(out, toBlockerJSON(b, sb.heads))
	}
	return out
}

// write renders the "Blocked by" and "Blocks" sections of `tasks show`.
func (sb showBlockers) write(w io.Writer) {
	if len(sb.blockers) > 0 {
		fmt.Fprintln(w, "\nBlocked by:")
		for _, b := range sb.blockers {
			box, note := "[ ]", ""
			if b.ResolvedAt != "" {
				box = "[x]"
				if b.ResolvedReason != "" {
					note = " (" + b.ResolvedReason + ")"
				}
			}
			fmt.Fprintf(w, "  %s (#%d) %s%s\n", box, b.ID, cliBlockerLabel(b, sb.heads), note)
		}
	}
	if len(sb.blocks) > 0 {
		fmt.Fprintln(w, "\nBlocks:")
		for _, b := range sb.blocks {
			fmt.Fprintf(w, "  %s %s (%s)\n", b.ID, b.Title, b.State)
		}
	}
}
