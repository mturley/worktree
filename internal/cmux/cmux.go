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
	Name    string
	Cwd     string
	Layout  string
	Focus   bool
	EnvVars map[string]string
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

func OpenBrowser(url string) error {
	cmd := cmuxCmd("browser", "open", url)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("opening browser: %s", strings.TrimSpace(string(out)))
	}
	return nil
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

	leftTerminal := layoutNode{Pane: &pane{Surfaces: []surface{{Type: "terminal", Command: "claude"}}}}
	rightTerminal := layoutNode{Pane: &pane{Surfaces: []surface{{Type: "terminal"}}}}

	var rightSide layoutNode
	if len(urls) > 0 {
		browserSurfaces := make([]surface, 0, len(urls))
		for _, u := range urls {
			browserSurfaces = append(browserSurfaces, surface{Type: "browser", URL: u})
		}
		rightSide = layoutNode{
			Direction: "vertical",
			Split:     0.33,
			Children: []layoutNode{
				rightTerminal,
				{Pane: &pane{Surfaces: browserSurfaces}},
			},
		}
	} else {
		rightSide = rightTerminal
	}

	layout := layoutNode{
		Direction: "horizontal",
		Split:     0.5,
		Children:  []layoutNode{leftTerminal, rightSide},
	}

	data, _ := json.Marshal(layout)
	return string(data)
}
