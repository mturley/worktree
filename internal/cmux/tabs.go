package cmux

import (
	"fmt"
	"strconv"
	"strings"
)

// runCmux runs one cmux command, folding its output into the error. cmux's
// "OK …" output is deliberately ignored: close-surface was seen to echo a
// different ref than the one it closed, so confirmation comes from a fresh
// Tree, never from parsing this.
func runCmux(what string, args ...string) error {
	if out, err := cmuxCmd(args...).CombinedOutput(); err != nil {
		return fmt.Errorf("%s: %s", what, strings.TrimSpace(string(out)))
	}
	return nil
}

// FocusTab selects a tab and focuses its pane. Select the workspace first if
// the tab should also be what the user is looking at.
func FocusTab(workspaceID, surfaceRef string) error {
	return runCmux("focusing tab", "focus-panel", "--panel", surfaceRef, "--workspace", workspaceID)
}

func CloseTab(workspaceID, surfaceRef string) error {
	return runCmux("closing tab", "close-surface", "--surface", surfaceRef, "--workspace", workspaceID)
}

// ClearWorkspaceName drops a custom title, so cmux names the workspace itself
// again.
func ClearWorkspaceName(workspaceID string) error {
	return runCmux("clearing workspace name", "workspace-action", "--workspace", workspaceID, "--action", "clear-name")
}

func ClearWorkspaceColor(workspaceID string) error {
	return runCmux("clearing workspace color", "workspace-action", "--workspace", workspaceID, "--action", "clear-color")
}

// TabPosition says where a reordered or moved tab lands: before or after an
// anchor tab, at a specific index, or — all empty — at the end of the target
// pane. Precedence is Before, then After, then Index, then end.
type TabPosition struct {
	Before string // surface ref
	After  string // surface ref
	Index  *int   // used when Before/After are empty
}

func (p TabPosition) args() []string {
	switch {
	case p.Before != "":
		return []string{"--before", p.Before}
	case p.After != "":
		return []string{"--after", p.After}
	case p.Index != nil:
		return []string{"--index", strconv.Itoa(*p.Index)}
	default:
		// cmux clamps an index past the end to the last position.
		return []string{"--index", "9999"}
	}
}

// ReorderTab moves a tab within its own pane. cmux refuses an anchor in
// another pane ("Anchor surface must be in the same pane"); use MoveTab.
// cmux also selects the moved tab and focuses its pane, whatever --focus says.
func ReorderTab(workspaceID, surfaceRef string, pos TabPosition) error {
	args := append([]string{"reorder-surface", "--surface", surfaceRef, "--workspace", workspaceID}, pos.args()...)
	return runCmux("reordering tab", args...)
}

// MoveTab moves a tab into another pane. Moving a pane's last tab out closes
// that pane.
func MoveTab(workspaceID, surfaceRef, paneRef string, pos TabPosition) error {
	args := append([]string{"move-surface", "--surface", surfaceRef, "--workspace", workspaceID, "--pane", paneRef}, pos.args()...)
	return runCmux("moving tab", args...)
}
