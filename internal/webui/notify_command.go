package webui

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/config"
)

// notifyCommandTimeout bounds one run of the custom notification command, so
// a hung command can't pile up processes.
const notifyCommandTimeout = 30 * time.Second

// Truncation limits for the custom command's placeholders: a notification
// is a one-liner, and event bodies can be whole CI logs or PR descriptions.
const (
	notifyNameMax        = 40
	notifyDescriptionMax = 200
)

// SetNotifications sets the notification settings from config: the global
// switch and the custom command. Settings calls it again on save.
func (s *Server) SetNotifications(n config.NotificationsConfig) {
	s.notifyOff.Store(n.Disabled)
	cmd := n.EffectiveCommand()
	s.notifyCommand.Store(&cmd)
}

// notificationsEnabled is the Settings modal's "Enable notifications".
func (s *Server) notificationsEnabled() bool { return !s.notifyOff.Load() }

func (s *Server) notifyCommandLine() string {
	if p := s.notifyCommand.Load(); p != nil {
		return *p
	}
	return ""
}

// notifyCommandVars are the custom command's placeholders for b, as shell
// variable assignments. Passing them through the environment rather than
// splicing them into the command text is what keeps a PR title like
// `$(rm -rf ~)` inert: the shell expands a variable's value without
// evaluating it again.
func (s *Server) notifyCommandVars(b notifyBatch) []string {
	worktree := ""
	if b.WorktreePath != "" {
		worktree = filepath.Base(b.WorktreePath)
	}
	return []string{
		"event=" + b.Event,
		"resource=" + b.Resource,
		"description=" + b.Description,
		"worktree=" + worktree,
		"cmuxtitle=" + s.notifyCmuxTitle(b.WorktreePath),
	}
}

// notifyCmuxTitle is the title of path's cmux workspace, or "" with no
// workspace or with cmux features off.
func (s *Server) notifyCmuxTitle(path string) string {
	if path == "" || !s.cmuxEnabled() {
		return ""
	}
	ws, err := s.listCmuxWorkspaces()
	if err != nil {
		s.logger().Printf("notify command: listing cmux workspaces: %v", err)
		return ""
	}
	if hits := cmux.Match(ws, []string{path})[path]; len(hits) > 0 {
		return hits[0].DisplayTitle()
	}
	return ""
}

// runNotifyCommand runs cmdline under sh -c for b, logging any failure with
// its output. It blocks; deliver runs it in a goroutine.
func (s *Server) runNotifyCommand(cmdline string, b notifyBatch) {
	ctx, cancel := context.WithTimeout(context.Background(), notifyCommandTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", cmdline)
	cmd.Env = append(os.Environ(), s.notifyCommandVars(b)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		s.logger().Printf("notify command: %v: %s", err, strings.TrimSpace(string(out)))
	}
}

// truncateRunes shortens s to max runes, ending in "…" when cut.
func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return strings.TrimSpace(string(r[:max-1])) + "…"
}

// oneLine collapses all whitespace runs (newlines included) to single spaces.
func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }
