package cmd

import (
	"errors"
	"fmt"
	"syscall"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/jobs"
	"github.com/spf13/cobra"
)

var (
	jobsJSON    bool
	jobsRunning bool
)

// pidAlive reports whether a process with this pid exists. A var so tests can
// drive it.
var pidAlive = func(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

var jobsCmd = &cobra.Command{
	Use:   "jobs",
	Short: "List background jobs that have not finished",
	Long: "List the web UI server's unfinished background jobs (worktree create and delete),\n" +
		"from the database, with no server or login needed.\n\n" +
		"A job is live when its state is running and the server process that runs it still\n" +
		"exists. --running keeps only live jobs; `make install` uses it to avoid stopping a\n" +
		"busy server. Plain output is one line per job: the title, then the running step's\n" +
		"label (or the state when no step is running).\n\n" +
		"Always exits 0, including when there are no jobs.",
	GroupID: "worktree",
	Args:    cobra.NoArgs,
	RunE:    runJobs,
}

func init() {
	jobsCmd.Flags().BoolVar(&jobsRunning, "running", false, "only jobs that are running now (their server process is alive)")
	jobsCmd.Flags().BoolVar(&jobsJSON, "json", false, `print {"schema_version": 1, "jobs": [...]}`)
	rootCmd.AddCommand(jobsCmd)
}

type jobRow struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Title       string `json:"title"`
	State       string `json:"state"`
	Live        bool   `json:"live"`
	CurrentStep string `json:"current_step"`
	CreatedAt   string `json:"created_at"`
}

func runJobs(cmd *cobra.Command, args []string) error {
	rows := []jobRow{}
	conn, err := wdb.OpenRead()
	if errors.Is(err, wdb.ErrSchemaBehind) {
		// A schema older than this binary's says nothing about the jobs
		// table, which may well be there and hold a job in flight. Read it
		// anyway: `make install` asks this command whether the running
		// server is busy, and answering "no jobs" because a migration is
		// pending is how a job gets killed. jobs.Unfinished copes with the
		// table being absent.
		conn, err = wdb.OpenReadAnyVersion()
	}
	switch {
	case errors.Is(err, wdb.ErrNoDatabase):
		// No database at all: there are no jobs.
	case err != nil:
		return err
	default:
		defer conn.Close()
		list, err := jobs.Unfinished(conn)
		if err != nil {
			return err
		}
		for _, j := range list {
			live := j.State == jobs.StateRunning && pidAlive(j.PID)
			if jobsRunning && !live {
				continue
			}
			step := ""
			for _, s := range j.Steps {
				if s.Status == jobs.StepRunning {
					step = s.Label
					break
				}
			}
			rows = append(rows, jobRow{
				ID: j.ID, Kind: j.Kind, Title: j.Title, State: string(j.State),
				Live: live, CurrentStep: step, CreatedAt: j.CreatedAt,
			})
		}
	}
	w := cmd.OutOrStdout()
	if jobsJSON {
		return printJSON(w, map[string]any{"jobs": rows})
	}
	for _, r := range rows {
		what := r.CurrentStep
		if what == "" {
			what = r.State
		}
		fmt.Fprintf(w, "%s — %s\n", r.Title, what)
	}
	return nil
}
