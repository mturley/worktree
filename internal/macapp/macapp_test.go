package macapp

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/mturley/worktree/internal/config"
)

func sampleFS() fstest.MapFS {
	return fstest.MapFS{
		"main.swift":        {Data: []byte("print(1)\n")},
		"AppDelegate.swift": {Data: []byte("class A {}\n")},
		"Info.plist.tmpl":   {Data: []byte(testPlistTemplate)},
	}
}

const testPlistTemplate = `<plist><dict>
<key>CFBundleIdentifier</key><string>{{.BundleID}}</string>
<key>CFBundleExecutable</key><string>{{.ExecName}}</string>
<key>WorktreeServerURL</key><string>{{.ServerURL}}</string>
<key>WorktreeSourceHash</key><string>{{.SourceHash}}</string>
</dict></plist>
`

func mustHash(t *testing.T, fsys fs.FS) string {
	t.Helper()
	h, err := SourceHash(fsys)
	if err != nil {
		t.Fatalf("SourceHash: %v", err)
	}
	return h
}

func TestServerURLUsesDefaultPort(t *testing.T) {
	t.Parallel()
	if want := "http://127.0.0.1:" + strconv.Itoa(config.DefaultHTTPPort); ServerURL != want {
		t.Fatalf("ServerURL = %q, want %q", ServerURL, want)
	}
}

func TestSourceHashStable(t *testing.T) {
	t.Parallel()
	a, b := mustHash(t, sampleFS()), mustHash(t, sampleFS())
	if a != b {
		t.Fatalf("hash not stable: %s vs %s", a, b)
	}
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(a) {
		t.Fatalf("hash %q is not 64 hex chars", a)
	}
}

func TestSourceHashChangesWithAnyFile(t *testing.T) {
	t.Parallel()
	base := mustHash(t, sampleFS())

	changed := sampleFS()
	changed["main.swift"] = &fstest.MapFile{Data: []byte("print(2)\n")}

	added := sampleFS()
	added["StatusIcon.swift"] = &fstest.MapFile{Data: []byte("")}

	renamed := sampleFS()
	renamed["Main.swift"] = renamed["main.swift"]
	delete(renamed, "main.swift")

	for name, fsys := range map[string]fstest.MapFS{"changed": changed, "added": added, "renamed": renamed} {
		if mustHash(t, fsys) == base {
			t.Errorf("%s: hash did not change", name)
		}
	}
}

