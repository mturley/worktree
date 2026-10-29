// Command devbuild builds the menu bar app from this checkout's source, for
// development (`make macapp`). It does not install anything: the bundle goes
// to bin/ unless -out says otherwise, and -url points it at a dev server.
//
//	go run ./internal/macapp/devbuild -url http://127.0.0.1:4121
package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/mturley/worktree/internal/macapp"
)

func main() {
	url := flag.String("url", macapp.ServerURL, "web UI address baked into the bundle's Info.plist")
	out := flag.String("out", filepath.Join("bin", macapp.AppName), "where to write the .app bundle")
	flag.Parse()

	run := func(name string, args ...string) ([]byte, error) {
		return exec.Command(name, args...).CombinedOutput()
	}
	if err := macapp.BuildWithURL(macapp.Source, *out, *url, run); err != nil {
		fmt.Fprintln(os.Stderr, "devbuild:", err)
		os.Exit(1)
	}
	fmt.Printf("Built %s (server %s)\n", *out, *url)
}
