package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/mturley/worktree/internal/ui"
	"github.com/spf13/cobra"
)

var updateCmd = &cobra.Command{
	Use:     "update",
	Short:   "Update worktree to the latest version",
	GroupID: "admin",
	RunE:    runUpdate,
}

func init() {
	rootCmd.AddCommand(updateCmd)
}

func runUpdate(cmd *cobra.Command, args []string) error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot determine binary path: %w", err)
	}
	realPath, err := filepath.EvalSymlinks(exePath)
	if err != nil {
		realPath = exePath
	}

	gobin := resolveGobin()
	if gobin != "" && strings.HasPrefix(realPath, gobin) {
		fmt.Println("Updating via go install...")
		installCmd := exec.Command("go", "install", "github.com/mturley/worktree@latest")
		installCmd.Stdout = os.Stdout
		installCmd.Stderr = os.Stderr
		if err := installCmd.Run(); err != nil {
			return fmt.Errorf("go install failed: %w", err)
		}
		fmt.Printf("%s Updated binary\n", ui.Green("✓"))

		setupCmd := exec.Command(filepath.Join(gobin, "worktree"), "setup")
		setupCmd.Stdout = os.Stdout
		setupCmd.Stderr = os.Stderr
		setupCmd.Stdin = os.Stdin
		return setupCmd.Run()
	}

	fmt.Println("Binary not installed via 'go install'. To update manually:")
	fmt.Println("  cd <worktree-repo>")
	fmt.Println("  git pull")
	fmt.Println("  make build && make install")
	return nil
}

func resolveGobin() string {
	if v := os.Getenv("GOBIN"); v != "" {
		return v
	}
	if v := os.Getenv("GOPATH"); v != "" {
		return filepath.Join(v, "bin")
	}
	cmd := exec.Command("go", "env", "GOPATH")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	gopath := strings.TrimSpace(string(out))
	if gopath != "" {
		return filepath.Join(gopath, "bin")
	}
	return ""
}