func TestSourceHashEmbedded(t *testing.T) {
	t.Parallel()
	full := mustHash(t, Source)

	without := fstest.MapFS{}
	err := fs.WalkDir(Source, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || p == "main.swift" {
			return err
		}
		data, err := fs.ReadFile(Source, p)
		without[p] = &fstest.MapFile{Data: data}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fs.Stat(Source, "main.swift"); err != nil {
		t.Fatalf("embedded source has no main.swift: %v", err)
	}
	if mustHash(t, without) == full {
		t.Fatal("hash does not cover main.swift")
	}
}

func writeBundle(t *testing.T, plist string) string {
	t.Helper()
	app := filepath.Join(t.TempDir(), AppName)
	if err := os.MkdirAll(filepath.Join(app, "Contents"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(app, "Contents", "Info.plist"), []byte(plist), 0o644); err != nil {
		t.Fatal(err)
	}
	return app
}

func TestInstalledHash(t *testing.T) {
	t.Parallel()
	app := writeBundle(t, "<dict>\n\t<key>WorktreeSourceHash</key>\n\t<string>abc123</string>\n</dict>")
	if h, ok := InstalledHash(app); !ok || h != "abc123" {
		t.Errorf("with key: got (%q, %v), want (abc123, true)", h, ok)
	}
	if h, ok := InstalledHash(filepath.Join(t.TempDir(), "missing.app")); ok || h != "" {
		t.Errorf("no bundle: got (%q, %v), want (\"\", false)", h, ok)
	}
	noKey := writeBundle(t, "<dict><key>CFBundleIdentifier</key><string>x</string></dict>")
	if h, ok := InstalledHash(noKey); ok || h != "" {
		t.Errorf("no key: got (%q, %v), want (\"\", false)", h, ok)
	}
}

// fakeSwiftc records its arguments and creates the file named after -o.
func fakeSwiftc(calls *[][]string) Runner {
	return func(name string, args ...string) ([]byte, error) {
		*calls = append(*calls, append([]string{name}, args...))
		for i, a := range args {
			if a == "-o" && i+1 < len(args) {
				return nil, os.WriteFile(args[i+1], []byte("binary"), 0o755)
			}
		}
		return nil, errors.New("no -o")
	}
}

func TestBuildRunsSwiftcAndWritesPlist(t *testing.T) {
	t.Parallel()
	fsys := sampleFS()
	app := filepath.Join(t.TempDir(), "Applications", AppName)
	var calls [][]string
	if err := Build(fsys, app, fakeSwiftc(&calls)); err != nil {
		t.Fatalf("Build: %v", err)
	}
	if len(calls) != 1 {
		t.Fatalf("runner called %d times, want 1: %v", len(calls), calls)
	}
	args := calls[0]
	if len(args) < 4 || !slices.Equal(args[:3], []string{"swiftc", "-O", "-o"}) {
		t.Fatalf("args = %v, want to start with swiftc -O -o", args)
	}
	for _, f := range []string{"main.swift", "AppDelegate.swift"} {
		if !slices.ContainsFunc(args, func(a string) bool { return filepath.Base(a) == f }) {
			t.Errorf("args %v do not include %s", args, f)
		}
	}
	if bin, err := os.ReadFile(filepath.Join(app, "Contents", "MacOS", ExecName)); err != nil || string(bin) != "binary" {
		t.Errorf("executable not in bundle: %q, %v", bin, err)
	}
	plist, err := os.ReadFile(filepath.Join(app, "Contents", "Info.plist"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{BundleID, "http://127.0.0.1:8475", mustHash(t, fsys), ExecName} {
		if !strings.Contains(string(plist), want) {
			t.Errorf("Info.plist does not contain %q:\n%s", want, plist)
		}
	}
	if h, ok := InstalledHash(app); !ok || h != mustHash(t, fsys) {
		t.Errorf("InstalledHash after Build = (%q, %v)", h, ok)
	}
	entries, _ := os.ReadDir(filepath.Dir(app))
	if len(entries) != 1 {
		t.Errorf("leftovers beside the app: %v", entries)
	}
}

func TestBuildWithURLSubstitutesURL(t *testing.T) {
	t.Parallel()
	app := filepath.Join(t.TempDir(), AppName)
	var calls [][]string
	if err := BuildWithURL(sampleFS(), app, "http://127.0.0.1:4121", fakeSwiftc(&calls)); err != nil {
		t.Fatalf("BuildWithURL: %v", err)
	}
	plist, _ := os.ReadFile(filepath.Join(app, "Contents", "Info.plist"))
	if !strings.Contains(string(plist), "<string>http://127.0.0.1:4121</string>") {
		t.Errorf("Info.plist lacks the URL:\n%s", plist)
	}
}

func TestBuildReplacesExistingApp(t *testing.T) {
	t.Parallel()
	app := filepath.Join(t.TempDir(), AppName)
	if err := os.MkdirAll(app, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(app, "old-marker"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	var calls [][]string
	if err := Build(sampleFS(), app, fakeSwiftc(&calls)); err != nil {
		t.Fatalf("Build: %v", err)
	}
	if _, err := os.Stat(filepath.Join(app, "old-marker")); !os.IsNotExist(err) {
		t.Errorf("old bundle content survived: %v", err)
	}
	if entries, _ := os.ReadDir(filepath.Dir(app)); len(entries) != 1 {
		t.Errorf("leftovers beside the app: %v", entries)
	}
}

func TestSwapInIgnoresFailedCleanup(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	app := filepath.Join(dir, "X.app")
	staging := filepath.Join(dir, "staging")
	// A read-only directory inside the old bundle makes RemoveAll fail.
	locked := filepath.Join(app, "locked")
	if err := os.MkdirAll(locked, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(locked, "f"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(locked, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(staging+"-old", "locked"), 0o755) })
	if err := os.MkdirAll(staging, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staging, "new"), []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := swapIn(staging, app); err != nil {
		t.Fatalf("swapIn = %v, want nil once the new bundle is in place", err)
	}
	if _, err := os.Stat(filepath.Join(app, "new")); err != nil {
		t.Errorf("new bundle not in place: %v", err)
	}
	if _, err := os.Stat(staging + "-old"); err != nil {
		t.Skipf("old bundle was removed anyway (running as root?): %v", err)
	}
}

func TestBuildFailureKeepsOldApp(t *testing.T) {
	t.Parallel()
	app := filepath.Join(t.TempDir(), AppName)
	if err := os.MkdirAll(app, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(app, "marker")
	if err := os.WriteFile(marker, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	fail := func(string, ...string) ([]byte, error) { return []byte("error: boom"), errors.New("exit 1") }
	err := Build(sampleFS(), app, fail)
	if err == nil {
		t.Fatal("Build succeeded with a failing compiler")
	}
	if !strings.Contains(err.Error(), "boom") {
		t.Errorf("error %q does not carry the compiler output", err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Errorf("old app was touched: %v", err)
	}
	if entries, _ := os.ReadDir(filepath.Dir(app)); len(entries) != 1 {
		t.Errorf("staging left behind: %v", entries)
	}
}

func TestLaunchAgentPlist(t *testing.T) {
	t.Parallel()
	app := "/Users/me/Applications/" + AppName
	got := string(LaunchAgentPlist(app))
	for _, want := range []string{
		"<key>Label</key>\n\t<string>me.turley.worktree.menubar</string>",
		"<string>" + app + "/Contents/MacOS/WorktreeMenuBar</string>",
		"<key>RunAtLoad</key>\n\t<true/>",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("plist lacks %q:\n%s", want, got)
		}
	}
	if esc := string(LaunchAgentPlist("/a&b<c>")); !strings.Contains(esc, "/a&amp;b&lt;c&gt;/Contents") {
		t.Errorf("path not escaped:\n%s", esc)
	}
}

// LoginItem.swift writes the same plist as LaunchAgentPlist, so setup and the
// app's "Open at login" item never fight over its bytes.
func TestLoginItemSwiftMatchesLaunchAgentPlist(t *testing.T) {
	t.Parallel()
	src, err := fs.ReadFile(Source, "LoginItem.swift")
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`(?s)let body = """\n(.*?)\n"""`).FindSubmatch(src)
	if m == nil {
		t.Fatal(`LoginItem.swift has no 'let body = """' literal`)
	}
	app := "/Users/me/Applications/" + AppName
	swift := strings.ReplaceAll(string(m[1]), `\(executable)`, app+"/Contents/MacOS/"+ExecName) + "\n"
	if got := string(LaunchAgentPlist(app)); swift != got {
		t.Errorf("LoginItem.swift and LaunchAgentPlist differ:\nswift:\n%s\ngo:\n%s", swift, got)
	}
}

// The menu bar icon draws favicon.svg's monogram from a copy of its path
// data, so the two stay identical.
func TestMonogramMatchesFavicon(t *testing.T) {
	t.Parallel()
	svg, err := os.ReadFile(filepath.Join("..", "..", "ui", "public", "favicon.svg"))
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`<path [^>]*\bd="([^"]+)"`).FindSubmatch(svg)
	if m == nil {
		t.Fatal("favicon.svg has no path data")
	}
	swift, err := fs.ReadFile(Source, "StatusIcon.swift")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(swift), `"`+string(m[1])+`"`) {
		t.Error("StatusIcon.swift's monogramPath differs from ui/public/favicon.svg's path; copy it across")
	}
}
