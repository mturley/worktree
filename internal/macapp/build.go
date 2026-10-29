package macapp

import (
	"bytes"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"text/template"
)

// Runner runs a command and returns its combined output. Build takes one so
// tests can stand in for swiftc.
type Runner func(name string, args ...string) ([]byte, error)

const plistTemplateName = "Info.plist.tmpl"

// Build compiles the app in fsys into the bundle at appPath, pointed at
// ServerURL. See BuildWithURL.
func Build(fsys fs.FS, appPath string, run Runner) error {
	return BuildWithURL(fsys, appPath, ServerURL, run)
}

// BuildWithURL compiles every *.swift file in fsys with swiftc into a staging
// bundle beside appPath, writes its Info.plist from the template (with
// serverURL and the source hash), and then swaps it in for appPath. If
// anything fails, appPath is left as it was and the staging bundle is removed.
func BuildWithURL(fsys fs.FS, appPath, serverURL string, run Runner) error {
	hash, err := SourceHash(fsys)
	if err != nil {
		return fmt.Errorf("hashing app source: %w", err)
	}
	plist, err := renderPlist(fsys, serverURL, hash)
	if err != nil {
		return err
	}

	parent := filepath.Dir(appPath)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return err
	}
	staging, err := os.MkdirTemp(parent, ".worktree-menubar-staging-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging) // a no-op once it has been renamed into place

	// swiftc reads real files, so the embedded source is copied out first.
	// It goes in its own temp dir rather than the bundle, which must not ship
	// the source.
	srcDir, err := os.MkdirTemp("", "worktree-menubar-src-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(srcDir)
	swiftFiles, err := copySwift(fsys, srcDir)
	if err != nil {
		return err
	}
	if len(swiftFiles) == 0 {
		return fmt.Errorf("app source has no .swift files")
	}

	macOS := filepath.Join(staging, "Contents", "MacOS")
	if err := os.MkdirAll(macOS, 0o755); err != nil {
		return err
	}
	args := append([]string{"-O", "-o", filepath.Join(macOS, ExecName)}, swiftFiles...)
	if out, err := run("swiftc", args...); err != nil {
		return fmt.Errorf("swiftc: %w\n%s", err, strings.TrimSpace(string(out)))
	}
	if err := os.WriteFile(filepath.Join(staging, "Contents", "Info.plist"), plist, 0o644); err != nil {
		return err
	}
	if err := os.Chmod(staging, 0o755); err != nil { // MkdirTemp makes it 0700
		return err
	}
	return swapIn(staging, appPath)
}

func renderPlist(fsys fs.FS, serverURL, hash string) ([]byte, error) {
	src, err := fs.ReadFile(fsys, plistTemplateName)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", plistTemplateName, err)
	}
	tmpl, err := template.New(plistTemplateName).Option("missingkey=error").Parse(string(src))
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	err = tmpl.Execute(&buf, map[string]string{
		"BundleID":   plistEscaper.Replace(BundleID),
		"ExecName":   plistEscaper.Replace(ExecName),
		"ServerURL":  plistEscaper.Replace(serverURL),
		"SourceHash": hash,
	})
	if err != nil {
		return nil, fmt.Errorf("rendering %s: %w", plistTemplateName, err)
	}
	return buf.Bytes(), nil
}

func copySwift(fsys fs.FS, dir string) ([]string, error) {
	var out []string
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || path.Ext(p) != ".swift" {
			return err
		}
		data, err := fs.ReadFile(fsys, p)
		if err != nil {
			return err
		}
		dst := filepath.Join(dir, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		out = append(out, dst)
		return os.WriteFile(dst, data, 0o644)
	})
	sort.Strings(out)
	return out, err
}

// swapIn replaces appPath with staging: the old bundle is renamed aside, the
// new one renamed in, and only then is the old one removed. If the second
// rename fails the old bundle is put back. Once the new bundle is in place
// the build has succeeded, so failing to delete the old one is only a warning.
func swapIn(staging, appPath string) error {
	old := ""
	if _, err := os.Lstat(appPath); err == nil {
		old = staging + "-old"
		if err := os.Rename(appPath, old); err != nil {
			return fmt.Errorf("moving the old app aside: %w", err)
		}
	}
	if err := os.Rename(staging, appPath); err != nil {
		if old != "" {
			_ = os.Rename(old, appPath)
		}
		return fmt.Errorf("installing the new app: %w", err)
	}
	if old != "" {
		if err := os.RemoveAll(old); err != nil {
			fmt.Fprintf(os.Stderr, "warning: the new app is installed, but the old one could not be removed (%s): %v\n", old, err)
		}
	}
	return nil
}
