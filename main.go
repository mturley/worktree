package main

import "github.com/mturley/worktree/cmd"

func main() {
	cmd.SetWebFS(EmbeddedWeb)
	cmd.Execute()
}
