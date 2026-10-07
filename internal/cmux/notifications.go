package cmux

import (
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// Notification is one entry from `cmux rpc notification.list`, trimmed to
// the fields the unread dot needs (verified against cmux 0.64). History is
// kept — read notifications stay listed — so IsRead matters: a tab is
// unread when ANY of its notifications has IsRead false.
type Notification struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspace_id"`
	SurfaceRef  string `json:"surface_ref"`
	SurfaceID   string `json:"surface_id"`
	IsRead      bool   `json:"is_read"`
}

type rawNotifications struct {
	Notifications []Notification `json:"notifications"`
}

// parseNotifications is pure so it can be tested with synthetic fixtures.
func parseNotifications(data []byte) ([]Notification, error) {
	var raw rawNotifications
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parsing notification list: %w", err)
	}
	return raw.Notifications, nil
}

// ListNotifications reads cmux's full notification history.
func ListNotifications() ([]Notification, error) {
	out, err := cmuxCmd("rpc", "notification.list", "{}").Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			if stderr := strings.TrimSpace(string(exitErr.Stderr)); stderr != "" {
				return nil, fmt.Errorf("listing notifications: %s", stderr)
			}
		}
		return nil, fmt.Errorf("listing notifications: %w", err)
	}
	return parseNotifications(out)
}
