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

func ListWorkspaces() ([]Workspace, error) {
	cmd := exec.Command("cmux", "workspace", "list", "--json")
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
	cmd := exec.Command("cmux", "select-workspace", "--workspace", ref)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("selecting workspace: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

func RenameWorkspace(ref, title string) error {
	cmd := exec.Command("cmux", "rename-workspace", "--workspace", ref, "--", title)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("renaming workspace: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

type NewWorkspaceOptions struct {
	Name    string
	Cwd     string
	Layout  string // JSON layout string
	Focus   bool
	EnvVars map[string]string
}

func NewWorkspace(opts NewWorkspaceOptions) (string, error) {
	args := []string{"new-workspace"}

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

	cmd := exec.Command("cmux", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("creating workspace: %s", strings.TrimSpace(string(out)))
	}

	var result struct {
		Ref string `json:"ref"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		return strings.TrimSpace(string(out)), nil
	}
	return result.Ref, nil
}

func OpenBrowser(url string) error {
	cmd := exec.Command("cmux", "browser", "open", url)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("opening browser: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

type LayoutConfig struct {
	Panes []PaneConfig
}

type PaneConfig struct {
	Role     string // "terminal", "browser"
	Position string // "left", "right"
	Size     string // "50%", etc.
}

func BuildLayout(panes []PaneConfig, urls []string) string {
	hasBrowser := false
	for _, p := range panes {
		if p.Role == "browser" && len(urls) > 0 {
			hasBrowser = true
			break
		}
	}

	if !hasBrowser || len(urls) == 0 {
		return ""
	}

	type surface struct {
		Type string `json:"type"`
		URL  string `json:"url,omitempty"`
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

	termSurfaces := []surface{{Type: "terminal"}}
	browserSurfaces := make([]surface, 0, len(urls))
	for _, u := range urls {
		browserSurfaces = append(browserSurfaces, surface{Type: "browser", URL: u})
	}

	layout := layoutNode{
		Direction: "horizontal",
		Split:     0.5,
		Children: []layoutNode{
			{Pane: &pane{Surfaces: termSurfaces}},
			{Pane: &pane{Surfaces: browserSurfaces}},
		},
	}

	data, _ := json.Marshal(layout)
	return string(data)
}
