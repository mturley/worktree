package cmd

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"slices"
	"time"

	watcherdb "github.com/mturley/watcher/db"
	"github.com/mturley/worktree/internal/config"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/webui"
	"github.com/spf13/cobra"
)

// staleAfter is how old a service's last successful poll may be before its
// data counts as out of date. The UI polls every few minutes while running.
const staleAfter = 15 * time.Minute

// Why data counts as stale, as status reports it: per service in "reason",
// and all of them, with staleUINotRunning, in the top-level "stale_reason".
const (
	staleUINotRunning = "ui_not_running"
	staleNoSuccessYet = "no_success_yet"
	stalePollOld      = "poll_old"
	stalePollFailing  = "poll_failing"
)

// staleHint is what text output says when the UI is not running, which is the
// one case where starting it is the fix.
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
	Reason      string `json:"reason,omitempty"`
}

// statusReport is the body of `worktree status --json` (without the
// schema_version envelope, which printJSON adds).
type statusReport struct {
	UIRunning bool   `json:"ui_running"`
	UIURL     string `json:"ui_url"`
	Stale     bool   `json:"stale"`
	// StaleReason is never null: empty when Stale is false.
	StaleReason []string        `json:"stale_reason"`
	Services    []serviceStatus `json:"services"`
}

// staleReason says why a service's data is out of date, or "" when it isn't.
//
// A service only polls while it has active resources and working credentials,
// so one with nothing to poll never records a success and its last success
// stops moving: neither says the data is old, because there is no data to be
// old. Only an enabled service with active resources can be stale, and then
// only with no parseable last success within staleAfter of now.
func staleReason(now time.Time, lastSuccess, errMsg string, enabled, active bool) string {
	if !enabled || !active {
		return ""
	}
	reason := stalePollOld
	if t, err := time.Parse(time.RFC3339, lastSuccess); err == nil {
		if now.Sub(t) <= staleAfter {
			return ""
		}
	} else if lastSuccess == "" {
		reason = staleNoSuccessYet
	}
	if errMsg != "" {
		return stalePollFailing
	}
	return reason
}

// buildStatus gathers the report. It only reads the DB and probes the
// loopback port; it prints nothing and contacts no external service.
func buildStatus(conn *sql.DB, cfg config.Config, now time.Time) (statusReport, error) {
	srv := &webui.Server{DB: conn}
	rep := statusReport{
		UIRunning:   uiProbe(defaultUIPort),
		UIURL:       fmt.Sprintf("http://127.0.0.1:%d", defaultUIPort),
		StaleReason: []string{},
		Services:    []serviceStatus{},
	}
	if !rep.UIRunning {
		rep.StaleReason = append(rep.StaleReason, staleUINotRunning)
	}
	for _, w := range srv.WatcherStatuses() {
		active, err := watcherdb.ActiveResources(conn, w.Type)
		if err != nil {
			return statusReport{}, err
		}
		enabled := cfg.Watchers.Enabled(w.Name)
		reason := staleReason(now, w.LastSuccess, w.ErrorMessage, enabled, len(active) > 0)
		rep.Services = append(rep.Services, serviceStatus{
			Name:        w.Name,
			Enabled:     enabled,
			LastSuccess: w.LastSuccess,
			Error:       w.ErrorMessage,
			Stale:       reason != "",
			Reason:      reason,
		})
		if reason != "" && !slices.Contains(rep.StaleReason, reason) {
			rep.StaleReason = append(rep.StaleReason, reason)
		}
	}
	rep.Stale = len(rep.StaleReason) > 0
	return rep, nil
}

// statusHints is the advice text output gives for a stale report. With the UI
// down, starting it is the only advice that helps. With it up, starting it
// would do nothing, so each stale service gets its own.
func statusHints(rep statusReport) []string {
	if !rep.UIRunning {
		return []string{staleHint}
	}
	var hints []string
	for _, s := range rep.Services {
		switch s.Reason {
		case stalePollFailing:
			hints = append(hints, fmt.Sprintf("%s: polling is failing: %s. If its credentials expired, re-run `worktree setup`; activity below may be out of date.", s.Name, s.Error))
		case staleNoSuccessYet:
			hints = append(hints, fmt.Sprintf("%s: has not polled successfully yet. If that lasts more than a few minutes, check its credentials with `worktree setup`.", s.Name))
		case stalePollOld:
			hints = append(hints, fmt.Sprintf("%s: last successful poll is old though the UI is running. Check the Logs tab in Settings; activity below may be out of date.", s.Name))
		}
	}
	return hints
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
		case s.LastSuccess == "" && !s.Stale:
			fmt.Fprintf(out, "%s: nothing to poll\n", s.Name)
		case s.LastSuccess == "":
			fmt.Fprintf(out, "%s: never polled\n", s.Name)
		default:
			fmt.Fprintf(out, "%s: last success %s\n", s.Name, s.LastSuccess)
		}
		if s.Error != "" {
			fmt.Fprintf(out, "  error: %s\n", s.Error)
		}
	}
	for _, h := range statusHints(rep) {
		fmt.Fprintln(out, h)
	}
	return nil
}
