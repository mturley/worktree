package webui

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/mturley/worktree/internal/env"
	"github.com/mturley/worktree/internal/registry"
)

// kubeconfigFingerprint summarises every registered worktree's kubeconfig
// as path, modification time and size, so the stream can say when one
// changed (`oc login`, `oc project`, a context switch) without reading any.
// Only stats: no file reads and no processes. A missing file is part of the
// fingerprint too, so creating or deleting one counts as a change.
func (s *Server) kubeconfigFingerprint() string {
	if s.DB == nil {
		return ""
	}
	wts, err := registry.List(s.DB)
	if err != nil {
		return ""
	}
	var b strings.Builder
	for _, wt := range wts {
		p := env.KubeconfigPath(wt.Repo, filepath.Base(wt.Path))
		if fi, err := os.Stat(p); err == nil {
			fmt.Fprintf(&b, "%s\x00%d\x00%d\n", p, fi.ModTime().UnixNano(), fi.Size())
		} else {
			fmt.Fprintf(&b, "%s\x00-\n", p)
		}
	}
	return b.String()
}
