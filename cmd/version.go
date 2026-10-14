package cmd

import (
	"fmt"
	"runtime/debug"

	"github.com/spf13/cobra"
)

var Version = "dev"

// buildCommit is the full git SHA the binary was built from, as the Go
// toolchain stamps it (vcs.revision) when building inside a checkout. Empty
// for a `go run` or a `go install pkg@version`, which carry no VCS stamp.
func buildCommit() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	for _, s := range info.Settings {
		if s.Key == "vcs.revision" {
			return s.Value
		}
	}
	return ""
}

var versionCmd = &cobra.Command{
	Use:     "version",
	Short:   "Print version",
	GroupID: "admin",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("worktree", Version)
	},
}

func init() {
	rootCmd.AddCommand(versionCmd)
}
