package cmux

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
)

// focusEventNames are the `cmux events` that move focus to a workspace.
// workspace.selected fires on a switch within a window; window.focused fires
// when another window comes forward, and carries that window's selected
// workspace, so following both keeps up across windows too.
var focusEventNames = []string{"workspace.selected", "window.focused"}

// ParseFocusEvent returns the workspace a `cmux events` line focused, or
// false for any other line (ack, heartbeat, an unrelated event, a workspace
// deselection). The ID is read from the payload first: it is the field the
// event is about, while the top-level workspace_id is cmux's routing context.
func ParseFocusEvent(line []byte) (string, bool) {
	var ev struct {
		Type        string `json:"type"`
		Name        string `json:"name"`
		WorkspaceID string `json:"workspace_id"`
		Payload     struct {
			WorkspaceID string `json:"workspace_id"`
			Selected    *bool  `json:"selected"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(line, &ev); err != nil || ev.Type != "event" {
		return "", false
	}
	known := false
	for _, n := range focusEventNames {
		if ev.Name == n {
			known = true
		}
	}
	if !known {
		return "", false
	}
	if ev.Payload.Selected != nil && !*ev.Payload.Selected {
		return "", false
	}
	id := ev.Payload.WorkspaceID
	if id == "" {
		id = ev.WorkspaceID
	}
	return id, id != ""
}

// WatchFocus streams cmux's focus events and calls onFocus with each newly
// focused workspace's ID until ctx is done or the stream ends. --reconnect
// makes the CLI ride out a cmux restart itself; the caller still retries when
// it returns, since the process can exit for other reasons.
func WatchFocus(ctx context.Context, onFocus func(workspaceID string)) error {
	args := []string{"events", "--no-ack", "--no-heartbeat", "--reconnect"}
	for _, n := range focusEventNames {
		args = append(args, "--name", n)
	}
	cmd := cmuxCmd(args...)
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("cmux events: %w", err)
	}
	stopped := make(chan struct{})
	defer close(stopped)
	go func() {
		select {
		case <-ctx.Done():
			_ = cmd.Process.Kill()
		case <-stopped:
		}
	}()

	sc := bufio.NewScanner(out)
	// Events carry titles and paths; give long lines room.
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		if id, ok := ParseFocusEvent(sc.Bytes()); ok {
			onFocus(id)
		}
	}
	scanErr := sc.Err()
	waitErr := cmd.Wait()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if scanErr != nil {
		return scanErr
	}
	if waitErr != nil {
		return fmt.Errorf("cmux events: %w", waitErr)
	}
	return fmt.Errorf("cmux events: stream ended")
}
