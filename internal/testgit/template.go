package testgit

import (
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// Starting a git process is expensive on some machines (an endpoint security
// agent can add 100ms+ to every exec), and a fixture repo can take dozens of
// git commands to build. Template builds each named fixture once per test
// binary and hands every caller its own copy, made without running git.
//
// A copy is a plain file copy of the template directory, followed by
// rewriting the template's absolute path to the copy's in git's own metadata
// files (a linked worktree's gitdir pointers, a clone's remote URL). Both the
// path as given and its symlink-resolved form are rewritten, since git records
// the resolved one (/private/var/... on macOS).

var (
	templatesMu sync.Mutex
	templates   = map[string]*template{}
	templateDir string
)

type template struct {
	once sync.Once
	dir  string // the built template; empty if the build failed
}

// Template returns a fresh copy of the directory build creates. build runs at
// most once per name per test binary, in an empty directory that outlives the
// calling test; it must leave nothing in that directory that records an
// absolute path outside it. Call RemoveTemplates from TestMain to delete the
// templates when the binary exits.
func Template(t *testing.T, name string, build func(t *testing.T, dir string)) string {
	t.Helper()

	templatesMu.Lock()
	tm, ok := templates[name]
	if !ok {
		tm = &template{}
		templates[name] = tm
	}
	templatesMu.Unlock()

	tm.once.Do(func() {
		root, err := templateRoot()
		if err != nil {
			t.Fatal(err)
		}
		dir, err := os.MkdirTemp(root, "tmpl-")
		if err != nil {
			t.Fatal(err)
		}
		build(t, dir)
		tm.dir = dir // only reached if build did not fail the test
	})
	if tm.dir == "" {
		t.Fatalf("testgit: building template %q failed in an earlier test", name)
	}

	dst := t.TempDir()
	if err := copyTemplate(tm.dir, dst); err != nil {
		t.Fatalf("testgit: copying template %q: %v", name, err)
	}
	return dst
}

// RemoveTemplates deletes every template built by this test binary.
func RemoveTemplates() {
	templatesMu.Lock()
	defer templatesMu.Unlock()
	if templateDir != "" {
		os.RemoveAll(templateDir)
	}
}

func templateRoot() (string, error) {
	templatesMu.Lock()
	defer templatesMu.Unlock()
	if templateDir == "" {
		dir, err := os.MkdirTemp("", "testgit-templates-")
		if err != nil {
			return "", err
		}
		templateDir = dir
	}
	return templateDir, nil
}

func copyTemplate(src, dst string) error {
	if err := os.CopyFS(dst, os.DirFS(src)); err != nil {
		return err
	}
	type swap struct{ old, new []byte }
	var swaps []swap
	// The resolved form first: it contains the unresolved one on macOS
	// (/private/var/... vs /var/...), so the shorter must not match first.
	realSrc, err1 := filepath.EvalSymlinks(src)
	realDst, err2 := filepath.EvalSymlinks(dst)
	if err1 == nil && err2 == nil && realSrc != src {
		swaps = append(swaps, swap{[]byte(realSrc), []byte(realDst)})
	}
	swaps = append(swaps, swap{[]byte(src), []byte(dst)})

	return filepath.WalkDir(dst, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			// Objects are zlib-compressed, and the index is binary: neither
			// records an absolute path, and rewriting either would corrupt it.
			if d.Name() == "objects" {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Name() == "index" || !d.Type().IsRegular() {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		out := b
		for _, s := range swaps {
			out = bytes.ReplaceAll(out, s.old, s.new)
		}
		if bytes.Equal(out, b) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		return os.WriteFile(path, out, info.Mode().Perm())
	})
}
