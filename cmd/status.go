package cmd

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/mturley/worktree/internal/config"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/webui"
	"github.com/spf13/cobra"
)

// staleAfter is how old a service's last successful poll may be before its
// data counts as out of date. The UI polls every few minutes while running.
const staleAfter = 15 * time.Minute

// staleHint is what text output says when buildStatus reports stale data.
const staleHint = "Start `worktree ui` so the watchers poll; activity below may be out of date."

// uiProbe reports whether a worktree UI is listening on port. A variable so
// tests do not depend on what runs on the machine.
var uiProbe = serverAlreadyListening

var statusJSON bool

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show whether the UI is running and the cached data is fresh",
	Long: "Show whether `worktree ui` is running and when each watcher last polled\n" +
		"successfully. Activity data only updates while the UI is running, so a\n" +
		"stale status means what other commands print may be out of date.",
	GroupID: "worktree",
	Args:    cobra.NoArgs,
	RunE:    runStatus,
}

func init() {
	statusCmd.Flags().BoolVar(&statusJSON, "json", false, "print the status as JSON")
	rootCmd.AddCommand(statusCmd)
}

// serviceStatus is one watcher's health as status reports it.
type serviceStatus struct {
	Name        string `json:"name"`
	Enabled     bool   `json:"enabled"`
	LastSuccess string `json:"last_success,omitempty"`
	Error       string `json:"error,omitempty"`
	Stale       bool   `json:"stale"`
}

// statusReport is the body of `worktree status --json` (without the
// schema_version envelope, which printJSON adds).
type statusReport struct {
	UIRunning bool            `json:"ui_running"`
	UIURL     string          `json:"ui_url"`
	Stale     bool            `json:"stale"`
	Services  []serviceStatus `json:"services"`
}

// staleness reports whether a service's data is out of date: it is enabled
// and has no parseable last success within staleAfter of now.
func staleness(now time.Time, lastSuccess string, enabled bool) bool {
	if !enabled {
		return false
	}
	t, err := time.Parse(time.RFC3339, lastSuccess)
	if err != nil {
		return true
	}
	return now.Sub(t) > staleAfter
}

// buildStatus gathers the report. It only reads the DB and probes the
// loopback port; it prints nothing and contacts no external service.
func buildStatus(conn *sql.DB, cfg config.Config, now time.Time) (statusReport, error) {
	srv := &webui.Server{DB: conn}
	rep := statusReport{
		UIRunning: uiProbe(defaultUIPort),
		UIURL:     fmt.Sprintf("http://127.0.0.1:%d", defaultUIPort),
		Services:  []serviceStatus{},
	}
	rep.Stale = !rep.UIRunning
	for _, w := range srv.WatcherStatuses() {
		enabled := cfg.Watchers.Enabled(w.Name)
		s := serviceStatus{
			Name:        w.Name,
			Enabled:     enabled,
			LastSuccess: w.LastSuccess,
			Error:       w.ErrorMessage,
			Stale:       staleness(now, w.LastSuccess, enabled),
		}
		if s.Stale {
			rep.Stale = true
		}
		rep.Services = append(rep.Services, s)
	}
	return rep, nil
}

// fields converts the report to printJSON's field map.
func (r statusReport) fields() map[string]any {
	b, _ := json.Marshal(r)
	m := map[string]any{}
	_ = json.Unmarshal(b, &m)
	return m
}

func runStatus(cmd *cobra.Command, args []string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	conn, err := wdb.OpenRead()
	if err != nil {
		return err
	}
	defer conn.Close()

	rep, err := buildStatus(conn, cfg, time.Now())
	if err != nil {
		return err
	}
	out := cmd.OutOrStdout()
	if statusJSON {
		return printJSON(out, rep.fields())
	}
	if rep.UIRunning {
		fmt.Fprintf(out, "UI: running at %s\n", rep.UIURL)
	} else {
		fmt.Fprintln(out, "UI: not running")
	}
	for _, s := range rep.Services {
		switch {
		case !s.Enabled:
			fmt.Fprintf(out, "%s: disabled\n", s.Name)
		case s.LastSuccess == "":
			fmt.Fprintf(out, "%s: never polled\n", s.Name)
		default:
			fmt.Fprintf(out, "%s: last success %s\n", s.Name, s.LastSuccess)
		}
		if s.Error != "" {
			fmt.Fprintf(out, "  error: %s\n", s.Error)
		}
	}
	if rep.Stale {
		fmt.Fprintln(out, staleHint)
	}
	return nil
}
