package webui

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/notifyprefs"
)

func TestNotifyCommandGetsPlaceholdersWithoutEvaluatingThem(t *testing.T) {
	t.Parallel()
	wt := filepath.Join(t.TempDir(), "my-wt")
	out := filepath.Join(t.TempDir(), "out")
	canary := filepath.Join(t.TempDir(), "canary")
	s := &Server{
		cmuxAvailable: func() bool { return true },
		cmuxList: func() ([]cmux.Workspace, error) {
			return []cmux.Workspace{{ID: "W", Title: "wt my-wt", CurrentDirectory: wt}}, nil
		},
	}
	if err := os.MkdirAll(wt, 0o755); err != nil {
		t.Fatal(err)
	}
	s.runNotifyCommand(`printf '%s|%s|%s|%s|%s' "$event" "$resource" "$description" "$worktree" "$cmuxtitle" > `+out, notifyBatch{
		WorktreePath: wt,
		Event:        "Comment by bob",
		Resource:     "PR #7: Fix",
		// A hostile event body must stay text.
		Description: "$(touch " + canary + ") `touch " + canary + "`",
	})
	got, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	want := "Comment by bob|PR #7: Fix|$(touch " + canary + ") `touch " + canary + "`|my-wt|wt my-wt"
	if string(got) != want {
		t.Fatalf("got %q\nwant %q", got, want)
	}
	if _, err := os.Stat(canary); err == nil {
		t.Fatal("event text was executed")
	}
}

func TestNotifyCommandCmuxTitleEmptyWhenCmuxOff(t *testing.T) {
	t.Parallel()
	s := &Server{cmuxAvailable: func() bool { return false }}
	if got := s.notifyCmuxTitle(t.TempDir()); got != "" {
		t.Fatalf("got %q", got)
	}
}

func TestDeliverDoesNothingWhileNotificationsDisabled(t *testing.T) {
	t.Parallel()
	ft := &fakeTransport{}
	s := &Server{transport: ft}
	s.SetNotifications(config.NotificationsConfig{Disabled: true})
	s.deliver(notifyBatch{Title: "T"}, deliverOpts{})
	if len(ft.got) != 0 {
		t.Fatalf("delivered %+v while disabled", ft.got)
	}
	s.SetNotifications(config.NotificationsConfig{})
	s.deliver(notifyBatch{Title: "T"}, deliverOpts{})
	if len(ft.got) != 1 {
		t.Fatalf("delivered %+v once re-enabled", ft.got)
	}
}

func TestNotifyBatchesFillPlaceholders(t *testing.T) {
	t.Parallel()
	conn := unreadTestDB(t)
	a, _ := twoWorktrees(t, conn)
	if err := notifyprefs.SetAll(conn, a, true); err != nil {
		t.Fatal(err)
	}
	ft := &fakeTransport{}
	s := &Server{DB: conn, transport: ft}
	c, _ := initNotifyCursor(conn)
	insertTypedEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "pr_comment", "Comment by bob", "pr", "o/r#7")
	if _, err := conn.Exec(`UPDATE watcher_events SET body = ? WHERE id = 'e1'`, "line one\n\nline   two"); err != nil {
		t.Fatal(err)
	}
	s.notifyPass(&c)
	if len(ft.got) != 1 {
		t.Fatalf("delivered %+v", ft.got)
	}
	b := ft.got[0]
	if b.Event != "Comment by bob" || b.Description != "line one line two" || !strings.HasPrefix(b.Resource, "PR #7") {
		t.Fatalf("placeholders = %q / %q / %q", b.Event, b.Resource, b.Description)
	}
}

func TestTruncateRunes(t *testing.T) {
	t.Parallel()
	if got := truncateRunes("héllo world", 6); got != "héllo…" {
		t.Fatalf("got %q", got)
	}
	if got := truncateRunes("short", 6); got != "short" {
		t.Fatalf("got %q", got)
	}
}

func TestSettingsNotificationsRoundTripAndApplyLive(t *testing.T) {
	t.Parallel()
	s, path := settingsServer(t, "ui:\n    password: pw\n")
	cur := decodeSettings(t, doReq(s, "GET", "/api/settings", ""))
	n := cur.Worktree.Notifications
	if n == nil || !n.Enabled || n.CommandEnabled || n.Command != config.DefaultNotifyCommand {
		t.Fatalf("defaults = %+v", n)
	}
	if cur.Environment.DefaultNotifyCommand != config.DefaultNotifyCommand {
		t.Fatalf("default_notify_command = %q", cur.Environment.DefaultNotifyCommand)
	}
	cur.Worktree.Notifications = &notificationSettings{Enabled: false, CommandEnabled: true, Command: "  echo hi  "}
	b, _ := json.Marshal(cur.Worktree)
	got := decodeSettings(t, doReq(s, "PUT", "/api/settings/worktree", string(b)))
	if g := got.Worktree.Notifications; g.Enabled || !g.CommandEnabled || g.Command != "echo hi" {
		t.Fatalf("read back %+v", g)
	}
	if s.notificationsEnabled() {
		t.Fatal("live switch not applied")
	}
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), "disabled: true") || !strings.Contains(string(data), "command: echo hi") {
		t.Fatalf("file:\n%s", data)
	}

	// A PUT that leaves the section out keeps the file's values.
	body := `{"cmux_features_enabled":true,"jira":{"projects":[],"alias_hosts":[]},
	  "ui":{"https_port":8476,"allowed_hosts":[],"tls":{"cert_file":"","key_file":""}}}`
	doReq(s, "PUT", "/api/settings/worktree", body)
	data, _ = os.ReadFile(path)
	if !strings.Contains(string(data), "command: echo hi") {
		t.Fatalf("omitted section reset the command:\n%s", data)
	}

	// Enabled with an empty command falls back to the default, live too.
	cur.Worktree.Notifications = &notificationSettings{Enabled: true, CommandEnabled: true, Command: ""}
	b, _ = json.Marshal(cur.Worktree)
	got = decodeSettings(t, doReq(s, "PUT", "/api/settings/worktree", string(b)))
	if got.Worktree.Notifications.Command != config.DefaultNotifyCommand || s.notifyCommandLine() != config.DefaultNotifyCommand {
		t.Fatalf("command = %q live %q", got.Worktree.Notifications.Command, s.notifyCommandLine())
	}
}
