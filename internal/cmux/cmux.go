package cmux

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
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

var NamedColors = []string{
	"Red", "Crimson", "Orange", "Amber", "Olive", "Green", "Teal", "Aqua",
	"Blue", "Navy", "Indigo", "Purple", "Magenta", "Rose", "Brown", "Charcoal",
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

func FocusPRTab(workspaceRef string) {
	panes, err := ListPanes(workspaceRef)
	if err != nil {
		return
	}
	for _, pane := range panes {
		surfaces, err := ListPaneSurfaces(workspaceRef, pane.Ref)
		if err != nil {
			continue
		}
		for _, s := range surfaces {
			if s.Type == "browser" {
				SwitchBrowserTab(s.Ref, 0)
				return
			}
		}
	}
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

	leftTerminal := layoutNode{Pane: &pane{Surfaces: []surface{{Type: "terminal"}}}}
	rightTerminal := layoutNode{Pane: &pane{Surfaces: []surface{{Type: "terminal", Command: "worktree info"}}}}

	var browserSurfaces []surface
	if len(urls) > 0 {
		for _, u := range urls {
			browserSurfaces = append(browserSurfaces, surface{Type: "browser", URL: u})
		}
	} else {
		browserSurfaces = []surface{{Type: "browser"}}
	}

	rightSide := layoutNode{
		Direction: "vertical",
		Split:     0.67,
		Children: []layoutNode{
			{Pane: &pane{Surfaces: browserSurfaces}},
			rightTerminal,
		},
	}

	layout := layoutNode{
		Direction: "horizontal",
		Split:     0.5,
		Children:  []layoutNode{leftTerminal, rightSide},
	}

	data, _ := json.Marshal(layout)
	return string(data)
}
