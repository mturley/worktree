package cmux

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

type Workspace struct {
	Ref              string `json:"ref"`
	CustomTitle      string `json:"custom_title"`
	CurrentDirectory string `json:"current_directory"`
	Selected         bool   `json:"selected"`
}

type listResult struct {
	Workspaces []Workspace `json:"workspaces"`
}

func IsAvailable() bool {
	return os.Getenv("CMUX_SOCKET_PATH") != ""
}

func cmuxCmd(args ...string) *exec.Cmd {
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

func FindByDirectory(dir string) (*Workspace, error) {
	workspaces, err := ListWorkspaces()
	if err != nil {
		return nil, err
	}
	for _, ws := range workspaces {
		if ws.CurrentDirectory == dir {
			return &ws, nil
		}
	}
	return nil, nil
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

// browserSurfaces returns the surfaces of the workspace's first browser pane,
// in tab order, or nil when the workspace has no browser pane.
func browserSurfaces(workspaceRef string) []Surface {
	panes, err := ListPanes(workspaceRef)
	if err != nil {
		return nil
	}
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
			return browsers
		}
	}
	return nil
}

// PinBrowserTabs pins the first n browser tabs of a workspace, in tab order.
// Best-effort: failures are silent, since a missing pin never justifies
// failing worktree creation.
func PinBrowserTabs(workspaceRef string, n int) {
	surfaces := browserSurfaces(workspaceRef)
	for i, s := range surfaces {
		if i >= n {
			return
		}
		PinTab(workspaceRef, s.Ref)
	}
}

// FocusFirstBrowserTab switches the workspace's browser pane to its first tab.
func FocusFirstBrowserTab(workspaceRef string) {
	surfaces := browserSurfaces(workspaceRef)
	if len(surfaces) == 0 {
		return
	}
	SwitchBrowserTab(surfaces[0].Ref, 0)
}

func BuildLayout(urls []string) string {
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

	mainTerminal := layoutNode{Pane: &pane{Surfaces: []surface{{Type: "terminal"}}}}
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
			mainTerminal,
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
