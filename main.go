package main

import (
	"os"

	"github.com/mturley/worktree/cmd"
)

func main() {
	cmd.SetWebFS(EmbeddedWeb)
	os.Exit(cmd.Execute())
}
