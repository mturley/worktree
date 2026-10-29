// Package macapp embeds the macOS menu bar app's Swift source and builds it
// into an .app bundle with swiftc. `worktree setup` uses it to install the
// app into ~/Applications; `make macapp` uses it (via ./devbuild) to build a
// development bundle into bin/.
//
// The app is an AppKit status item whose popover hosts a WKWebView showing
// the web UI's /mini page. See docs/superpowers/specs/2026-10-29-mac-menu-bar-design.md.
package macapp

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
)

//go:embed app
var embedded embed.FS

// Source is the app's source tree (Swift files and the Info.plist template),
// rooted at the app directory so paths read "main.swift", not "app/main.swift".
var Source fs.FS = mustSub(embedded, "app")

func mustSub(fsys fs.FS, dir string) fs.FS {
	sub, err := fs.Sub(fsys, dir)
	if err != nil {
		panic(err)
	}
	return sub
}

const (
	// BundleID is the app's CFBundleIdentifier and its LaunchAgent label.
	BundleID = "me.turley.worktree.menubar"
	// AppName is the bundle's directory name.
	AppName = "Worktree Menu Bar.app"
	// ExecName is the executable inside Contents/MacOS.
	ExecName = "WorktreeMenuBar"
	// ServerURL is the web UI's loopback address, from config.DefaultHTTPPort
	// (a test holds the two together; Go cannot format an int into a const).
	ServerURL = "http://127.0.0.1:8475"
)

// SourceHash is a SHA-256 over every file in fsys, sorted by path, each
// contributing path, NUL, contents, NUL. It is stored in the built bundle's
// Info.plist so setup can tell whether the installed app is out of date.
func SourceHash(fsys fs.FS) (string, error) {
	var paths []string
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			paths = append(paths, p)
		}
		return err
	})
	if err != nil {
		return "", err
	}
	sort.Strings(paths)
	h := sha256.New()
	for _, p := range paths {
		data, err := fs.ReadFile(fsys, p)
		if err != nil {
			return "", err
		}
		h.Write([]byte(p))
		h.Write([]byte{0})
		h.Write(data)
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Paths are where the app and its LaunchAgent live.
type Paths struct {
	App, LaunchAgent string
	// WebKitData is the web view's cookie and storage directory.
	WebKitData string
}

// DefaultPaths returns the install locations under home.
func DefaultPaths(home string) Paths {
	return Paths{
		App:         filepath.Join(home, "Applications", AppName),
		LaunchAgent: filepath.Join(home, "Library", "LaunchAgents", BundleID+".plist"),
		WebKitData:  filepath.Join(home, "Library", "WebKit", BundleID),
	}
}

var sourceHashKey = regexp.MustCompile(`<key>WorktreeSourceHash</key>\s*<string>([^<]+)</string>`)

// InstalledHash reads the source hash recorded in the bundle at appPath. ok is
// false when the bundle, its Info.plist or the key is missing.
func InstalledHash(appPath string) (hash string, ok bool) {
	data, err := os.ReadFile(filepath.Join(appPath, "Contents", "Info.plist"))
	if err != nil {
		return "", false
	}
	m := sourceHashKey.FindSubmatch(data)
	if m == nil {
		return "", false
	}
	return string(m[1]), true
}
