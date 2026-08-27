package cmux

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

type Workspace struct {
	Ref              string  `json:"ref"`
	Title            string  `json:"title"`
	CustomTitle      string  `json:"custom_title"`
	CustomColor      *string `json:"custom_color"` // hex like "#AD1457", or nil
	CurrentDirectory string  `json:"current_directory"`
	Selected         bool    `json:"selected"`
}

// DisplayTitle is the workspace's human name. cmux leaves custom_title null on
// workspaces it titles itself (e.g. "◐ handler-ratelimits"), so title comes
// first and the ref is the last resort.
func (w Workspace) DisplayTitle() string {
	if w.Title != "" {
		return w.Title
	}
	if w.CustomTitle != "" {
		return w.CustomTitle
	}
	return w.Ref
}

// canonical resolves a path for comparison: Abs -> EvalSymlinks -> Clean, the
// same normalization internal/db's Subscriber uses. A path that cannot be
// resolved (it may not exist) still gets Abs+Clean, so comparison degrades to
// a textual one rather than failing.
func canonical(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		abs = p
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		abs = resolved
	}
	return filepath.Clean(abs)
}

// Match maps each requested path to the workspaces whose current_directory
// resolves to the same location.
//
// Both sides are canonicalized exactly once — len(paths)+len(workspaces)
// EvalSymlinks syscalls, not the product. internal/webui/timeline.go:279
// records what per-pair resolution cost the Phase F timeline; do not repeat it.
//
// Keys are the caller's ORIGINAL path strings, not the resolved ones, so a
// caller can look up by the same path it passed in. Paths with no workspace
// are absent from the map rather than present with an empty slice.
func Match(workspaces []Workspace, paths []string) map[string][]Workspace {
	byDir := make(map[string][]Workspace, len(workspaces))
	for _, ws := range workspaces {
		if ws.CurrentDirectory == "" {
			continue
		}
		key := canonical(ws.CurrentDirectory)
		byDir[key] = append(byDir[key], ws)
	}

	out := make(map[string][]Workspace, len(paths))
	for _, p := range paths {
		if hits := byDir[canonical(p)]; len(hits) > 0 {
			out[p] = hits
		}
	}
	return out
}

// Activate raises the cmux app. Callers treat failure as non-fatal: a switch
// that worked but did not raise the window is still a switch.
func Activate() error {
	cmd := exec.Command("osascript", "-e", `tell application "cmux" to activate`)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("activating cmux: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

type listResult struct {
	Workspaces []Workspace `json:"workspaces"`
}

func IsAvailable() bool {
	return os.Getenv("CMUX_SOCKET_PATH") != ""
}

// cmuxCmd is a var so tests can stub the cmux binary.
var cmuxCmd = func(args ...string) *exec.Cmd {
	return exec.Command("cmux", args...)
}

func ListWorkspaces() ([]Workspace, error) {
	cmd := cmuxCmd("workspace", "list", "--json")
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("listing workspaces: %w", err)
	}

	var result listResult
	if err := json.Unmarshal(out, &result); err != nil {
		return nil, fmt.Errorf("parsing workspace list: %w", err)
	}
	return result.Workspaces, nil
}

// FindByDirectory returns the first workspace whose directory resolves to dir,
// or nil when none does. It goes through Match so the CLI gets the same
// symlink-resolving comparison the web UI does — a raw string compare here
// used to miss an existing workspace whenever either path ran through a
// symlink.
func FindByDirectory(dir string) (*Workspace, error) {
	workspaces, err := ListWorkspaces()
	if err != nil {
		return nil, err
	}
	hits := Match(workspaces, []string{dir})[dir]
	if len(hits) == 0 {
		return nil, nil
	}
	return &hits[0], nil
}

func SelectWorkspace(ref string) error {
	cmd := cmuxCmd("workspace", "select", ref)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("selecting workspace: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

func RenameWorkspace(ref, title string) error {
	cmd := cmuxCmd("workspace", "rename", ref, "--title", title)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("renaming workspace: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

type NewWorkspaceOptions struct {
	Name     string
	Cwd      string
	Layout   string
	Focus    bool
	GroupRef string
	EnvVars  map[string]string
}

func NewWorkspace(opts NewWorkspaceOptions) (string, error) {
	args := []string{"workspace", "create", "--json"}

	if opts.Name != "" {
		args = append(args, "--name", opts.Name)
	}
	if opts.Cwd != "" {
		args = append(args, "--cwd", opts.Cwd)
	}
	if opts.Layout != "" {
		args = append(args, "--layout", opts.Layout)
	}
	if opts.Focus {
		args = append(args, "--focus", "true")
	}
	if opts.GroupRef != "" {
		args = append(args, "--group", opts.GroupRef)
	}
	for k, v := range opts.EnvVars {
		args = append(args, "--env", fmt.Sprintf("%s=%s", k, v))
	}

	cmd := cmuxCmd(args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("creating workspace: %s", strings.TrimSpace(string(out)))
	}

	var result struct {
		WorkspaceRef string `json:"workspace_ref"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		return "", fmt.Errorf("parsing workspace create response: %w", err)
	}
	return result.WorkspaceRef, nil
}

type WorkspaceGroup struct {
	Ref  string `json:"ref"`
	Name string `json:"name"`
}

func ListGroups() ([]WorkspaceGroup, error) {
	cmd := cmuxCmd("workspace-group", "list", "--json")
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("listing groups: %w", err)
	}
	var result struct {
		Groups []WorkspaceGroup `json:"groups"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		return nil, err
	}
	return result.Groups, nil
}

func SetWorkspaceColor(workspaceRef, color string) error {
	cmd := cmuxCmd("workspace-action", "--workspace", workspaceRef, "--action", "set-color", "--color", color)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("setting color: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

type NamedColor struct {
	Name string
	Hex  string
}

var NamedColors = []NamedColor{
	{"Red", "#E74C3C"},
	{"Crimson", "#C0392B"},
	{"Orange", "#E67E22"},
	{"Amber", "#F39C12"},
	{"Olive", "#7D8C2E"},
	{"Green", "#27AE60"},
	{"Teal", "#008080"},
	{"Aqua", "#00BCD4"},
	{"Blue", "#2980B9"},
	{"Navy", "#2C3E6B"},
	{"Indigo", "#4B0082"},
	{"Purple", "#8E44AD"},
	{"Magenta", "#C2185B"},
	{"Rose", "#E91E63"},
	{"Brown", "#795548"},
	{"Charcoal", "#555555"},
}

func ColorDot(hex string) string {
	r, g, b := hexToRGB(hex)
	return fmt.Sprintf("\033[38;2;%d;%d;%dm●\033[0m", r, g, b)
}

func hexToRGB(hex string) (int, int, int) {
	hex = strings.TrimPrefix(hex, "#")
	if len(hex) != 6 {
		return 255, 255, 255
	}
	r, _ := strconv.ParseInt(hex[0:2], 16, 32)
	g, _ := strconv.ParseInt(hex[2:4], 16, 32)
	b, _ := strconv.ParseInt(hex[4:6], 16, 32)
	return int(r), int(g), int(b)
}

func OpenBrowser(url string) error {
	cmd := cmuxCmd("browser", "open", url)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("opening browser: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

type Surface struct {
	Ref  string `json:"ref"`
	Type string `json:"type"`
}

type Pane struct {
	Ref      string    `json:"ref"`
	Surfaces []Surface `json:"surfaces"`
}

func ListPaneSurfaces(workspaceRef, paneRef string) ([]Surface, error) {
	args := []string{"list-pane-surfaces", "--json", "--workspace", workspaceRef, "--pane", paneRef}
	cmd := cmuxCmd(args...)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("listing surfaces: %w", err)
	}
	var result struct {
		Surfaces []Surface `json:"surfaces"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		return nil, err
	}
	return result.Surfaces, nil
}

func ListPanes(workspaceRef string) ([]Pane, error) {
	cmd := cmuxCmd("list-panes", "--json", "--workspace", workspaceRef)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("listing panes: %w", err)
	}
	var result struct {
		Panes []Pane `json:"panes"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		return nil, err
	}
	return result.Panes, nil
}

func SwitchBrowserTab(surfaceRef string, tabIndex int) error {
	cmd := cmuxCmd("browser", surfaceRef, "tab", "switch", fmt.Sprintf("%d", tabIndex))
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("switching tab: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

// PinTab pins a single tab (surface) in a workspace, so it stays put and is
// skipped by the close-others/close-right tab actions.
func PinTab(workspaceRef, tabRef string) error {
	cmd := cmuxCmd("tab-action", "--workspace", workspaceRef, "--tab", tabRef, "--action", "pin")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("pinning tab: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

// browserSurfacesByPane returns each pane's browser surfaces, in pane order
// and tab order, skipping panes with no browser surface. The workspace layout
// puts the GitHub/Jira tabs in one pane and the worktree UI tab in another, so
// callers that care about every browser tab must walk all of them.
func browserSurfacesByPane(workspaceRef string) [][]Surface {
	panes, err := ListPanes(workspaceRef)
	if err != nil {
		return nil
	}
	var out [][]Surface
	for _, pane := range panes {
		surfaces, err := ListPaneSurfaces(workspaceRef, pane.Ref)
		if err != nil {
			continue
		}
		var browsers []Surface
		for _, s := range surfaces {
			if s.Type == "browser" {
				browsers = append(browsers, s)
			}
		}
		if len(browsers) > 0 {
			out = append(out, browsers)
		}
	}
	return out
}

// PinBrowserTabs pins every browser tab of a workspace, across all panes.
// Best-effort: failures are silent, since a missing pin never justifies
// failing worktree creation.
func PinBrowserTabs(workspaceRef string) {
	for _, browsers := range browserSurfacesByPane(workspaceRef) {
		for _, s := range browsers {
			PinTab(workspaceRef, s.Ref)
		}
	}
}

// FocusFirstBrowserTab switches the workspace's first browser pane to its
// first tab.
func FocusFirstBrowserTab(workspaceRef string) {
	panes := browserSurfacesByPane(workspaceRef)
	if len(panes) == 0 {
		return
	}
	SwitchBrowserTab(panes[0][0].Ref, 0)
}

// BuildLayout lays out a new workspace: the GitHub/Jira browser tabs (urls) on
// the left, and on the right the main shell terminal on top (with the running
// worktree UI pinned as a tab ahead of it, when uiURL is set) over a smaller
// `worktree info` terminal.
func BuildLayout(uiURL string, urls []string) string {
	type surface struct {
		Type    string `json:"type"`
		URL     string `json:"url,omitempty"`
		Command string `json:"command,omitempty"`
	}
	type pane struct {
		Surfaces []surface `json:"surfaces"`
	}
	type layoutNode struct {
		Direction string      `json:"direction,omitempty"`
		Split     float64     `json:"split,omitempty"`
		Children  interface{} `json:"children,omitempty"`
		Pane      *pane       `json:"pane,omitempty"`
	}

	var topRightSurfaces []surface
	if uiURL != "" {
		topRightSurfaces = append(topRightSurfaces, surface{Type: "browser", URL: uiURL})
	}
	topRightSurfaces = append(topRightSurfaces, surface{Type: "terminal"})

	mainPane := layoutNode{Pane: &pane{Surfaces: topRightSurfaces}}
	infoTerminal := layoutNode{Pane: &pane{Surfaces: []surface{{Type: "terminal", Command: "worktree info"}}}}

	var browserSurfaces []surface
	if len(urls) > 0 {
		for _, u := range urls {
			browserSurfaces = append(browserSurfaces, surface{Type: "browser", URL: u})
		}
	} else {
		browserSurfaces = []surface{{Type: "browser"}}
	}

	leftSide := layoutNode{Pane: &pane{Surfaces: browserSurfaces}}

	rightSide := layoutNode{
		Direction: "vertical",
		Split:     0.67,
		Children: []layoutNode{
			mainPane,
			infoTerminal,
		},
	}

	layout := layoutNode{
		Direction: "horizontal",
		Split:     0.5,
		Children:  []layoutNode{leftSide, rightSide},
	}

	data, _ := json.Marshal(layout)
	return string(data)
}
