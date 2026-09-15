# Web UI Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require a password-backed session for the whole web UI API, serve other devices only over HTTPS from a single-purpose CA, refuse unrecognised `Host` headers, and close the IPv6-embedded-IPv4 gaps in the outbound blocklist.

**Architecture:** `worktree ui` keeps its plain-HTTP listener on `127.0.0.1:8475` and adds an HTTPS listener on every interface (`:8476`) when setup has configured remote access. Every request passes, outermost first, a Host allowlist, the existing request-forgery guard, and a deny-by-default session check on `/api/`. Sessions live in a worktree-owned SQLite table keyed by a hash of the cookie token. `worktree setup` generates the password, detects the Mac's `.local` name and LAN IP, and issues a certificate from a CA whose private key is never written to disk.

**Tech Stack:** Go 1.26 stdlib (`crypto/ecdsa`, `crypto/x509`, `crypto/subtle`, `net/http`), SQLite via `modernc.org/sqlite`, cobra; React 19 + Mantine 7 + TanStack Query 5 + Vitest.

**Spec:** `docs/superpowers/specs/2026-09-11-webui-hardening-design.md`

## Global Constraints

- **The repo is public.** Code comments, docs, commit messages and test names describe what the code does and why. They must never describe weaknesses that remain after this work.
- No new third-party Go modules and no new npm packages. Everything here is stdlib, or already a dependency.
- Commits: `git commit --signoff`, add files by name (never `git add -A` / `git add .`), never amend, never `git clean` / `git restore .`. End every commit message with the two attribution lines:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01LdwrX6PaoHfKtDBE96EaPx`.
- `internal/safehttp` is the only containment for outbound fetches. Never copy it, weaken it, or replace its per-dial check with a pre-flight lookup.
- **Security tests must fail for the guard's reason.** Assert guard-specific output (error text, a status code another layer cannot produce, a response header). Where a task says *break-check*, temporarily disable the guard, confirm the named test fails, restore the guard, and confirm `git diff` shows only the intended change.
- The password is never logged or returned by any API. The one exception: setup prints a password it has just generated, once.
- Session tokens are never stored raw and never returned by any API. The DB stores `hex(sha256(token))`, called the session's **handle**.
- Exact values:
  - cookie name `worktree_session`, session lifetime 30 days, `last_seen_at` touch interval 5 minutes
  - HTTP listener `127.0.0.1:<--port>` (default 8475); HTTPS port `ui.https_port` (default **8476**)
  - leaf validity 397 days, CA validity 400 days, ECDSA P-256, CA common name `worktree local UI CA`
  - files `ui-ca.pem` (0644), `ui-cert.pem` (0644), `ui-key.pem` (0600), in the directory holding `config.yaml`
  - login-required responses: status 401 **and** header `X-Worktree-Login-Required: 1`
- Test commands: Go `go test ./...` from the repo root; UI `npm test` and `npx tsc -b` from `ui/`. Run tests in the foreground.

## Decisions made while planning

These refine the spec. Where they differ from it, this plan governs.

1. **Sessions are keyed by `token_hash`**, not the raw id, so reading the DB never yields a usable login. The UI identifies sessions by that hash (the *handle*), and `POST /api/sessions/revoke` takes `{"handle": "..."}`.
2. **`GET /api/session`** is added. It returns the current session and is how the UI decides whether to show the login screen.
3. **Login-required 401s carry `X-Worktree-Login-Required: 1`.** The server already returns 401 when *Slack's* credentials fail, and the UI shows a Slack-specific message for that. The header keeps the two apart.
4. **`--bind` and `--yes` are both removed** from `worktree ui`. Passing either fails with an error pointing at `worktree setup`. **`--api-only` implies `--local-only`**: the Vite dev server is not something to reach from a phone.
5. **`64:ff9b:1::/48` (local-use NAT64, RFC 8215) is refused outright.** Its embedded IPv4 position depends on the operator's prefix length, so it is not decoded. The well-known `64:ff9b::/96` is decoded.
6. **Alternative IPv4 literals, observed on macOS:** `net.ParseIP` rejects all three, so they go through `LookupIP`. The system resolver maps `2130706433` and `0x7f.0.0.1` to `127.0.0.1`, which the blocklist refuses. It maps `0177.0.0.1` to `177.0.0.1`, a public address, not `127.0.0.1`. The tests pin the first two. The octal form is pinned only at `ParseIP`, because dialing it would make a real connection.
7. **Remote access is a step inside `worktree setup`**, with no `--tls` flag.
8. **`cmux-tool-servers` (in `~/git/work-scripts`) is updated in Task 13**, in the same run, because it forwards the removed flags. It is committed there and not pushed.

---

### Task 1: Refuse IPv6 addresses that embed a blocked IPv4 address

**Files:**
- Modify: `internal/safehttp/safehttp.go`
- Test: `internal/safehttp/safehttp_test.go`

**Interfaces:**
- Consumes: nothing new.
- Produces: `safehttp.IsDisallowedIP(net.IP) bool`, unchanged in signature and stricter in behaviour.

- [ ] **Step 1: Add the failing table cases**

In `TestIsDisallowedIP`, append these rows to `cases`, before the closing `}`:

```go
		// IPv4-mapped: the stdlib predicates already see the IPv4 address.
		{"::ffff:127.0.0.1", true},
		{"::ffff:10.0.0.1", true},
		{"::ffff:100.64.0.1", true},
		{"::ffff:8.8.8.8", false},
		// NAT64 well-known prefix: the low 32 bits are the IPv4 address.
		{"64:ff9b::7f00:1", true},   // 127.0.0.1
		{"64:ff9b::a00:1", true},    // 10.0.0.1
		{"64:ff9b::6440:1", true},   // 100.64.0.1 (CGNAT)
		{"64:ff9b::808:808", false}, // 8.8.8.8
		// NAT64 local-use prefix: refused outright.
		{"64:ff9b:1::1", true},
		// 6to4: bits 16-47 are the IPv4 address.
		{"2002:0a00:0001::", true},  // 10.0.0.1
		{"2002:7f00:0001::", true},  // 127.0.0.1
		{"2002:0808:0808::", false}, // 8.8.8.8
		// IPv4-compatible (deprecated, still parsed).
		{"::127.0.0.1", true},
		{"::10.0.0.1", true},
		{"::8.8.8.8", false},
```

Add these two tests at the end of the file. Add `"errors"` and `"time"` to the imports.

```go
func TestAlternativeIPv4LiteralsAreNotParsedAsIPs(t *testing.T) {
	// These never take DialContext's literal-IP branch. They are resolved
	// as hostnames, and what they resolve to is validated like any other
	// name. On macOS, 0177.0.0.1 resolves to 177.0.0.1 (a public address,
	// not 127.0.0.1), so it is pinned here and not dialed.
	for _, s := range []string{"0177.0.0.1", "2130706433", "0x7f.0.0.1"} {
		if ip := net.ParseIP(s); ip != nil {
			t.Errorf("net.ParseIP(%q) = %v, want nil", s, ip)
		}
	}
}

func TestDialContextRefusesLoopbackSpelledAsDecimalOrHex(t *testing.T) {
	d := DialContext(&net.Dialer{Timeout: 2 * time.Second})
	for _, host := range []string{"2130706433", "0x7f.0.0.1"} {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		conn, err := d(ctx, "tcp", net.JoinHostPort(host, "80"))
		cancel()
		if err == nil {
			conn.Close()
			t.Fatalf("dial %s: connected, want refusal", host)
		}
		// Two acceptable outcomes. Either the resolver reads the literal as
		// 127.0.0.1 (macOS does) and the blocklist refuses it, or the
		// resolver treats it as an unknown name. A connection-refused error
		// is NOT acceptable: that would mean we dialed loopback.
		var dnsErr *net.DNSError
		if !strings.Contains(err.Error(), "blocked address") && !errors.As(err, &dnsErr) {
			t.Fatalf("dial %s: %v, want a blocked-address or DNS error", host, err)
		}
	}
}
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `go test ./internal/safehttp/ -run 'TestIsDisallowedIP|TestAlternative|TestDialContextRefusesLoopbackSpelled' -count=1`
Expected: `TestIsDisallowedIP` FAILS on the NAT64, 6to4, IPv4-compatible and local-use rows (for example `IsDisallowedIP(64:ff9b::7f00:1) = false, want true`). The other two tests pass already: they pin existing behaviour.

- [ ] **Step 3: Implement**

In `internal/safehttp/safehttp.go`, replace the whole `IsDisallowedIP` function with:

```go
// IsDisallowedIP reports whether ip is one an open-host proxy must refuse to
// connect to: loopback, private (RFC1918 / ULA), link-local (incl. the
// 169.254.169.254 cloud-metadata endpoint), unspecified, multicast, and CGNAT
// (100.64.0.0/10). An IPv6 address that carries an IPv4 address (NAT64,
// 6to4, IPv4-compatible) is judged by the IPv4 address it carries.
func IsDisallowedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() {
		return true
	}
	// CGNAT 100.64.0.0/10: not covered by IsPrivate(), but effectively
	// internal for our purposes.
	if v4 := ip.To4(); v4 != nil && v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127 {
		return true
	}
	// Local-use NAT64 (RFC 8215) is by definition an operator's own
	// translation space. Where the IPv4 address sits inside it depends on
	// the operator's prefix length, so it is refused rather than decoded.
	if nat64LocalUse.Contains(ip) {
		return true
	}
	if v4 := embeddedIPv4(ip); v4 != nil {
		return IsDisallowedIP(v4)
	}
	return false
}

var (
	nat64WellKnown = mustCIDR("64:ff9b::/96")
	nat64LocalUse  = mustCIDR("64:ff9b:1::/48")
	sixToFour      = mustCIDR("2002::/16")
)

func mustCIDR(s string) *net.IPNet {
	_, n, err := net.ParseCIDR(s)
	if err != nil {
		panic(err)
	}
	return n
}

// embeddedIPv4 returns the IPv4 address an IPv6 address carries, or nil if
// it carries none. Plain IPv4 and IPv4-mapped addresses return nil: the
// stdlib predicates already see their IPv4 form through To4().
func embeddedIPv4(ip net.IP) net.IP {
	if ip.To4() != nil {
		return nil
	}
	v6 := ip.To16()
	if v6 == nil {
		return nil
	}
	switch {
	case nat64WellKnown.Contains(v6):
		return net.IPv4(v6[12], v6[13], v6[14], v6[15])
	case sixToFour.Contains(v6):
		return net.IPv4(v6[2], v6[3], v6[4], v6[5])
	case isIPv4Compatible(v6):
		return net.IPv4(v6[12], v6[13], v6[14], v6[15])
	}
	return nil
}

// isIPv4Compatible reports whether v6 has the deprecated ::a.b.c.d form.
// :: and ::1 share the all-zero prefix but are the unspecified and loopback
// addresses, which the stdlib predicates classify already.
func isIPv4Compatible(v6 net.IP) bool {
	for _, b := range v6[:12] {
		if b != 0 {
			return false
		}
	}
	return !(v6[12] == 0 && v6[13] == 0 && v6[14] == 0 && v6[15] <= 1)
}
```

- [ ] **Step 4: Run the package tests and confirm they pass**

Run: `go test ./internal/safehttp/ -count=1`
Expected: PASS.

- [ ] **Step 5: Break-check**

Temporarily replace the body of `embeddedIPv4` with `return nil`. Run `go test ./internal/safehttp/ -run TestIsDisallowedIP -count=1`. Confirm it FAILS on `64:ff9b::7f00:1`, `2002:0a00:0001::` and `::127.0.0.1`. Restore the function, re-run, and confirm PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/safehttp/safehttp.go internal/safehttp/safehttp_test.go
git commit --signoff -F - <<'EOF'
fix(safehttp): judge IPv6 addresses by the IPv4 address they carry

NAT64 (64:ff9b::/96), 6to4 (2002::/16) and IPv4-compatible (::a.b.c.d)
addresses are now decoded and checked against the IPv4 rules, and the
local-use NAT64 prefix is refused outright. Pins how decimal, hex and
octal IPv4 spellings are handled.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LdwrX6PaoHfKtDBE96EaPx
EOF
```

---
### Task 2: `ui` config section, and a config writer that keeps it

**Files:**
- Modify: `internal/config/config.go`
- Test: `internal/config/config_test.go`
- Modify: `internal/setup/setup.go` (`writeConfig` only)
- Test: `internal/setup/setup_test.go`

**Interfaces:**
- Produces:
  - `config.Config.UI config.UIConfig`
  - `type UIConfig struct { Password string; HTTPSPort int; AllowedHosts []string; TLS UITLSConfig }`
  - `type UITLSConfig struct { CertFile, KeyFile string }`
  - `func (UIConfig) RemoteEnabled() bool`
  - `const config.DefaultHTTPSPort = 8476`
  - `func config.PermissionsTooOpen(path string) (bool, error)`
  - `setup.writeConfig` now persists `ui` and always leaves the file 0600.

- [ ] **Step 1: Write the failing config tests**

Append to `internal/config/config_test.go`:

```go
func TestLoadUISection(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	home, _ := os.UserHomeDir()
	path := filepath.Join(dir, "worktree", "config.yaml")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	data := []byte(`
ui:
  password: "hunter2"
  allowed_hosts: ["mturley-mac.local", "192.168.86.21"]
  tls:
    cert_file: ~/.config/worktree/ui-cert.pem
    key_file: ~/.config/worktree/ui-key.pem
`)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.UI.Password != "hunter2" {
		t.Errorf("Password = %q", cfg.UI.Password)
	}
	if cfg.UI.HTTPSPort != DefaultHTTPSPort {
		t.Errorf("HTTPSPort = %d, want default %d", cfg.UI.HTTPSPort, DefaultHTTPSPort)
	}
	if len(cfg.UI.AllowedHosts) != 2 || cfg.UI.AllowedHosts[0] != "mturley-mac.local" {
		t.Errorf("AllowedHosts = %v", cfg.UI.AllowedHosts)
	}
	if want := filepath.Join(home, ".config/worktree/ui-cert.pem"); cfg.UI.TLS.CertFile != want {
		t.Errorf("CertFile = %q, want %q (~ expanded)", cfg.UI.TLS.CertFile, want)
	}
	if want := filepath.Join(home, ".config/worktree/ui-key.pem"); cfg.UI.TLS.KeyFile != want {
		t.Errorf("KeyFile = %q, want %q (~ expanded)", cfg.UI.TLS.KeyFile, want)
	}
	if !cfg.UI.RemoteEnabled() {
		t.Error("RemoteEnabled() = false with both TLS files set")
	}
}

func TestRemoteEnabledRequiresBothFiles(t *testing.T) {
	for _, tc := range []struct {
		tls  UITLSConfig
		want bool
	}{
		{UITLSConfig{}, false},
		{UITLSConfig{CertFile: "c"}, false},
		{UITLSConfig{KeyFile: "k"}, false},
		{UITLSConfig{CertFile: "c", KeyFile: "k"}, true},
	} {
		if got := (UIConfig{TLS: tc.tls}).RemoteEnabled(); got != tc.want {
			t.Errorf("RemoteEnabled(%+v) = %v, want %v", tc.tls, got, tc.want)
		}
	}
}

func TestPermissionsTooOpen(t *testing.T) {
	dir := t.TempDir()
	for _, tc := range []struct {
		mode os.FileMode
		want bool
	}{{0o600, false}, {0o640, true}, {0o644, true}, {0o604, true}} {
		p := filepath.Join(dir, tc.mode.String())
		if err := os.WriteFile(p, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(p, tc.mode); err != nil {
			t.Fatal(err)
		}
		got, err := PermissionsTooOpen(p)
		if err != nil || got != tc.want {
			t.Errorf("PermissionsTooOpen(%v) = %v, %v; want %v", tc.mode, got, err, tc.want)
		}
	}
	got, err := PermissionsTooOpen(filepath.Join(dir, "missing"))
	if err != nil || got {
		t.Errorf("missing file: got %v, %v; want false, nil", got, err)
	}
}
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `go test ./internal/config/ -count=1`
Expected: FAIL to compile, with `cfg.UI undefined` and `undefined: UIConfig`.

- [ ] **Step 3: Implement in `internal/config/config.go`**

Replace the `Config` struct and `DefaultConfig` with:

```go
type Config struct {
	WorktreesBase string     `yaml:"worktrees_base"`
	Jira          JiraConfig `yaml:"jira"`
	Editor        string     `yaml:"editor"`
	UI            UIConfig   `yaml:"ui"`
}

// DefaultHTTPSPort is the port the web UI's HTTPS listener binds when
// ui.https_port is unset. The plain-HTTP listener keeps its own --port.
const DefaultHTTPSPort = 8476

// UIConfig holds the web UI's authentication and remote-access settings.
type UIConfig struct {
	// Password is required: `worktree ui` refuses to start without it.
	Password  string `yaml:"password"`
	HTTPSPort int    `yaml:"https_port"`
	// AllowedHosts are the names and IPs other devices use to reach this
	// machine. They are both the certificate's SANs and the Host allowlist,
	// beyond the loopback names that are always allowed.
	AllowedHosts []string    `yaml:"allowed_hosts"`
	TLS          UITLSConfig `yaml:"tls"`
}

type UITLSConfig struct {
	CertFile string `yaml:"cert_file"`
	KeyFile  string `yaml:"key_file"`
}

// RemoteEnabled reports whether the HTTPS listener for other devices is
// configured. Half a configuration is not enabled; `worktree ui` reports it
// as an error.
func (u UIConfig) RemoteEnabled() bool {
	return u.TLS.CertFile != "" && u.TLS.KeyFile != ""
}

func DefaultConfig() Config {
	home, _ := os.UserHomeDir()
	return Config{
		WorktreesBase: filepath.Join(home, ".worktrees"),
		Jira:          JiraConfig{},
		UI:            UIConfig{HTTPSPort: DefaultHTTPSPort},
	}
}
```

In `Load`, after `cfg.WorktreesBase = expandHome(cfg.WorktreesBase)`, add:

```go
	cfg.UI.TLS.CertFile = expandHome(cfg.UI.TLS.CertFile)
	cfg.UI.TLS.KeyFile = expandHome(cfg.UI.TLS.KeyFile)
	if cfg.UI.HTTPSPort == 0 {
		cfg.UI.HTTPSPort = DefaultHTTPSPort
	}
```

Append to the file, and add `"errors"` and `"io/fs"` to the imports:

```go
// PermissionsTooOpen reports whether the file at path grants any access to
// group or other. A missing file is not an error: there is nothing to expose.
func PermissionsTooOpen(path string) (bool, error) {
	info, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return info.Mode().Perm()&0o077 != 0, nil
}
```

- [ ] **Step 4: Run the config tests and confirm they pass**

Run: `go test ./internal/config/ -count=1`
Expected: PASS.

- [ ] **Step 5: Write the failing writer tests**

Append to `internal/setup/setup_test.go`:

```go
func TestWriteConfigPreservesUISection(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	path := config.ConfigPath()

	cfg := config.DefaultConfig()
	cfg.UI.Password = "s3cret"
	cfg.UI.AllowedHosts = []string{"mturley-mac.local", "192.168.86.21"}
	cfg.UI.HTTPSPort = 9443
	cfg.UI.TLS = config.UITLSConfig{
		CertFile: filepath.Join(dir, "ui-cert.pem"),
		KeyFile:  filepath.Join(dir, "ui-key.pem"),
	}
	if err := writeConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	got, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if got.UI.Password != "s3cret" || got.UI.HTTPSPort != 9443 ||
		strings.Join(got.UI.AllowedHosts, ",") != "mturley-mac.local,192.168.86.21" ||
		got.UI.TLS != cfg.UI.TLS {
		t.Fatalf("round-tripped UI = %+v, want %+v", got.UI, cfg.UI)
	}
}

func TestWriteConfigOmitsEmptyUISection(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := writeConfig(path, config.DefaultConfig()); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if strings.Contains(string(data), "ui:") {
		t.Fatalf("default config should not write a ui section, got:\n%s", data)
	}
}

func TestWriteConfigIsOwnerOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	// An existing, looser file: os.WriteFile alone would keep its mode.
	if err := os.WriteFile(path, []byte("worktrees_base: /x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := config.DefaultConfig()
	cfg.UI.Password = "s3cret"
	if err := writeConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("config mode = %v, want 0600", perm)
	}
}
```

- [ ] **Step 6: Run them and confirm they fail**

Run: `go test ./internal/setup/ -run 'TestWriteConfig' -count=1`
Expected: `TestWriteConfigPreservesUISection` FAILS with the round-tripped UI empty; `TestWriteConfigIsOwnerOnly` FAILS with `config mode = -rw-r--r--, want 0600`.

- [ ] **Step 7: Implement `writeConfig`**

Replace the whole `writeConfig` function in `internal/setup/setup.go` with:

```go
func writeConfig(path string, cfg config.Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}

	home, _ := os.UserHomeDir()

	type jiraYaml struct {
		Projects []string `yaml:"projects,omitempty"`
	}

	type uiTLSYaml struct {
		CertFile string `yaml:"cert_file,omitempty"`
		KeyFile  string `yaml:"key_file,omitempty"`
	}

	type uiYaml struct {
		Password     string     `yaml:"password,omitempty"`
		HTTPSPort    int        `yaml:"https_port,omitempty"`
		AllowedHosts []string   `yaml:"allowed_hosts,omitempty"`
		TLS          *uiTLSYaml `yaml:"tls,omitempty"`
	}

	type yamlConfig struct {
		WorktreesBase string   `yaml:"worktrees_base"`
		Editor        string   `yaml:"editor,omitempty"`
		Jira          jiraYaml `yaml:"jira,omitempty"`
		UI            *uiYaml  `yaml:"ui,omitempty"`
	}

	yc := yamlConfig{
		WorktreesBase: shortenHome(cfg.WorktreesBase, home),
		Editor:        cfg.Editor,
	}

	if len(cfg.Jira.Projects) > 0 {
		yc.Jira = jiraYaml{
			Projects: cfg.Jira.Projects,
		}
	}

	// Every ui field must be carried here: a field left out is silently
	// dropped from the file the next time setup writes it.
	u := uiYaml{Password: cfg.UI.Password, AllowedHosts: cfg.UI.AllowedHosts}
	if cfg.UI.HTTPSPort != 0 && cfg.UI.HTTPSPort != config.DefaultHTTPSPort {
		u.HTTPSPort = cfg.UI.HTTPSPort
	}
	if cfg.UI.TLS.CertFile != "" || cfg.UI.TLS.KeyFile != "" {
		u.TLS = &uiTLSYaml{
			CertFile: shortenHome(cfg.UI.TLS.CertFile, home),
			KeyFile:  shortenHome(cfg.UI.TLS.KeyFile, home),
		}
	}
	if u.Password != "" || u.HTTPSPort != 0 || len(u.AllowedHosts) > 0 || u.TLS != nil {
		yc.UI = &u
	}

	data, err := yaml.Marshal(yc)
	if err != nil {
		return err
	}
	// Owner-only: the file holds the web UI password. WriteFile keeps an
	// existing file's mode, so tighten it explicitly as well.
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}
```

- [ ] **Step 8: Run all tests and confirm they pass**

Run: `go test ./internal/config/ ./internal/setup/ -count=1`
Expected: PASS, including the pre-existing `TestWriteConfigOnlyWritesJiraProjects`.

- [ ] **Step 9: Commit**

```bash
git add internal/config/config.go internal/config/config_test.go internal/setup/setup.go internal/setup/setup_test.go
git commit --signoff -F - <<'EOF'
feat(config): add the ui section and write the config owner-only

Adds ui.password, ui.https_port, ui.allowed_hosts and ui.tls, and makes
setup's config writer carry them so a later setup run cannot drop them.
The config file is now always written 0600.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LdwrX6PaoHfKtDBE96EaPx
EOF
```

---
### Task 3: Session store

**Files:**
- Modify: `internal/db/migrate.go`
- Create: `internal/uisession/uisession.go`
- Create: `internal/uisession/label.go`
- Test: `internal/uisession/uisession_test.go`
- Test: `internal/uisession/label_test.go`

**Interfaces:**
- Produces (package `uisession`):
  - `const Lifetime = 30 * 24 * time.Hour`, `const TouchInterval = 5 * time.Minute`
  - `type Session struct { Handle, Label string; CreatedAt, LastSeenAt, ExpiresAt time.Time }`
  - `type Store struct { DB *sql.DB; Now func() time.Time }`
  - `func HandleFor(token string) string`
  - `func (*Store) Create(label string) (token string, sess Session, err error)`
  - `func (*Store) Lookup(token string) (Session, bool, error)`
  - `func (*Store) Touch(sess Session) (wrote bool, err error)`
  - `func (*Store) Revoke(handle string) (bool, error)`
  - `func (*Store) RevokeAll() (int64, error)`
  - `func (*Store) List() ([]Session, error)`: live sessions, newest first
  - `func (*Store) DeleteExpired() (int64, error)`
  - `func Label(userAgent string) string`

- [ ] **Step 1: Add the table**

In `internal/db/migrate.go`, append this entry to the `stmts` slice, after the `resource_read_cursor` statement:

```go
		// Web UI login sessions. token_hash is the SHA-256 of the cookie
		// value, never the value itself, so reading this table never yields
		// a usable login. Timestamps use a fixed-width UTC layout, so string
		// comparison in SQL orders them correctly.
		`CREATE TABLE IF NOT EXISTS ui_sessions (
			token_hash   TEXT PRIMARY KEY,
			label        TEXT NOT NULL,
			created_at   TEXT NOT NULL,
			last_seen_at TEXT NOT NULL,
			expires_at   TEXT NOT NULL
		)`,
```

- [ ] **Step 2: Write the failing store tests**

Create `internal/uisession/uisession_test.go`:

```go
package uisession

import (
	"path/filepath"
	"testing"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
)

// clock is a settable time source for Store.Now.
type clock struct{ t time.Time }

func (c *clock) now() time.Time         { return c.t }
func (c *clock) advance(d time.Duration) { c.t = c.t.Add(d) }

func newStore(t *testing.T) (*Store, *clock) {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	c := &clock{t: time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)}
	return &Store{DB: conn, Now: c.now}, c
}

func TestCreateThenLookup(t *testing.T) {
	s, _ := newStore(t)
	token, sess, err := s.Create("Mac — Chrome")
	if err != nil {
		t.Fatal(err)
	}
	if len(token) < 40 {
		t.Fatalf("token %q is too short to be 32 random bytes", token)
	}
	got, ok, err := s.Lookup(token)
	if err != nil || !ok {
		t.Fatalf("Lookup = %v, %v", ok, err)
	}
	if got.Handle != sess.Handle || got.Label != "Mac — Chrome" {
		t.Fatalf("Lookup returned %+v, want %+v", got, sess)
	}
	if !got.ExpiresAt.Equal(got.CreatedAt.Add(Lifetime)) {
		t.Fatalf("ExpiresAt = %v, want CreatedAt + 30 days", got.ExpiresAt)
	}
}

func TestTokenIsNeverStored(t *testing.T) {
	s, _ := newStore(t)
	token, _, err := s.Create("x")
	if err != nil {
		t.Fatal(err)
	}
	var n int
	err = s.DB.QueryRow(`SELECT COUNT(*) FROM ui_sessions
		WHERE token_hash = ? OR label = ? OR created_at = ? OR last_seen_at = ? OR expires_at = ?`,
		token, token, token, token, token).Scan(&n)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("the raw token appears in ui_sessions")
	}
	if HandleFor(token) == token {
		t.Fatal("HandleFor returned the token unchanged")
	}
}

func TestLookupUnknownAndEmptyTokens(t *testing.T) {
	s, _ := newStore(t)
	for _, tok := range []string{"", "not-a-token"} {
		if _, ok, err := s.Lookup(tok); ok || err != nil {
			t.Errorf("Lookup(%q) = %v, %v; want false, nil", tok, ok, err)
		}
	}
}

func TestRevokedSessionIsGone(t *testing.T) {
	s, _ := newStore(t)
	token, sess, _ := s.Create("a")
	other, _, _ := s.Create("b")
	if ok, err := s.Revoke(sess.Handle); !ok || err != nil {
		t.Fatalf("Revoke = %v, %v", ok, err)
	}
	if _, ok, _ := s.Lookup(token); ok {
		t.Fatal("revoked session still looks up")
	}
	if _, ok, _ := s.Lookup(other); !ok {
		t.Fatal("revoking one session removed another")
	}
	if ok, _ := s.Revoke(sess.Handle); ok {
		t.Fatal("revoking twice reported success")
	}
}

func TestExpiredSessionIsRefusedAndDeleted(t *testing.T) {
	s, c := newStore(t)
	token, _, _ := s.Create("a")
	c.advance(Lifetime)
	if _, ok, _ := s.Lookup(token); ok {
		t.Fatal("session still valid at its expiry instant")
	}
	n, err := s.DeleteExpired()
	if err != nil || n != 1 {
		t.Fatalf("DeleteExpired = %d, %v; want 1", n, err)
	}
}

func TestTouchIsThrottled(t *testing.T) {
	s, c := newStore(t)
	token, sess, _ := s.Create("a")

	c.advance(TouchInterval - time.Second)
	if wrote, err := s.Touch(sess); wrote || err != nil {
		t.Fatalf("Touch inside the interval = %v, %v; want no write", wrote, err)
	}
	got, _, _ := s.Lookup(token)
	if !got.LastSeenAt.Equal(sess.LastSeenAt) {
		t.Fatalf("LastSeenAt changed to %v inside the throttle window", got.LastSeenAt)
	}

	c.advance(time.Second)
	if wrote, err := s.Touch(got); !wrote || err != nil {
		t.Fatalf("Touch at the interval = %v, %v; want a write", wrote, err)
	}
	got, _, _ = s.Lookup(token)
	if !got.LastSeenAt.Equal(c.now()) {
		t.Fatalf("LastSeenAt = %v, want %v", got.LastSeenAt, c.now())
	}
}

func TestListIsLiveSessionsNewestFirst(t *testing.T) {
	s, c := newStore(t)
	_, old, _ := s.Create("old")
	c.advance(time.Hour)
	_, mid, _ := s.Create("mid")
	c.advance(time.Hour)
	_, newest, _ := s.Create("new")
	c.advance(Lifetime - 90*time.Minute) // old has expired; mid and new have not
	list, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].Handle != newest.Handle || list[1].Handle != mid.Handle {
		t.Fatalf("List = %+v, want [new, mid] without %s", list, old.Handle)
	}
}

func TestRevokeAll(t *testing.T) {
	s, _ := newStore(t)
	s.Create("a")
	s.Create("b")
	n, err := s.RevokeAll()
	if err != nil || n != 2 {
		t.Fatalf("RevokeAll = %d, %v; want 2", n, err)
	}
	if list, _ := s.List(); len(list) != 0 {
		t.Fatalf("List after RevokeAll = %v", list)
	}
}
```

Create `internal/uisession/label_test.go`:

```go
package uisession

import (
	"strings"
	"testing"
)

func TestLabel(t *testing.T) {
	cases := map[string]string{
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36": "Mac — Chrome",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15": "Mac — Safari",
		"Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36": "Android — Chrome",
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1": "iPhone — Safari",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0": "Windows — Edge",
		"Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0": "Linux — Firefox",
		"":            "Unknown device",
		"curl/8.7.1":  "curl/8.7.1",
	}
	for ua, want := range cases {
		if got := Label(ua); got != want {
			t.Errorf("Label(%q) = %q, want %q", ua, got, want)
		}
	}
}

func TestLabelTruncatesUnrecognisedAgents(t *testing.T) {
	got := Label(strings.Repeat("x", 500))
	if len([]rune(got)) != maxLabelLen {
		t.Fatalf("label length %d, want %d", len([]rune(got)), maxLabelLen)
	}
}
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `go test ./internal/uisession/ -count=1`
Expected: FAIL to compile, with `undefined: Store`.

- [ ] **Step 4: Implement the store**

Create `internal/uisession/uisession.go`:

```go
// Package uisession stores the web UI's login sessions in worktree's own
// database. The cookie carries a random token; the table holds only its
// SHA-256, called the session's handle, which is also what the UI uses to
// name a session when revoking it.
package uisession

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"time"
)

const (
	// Lifetime is how long a session lasts from login. It does not slide.
	Lifetime = 30 * 24 * time.Hour
	// TouchInterval is the minimum age of last_seen_at before a request
	// rewrites it. A write per request would put the database on the path
	// of every image load.
	TouchInterval = 5 * time.Minute
)

// tsLayout is fixed-width so that stored timestamps sort as strings.
const tsLayout = "2006-01-02T15:04:05.000000000Z"

type Session struct {
	Handle     string
	Label      string
	CreatedAt  time.Time
	LastSeenAt time.Time
	ExpiresAt  time.Time
}

type Store struct {
	DB *sql.DB
	// Now is the clock; nil means time.Now. A seam for tests.
	Now func() time.Time
}

func (s *Store) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

// HandleFor returns the handle of a token: its hex SHA-256.
func HandleFor(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// Create starts a session. The token goes in the cookie and is not kept.
func (s *Store) Create(label string) (string, Session, error) {
	token, err := newToken()
	if err != nil {
		return "", Session{}, err
	}
	now := s.now()
	sess := Session{
		Handle:     HandleFor(token),
		Label:      label,
		CreatedAt:  now,
		LastSeenAt: now,
		ExpiresAt:  now.Add(Lifetime),
	}
	_, err = s.DB.Exec(`INSERT INTO ui_sessions
		(token_hash, label, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
		sess.Handle, sess.Label, now.Format(tsLayout), now.Format(tsLayout),
		sess.ExpiresAt.Format(tsLayout))
	if err != nil {
		return "", Session{}, err
	}
	return token, sess, nil
}

// Lookup returns the live session for a token. An empty, unknown, revoked
// or expired token reports false with a nil error.
func (s *Store) Lookup(token string) (Session, bool, error) {
	if token == "" {
		return Session{}, false, nil
	}
	row := s.DB.QueryRow(`SELECT token_hash, label, created_at, last_seen_at, expires_at
		FROM ui_sessions WHERE token_hash = ?`, HandleFor(token))
	sess, err := scanSession(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, false, nil
	}
	if err != nil {
		return Session{}, false, err
	}
	if !s.now().Before(sess.ExpiresAt) {
		return Session{}, false, nil
	}
	return sess, true, nil
}

// Touch records use of sess, but only once last_seen_at is at least
// TouchInterval old. It reports whether it wrote.
func (s *Store) Touch(sess Session) (bool, error) {
	now := s.now()
	if now.Sub(sess.LastSeenAt) < TouchInterval {
		return false, nil
	}
	if _, err := s.DB.Exec(`UPDATE ui_sessions SET last_seen_at = ? WHERE token_hash = ?`,
		now.Format(tsLayout), sess.Handle); err != nil {
		return false, err
	}
	return true, nil
}

// Revoke deletes one session by handle and reports whether it existed.
func (s *Store) Revoke(handle string) (bool, error) {
	res, err := s.DB.Exec(`DELETE FROM ui_sessions WHERE token_hash = ?`, handle)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// RevokeAll deletes every session, logging out every device.
func (s *Store) RevokeAll() (int64, error) {
	res, err := s.DB.Exec(`DELETE FROM ui_sessions`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// List returns the live sessions, newest first.
func (s *Store) List() ([]Session, error) {
	rows, err := s.DB.Query(`SELECT token_hash, label, created_at, last_seen_at, expires_at
		FROM ui_sessions WHERE expires_at > ? ORDER BY created_at DESC`,
		s.now().Format(tsLayout))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Session
	for rows.Next() {
		sess, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sess)
	}
	return out, rows.Err()
}

// DeleteExpired removes sessions past their expiry.
func (s *Store) DeleteExpired() (int64, error) {
	res, err := s.DB.Exec(`DELETE FROM ui_sessions WHERE expires_at <= ?`, s.now().Format(tsLayout))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func scanSession(r interface{ Scan(...any) error }) (Session, error) {
	var sess Session
	var created, seen, expires string
	if err := r.Scan(&sess.Handle, &sess.Label, &created, &seen, &expires); err != nil {
		return Session{}, err
	}
	var err error
	if sess.CreatedAt, err = time.Parse(tsLayout, created); err != nil {
		return Session{}, err
	}
	if sess.LastSeenAt, err = time.Parse(tsLayout, seen); err != nil {
		return Session{}, err
	}
	if sess.ExpiresAt, err = time.Parse(tsLayout, expires); err != nil {
		return Session{}, err
	}
	return sess, nil
}
```

- [ ] **Step 5: Implement the label**

Create `internal/uisession/label.go`:

```go
package uisession

import "strings"

const maxLabelLen = 80

// Label names a session after the device and browser that logged in, e.g.
// "Mac — Chrome", so the list of devices is legible. Best-effort: an agent it
// does not recognise is kept verbatim, truncated.
func Label(userAgent string) string {
	ua := userAgent
	// Order matters: Android agents also say "Linux", Chrome and Edge
	// agents also say "Safari", and Edge agents also say "Chrome".
	var device string
	switch {
	case strings.Contains(ua, "iPhone"):
		device = "iPhone"
	case strings.Contains(ua, "iPad"):
		device = "iPad"
	case strings.Contains(ua, "Android"):
		device = "Android"
	case strings.Contains(ua, "Macintosh"):
		device = "Mac"
	case strings.Contains(ua, "Windows"):
		device = "Windows"
	case strings.Contains(ua, "Linux"):
		device = "Linux"
	}
	var browser string
	switch {
	case strings.Contains(ua, "Edg/"):
		browser = "Edge"
	case strings.Contains(ua, "Firefox/"), strings.Contains(ua, "FxiOS/"):
		browser = "Firefox"
	case strings.Contains(ua, "Chrome/"), strings.Contains(ua, "CriOS/"):
		browser = "Chrome"
	case strings.Contains(ua, "Safari/"):
		browser = "Safari"
	}
	if device != "" && browser != "" {
		return device + " — " + browser
	}
	ua = strings.TrimSpace(ua)
	if ua == "" {
		return "Unknown device"
	}
	if r := []rune(ua); len(r) > maxLabelLen {
		return string(r[:maxLabelLen])
	}
	return ua
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `go test ./internal/uisession/ ./internal/db/ -count=1`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/db/migrate.go internal/uisession/uisession.go internal/uisession/label.go internal/uisession/uisession_test.go internal/uisession/label_test.go
git commit --signoff -F - <<'EOF'
feat(uisession): add a database-backed store for web UI sessions

Sessions are keyed by the SHA-256 of the cookie token, expire 30 days
after login, rewrite last_seen_at at most every five minutes, and can be
revoked one at a time or all at once.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LdwrX6PaoHfKtDBE96EaPx
EOF
```

---
### Task 4: Certificate issuance from a CA whose key is never written

**Files:**
- Create: `internal/uitls/uitls.go`
- Test: `internal/uitls/uitls_test.go`

**Interfaces:**
- Produces (package `uitls`):
  - `const CAValidity = 400 * 24 * time.Hour`, `const LeafValidity = 397 * 24 * time.Hour`, `const CACommonName = "worktree local UI CA"`
  - `type Bundle struct { CACertPEM, CertPEM, KeyPEM []byte; NotAfter time.Time }`
  - `type Paths struct { CA, Cert, Key string }`
  - `func DefaultPaths(dir string) Paths`: `ui-ca.pem`, `ui-cert.pem`, `ui-key.pem` inside `dir`
  - `func Generate(hosts []string, now time.Time) (Bundle, error)`
  - `func Write(p Paths, b Bundle) error`
  - `func Remove(p Paths) (removed []string, err error)`
  - `func ReadCert(path string) (*x509.Certificate, error)`
  - `func Uncovered(cert *x509.Certificate, names []string) []string`

- [ ] **Step 1: Write the failing tests**

Create `internal/uitls/uitls_test.go`:

```go
package uitls

import (
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/pem"
	"net"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"
)

var now = time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)

func parseCert(t *testing.T, pemBytes []byte) *x509.Certificate {
	t.Helper()
	block, _ := pem.Decode(pemBytes)
	if block == nil || block.Type != "CERTIFICATE" {
		t.Fatalf("not a certificate PEM: %q", pemBytes)
	}
	c, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestGenerateLeafNamesAndUsage(t *testing.T) {
	b, err := Generate([]string{"mturley-mac.local", "192.168.86.21"}, now)
	if err != nil {
		t.Fatal(err)
	}
	leaf := parseCert(t, b.CertPEM)
	for _, name := range []string{"localhost", "mturley-mac.local"} {
		if !slices.Contains(leaf.DNSNames, name) {
			t.Errorf("DNSNames %v missing %q", leaf.DNSNames, name)
		}
	}
	for _, ip := range []string{"127.0.0.1", "::1", "192.168.86.21"} {
		if !slices.ContainsFunc(leaf.IPAddresses, func(got net.IP) bool { return got.Equal(net.ParseIP(ip)) }) {
			t.Errorf("IPAddresses %v missing %s", leaf.IPAddresses, ip)
		}
	}
	if slices.Contains(leaf.DNSNames, "192.168.86.21") {
		t.Error("an IP was written as a DNS SAN; browsers only match IPs against IP SANs")
	}
	if len(leaf.ExtKeyUsage) != 1 || leaf.ExtKeyUsage[0] != x509.ExtKeyUsageServerAuth {
		t.Errorf("ExtKeyUsage = %v, want [serverAuth]", leaf.ExtKeyUsage)
	}
	if leaf.IsCA {
		t.Error("leaf is a CA")
	}
}

func TestGenerateDeduplicatesNames(t *testing.T) {
	b, err := Generate([]string{"localhost", "127.0.0.1", "mturley-mac.local", "MTURLEY-MAC.local"}, now)
	if err != nil {
		t.Fatal(err)
	}
	leaf := parseCert(t, b.CertPEM)
	if len(leaf.DNSNames) != 2 || len(leaf.IPAddresses) != 2 {
		t.Fatalf("DNSNames %v, IPAddresses %v; want no duplicates", leaf.DNSNames, leaf.IPAddresses)
	}
}

func TestGenerateValidity(t *testing.T) {
	b, err := Generate(nil, now)
	if err != nil {
		t.Fatal(err)
	}
	leaf, ca := parseCert(t, b.CertPEM), parseCert(t, b.CACertPEM)
	if got := leaf.NotAfter.Sub(now); got != LeafValidity {
		t.Errorf("leaf lifetime from now = %v, want %v", got, LeafValidity)
	}
	if span := leaf.NotAfter.Sub(leaf.NotBefore); span >= 398*24*time.Hour {
		t.Errorf("leaf validity span %v reaches the 398-day browser ceiling", span)
	}
	if got := ca.NotAfter.Sub(now); got != CAValidity {
		t.Errorf("CA lifetime from now = %v, want %v", got, CAValidity)
	}
	if !b.NotAfter.Equal(leaf.NotAfter) {
		t.Errorf("Bundle.NotAfter = %v, want the leaf's %v", b.NotAfter, leaf.NotAfter)
	}
}

func TestCAIsASingleLevelCA(t *testing.T) {
	b, err := Generate(nil, now)
	if err != nil {
		t.Fatal(err)
	}
	ca := parseCert(t, b.CACertPEM)
	if !ca.IsCA || !ca.BasicConstraintsValid {
		t.Fatal("CA certificate lacks basicConstraints CA:TRUE, which Android's user store requires")
	}
	if ca.MaxPathLen != 0 || !ca.MaxPathLenZero {
		t.Errorf("MaxPathLen = %d (zero=%v), want 0: the CA may sign leaves only", ca.MaxPathLen, ca.MaxPathLenZero)
	}
	if ca.Subject.CommonName != CACommonName {
		t.Errorf("CA CN = %q, want %q", ca.Subject.CommonName, CACommonName)
	}
}

func TestLeafVerifiesAgainstItsOwnCAOnly(t *testing.T) {
	b, err := Generate([]string{"mturley-mac.local"}, now)
	if err != nil {
		t.Fatal(err)
	}
	other, err := Generate([]string{"mturley-mac.local"}, now)
	if err != nil {
		t.Fatal(err)
	}
	leaf := parseCert(t, b.CertPEM)
	verify := func(caPEM []byte) error {
		pool := x509.NewCertPool()
		pool.AppendCertsFromPEM(caPEM)
		_, err := leaf.Verify(x509.VerifyOptions{Roots: pool, DNSName: "mturley-mac.local", CurrentTime: now})
		return err
	}
	if err := verify(b.CACertPEM); err != nil {
		t.Fatalf("leaf does not verify against its own CA: %v", err)
	}
	if err := verify(other.CACertPEM); err == nil {
		t.Fatal("leaf verified against an unrelated CA")
	}
}

func TestWriteLeavesNoCAPrivateKeyOnDisk(t *testing.T) {
	dir := t.TempDir()
	b, err := Generate([]string{"mturley-mac.local"}, now)
	if err != nil {
		t.Fatal(err)
	}
	p := DefaultPaths(dir)
	if err := Write(p, b); err != nil {
		t.Fatal(err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	if strings.Join(names, ",") != "ui-ca.pem,ui-cert.pem,ui-key.pem" {
		t.Fatalf("directory holds %v, want exactly the three files", names)
	}

	// Every private key on disk, across every file, must belong to the leaf.
	// This is the property the design rests on: the CA can never sign again.
	leaf := parseCert(t, b.CertPEM)
	var keys int
	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		for rest := data; ; {
			var block *pem.Block
			block, rest = pem.Decode(rest)
			if block == nil {
				break
			}
			if !strings.Contains(block.Type, "PRIVATE KEY") {
				continue
			}
			keys++
			key, err := x509.ParseECPrivateKey(block.Bytes)
			if err != nil {
				t.Fatalf("%s: unparseable private key: %v", name, err)
			}
			if !key.PublicKey.Equal(leaf.PublicKey.(*ecdsa.PublicKey)) {
				t.Fatalf("%s holds a private key that is not the leaf's", name)
			}
		}
	}
	if keys != 1 {
		t.Fatalf("found %d private keys on disk, want exactly 1 (the leaf's)", keys)
	}

	for name, want := range map[string]os.FileMode{"ui-key.pem": 0o600, "ui-cert.pem": 0o644, "ui-ca.pem": 0o644} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != want {
			t.Errorf("%s mode = %v, want %v", name, got, want)
		}
	}
}

func TestWriteTightensAnExistingLooseKeyFile(t *testing.T) {
	dir := t.TempDir()
	p := DefaultPaths(dir)
	if err := os.WriteFile(p.Key, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	b, _ := Generate(nil, now)
	if err := Write(p, b); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(p.Key)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("key mode = %v, want 0600", info.Mode().Perm())
	}
}

func TestRemove(t *testing.T) {
	dir := t.TempDir()
	p := DefaultPaths(dir)
	b, _ := Generate(nil, now)
	if err := Write(p, b); err != nil {
		t.Fatal(err)
	}
	removed, err := Remove(p)
	if err != nil || len(removed) != 3 {
		t.Fatalf("Remove = %v, %v; want three files", removed, err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("directory still holds %v", entries)
	}
	removed, err = Remove(p)
	if err != nil || len(removed) != 0 {
		t.Fatalf("second Remove = %v, %v; want nothing and no error", removed, err)
	}
}

func TestReadCertAndUncovered(t *testing.T) {
	dir := t.TempDir()
	p := DefaultPaths(dir)
	b, _ := Generate([]string{"mturley-mac.local", "192.168.86.21"}, now)
	if err := Write(p, b); err != nil {
		t.Fatal(err)
	}
	cert, err := ReadCert(p.Cert)
	if err != nil {
		t.Fatal(err)
	}
	got := Uncovered(cert, []string{"mturley-mac.local", "192.168.86.21", "192.168.1.50", "other.local"})
	if strings.Join(got, ",") != "192.168.1.50,other.local" {
		t.Fatalf("Uncovered = %v", got)
	}
}
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `go test ./internal/uitls/ -count=1`
Expected: FAIL to compile, with `undefined: Generate`.

- [ ] **Step 3: Implement**

Create `internal/uitls/uitls.go`:

```go
// Package uitls issues the web UI's HTTPS certificate.
//
// It creates a CA and, in the same call, uses it to sign exactly one server
// certificate. The CA's private key is a local variable of Generate and is
// never serialised: once Generate returns, nothing can sign another
// certificate under that CA. The phone trusts a CA (Android's user store
// accepts nothing else), but that CA's reach is the one leaf it already
// signed.
package uitls

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"io/fs"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	CAValidity   = 400 * 24 * time.Hour
	LeafValidity = 397 * 24 * time.Hour
	CACommonName = "worktree local UI CA"
)

// loopbackNames are in every leaf, so the HTTPS listener also works from the
// machine itself.
var loopbackNames = []string{"localhost", "127.0.0.1", "::1"}

type Bundle struct {
	CACertPEM []byte
	CertPEM   []byte
	KeyPEM    []byte // the leaf's key; there is no CA key to return
	NotAfter  time.Time
}

type Paths struct {
	CA   string
	Cert string
	Key  string
}

func DefaultPaths(dir string) Paths {
	return Paths{
		CA:   filepath.Join(dir, "ui-ca.pem"),
		Cert: filepath.Join(dir, "ui-cert.pem"),
		Key:  filepath.Join(dir, "ui-key.pem"),
	}
}

// Generate creates a CA and one server certificate for the loopback names
// plus hosts. An IP in hosts becomes an IP SAN and anything else a DNS SAN.
func Generate(hosts []string, now time.Time) (Bundle, error) {
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return Bundle{}, err
	}
	caSerial, err := serialNumber()
	if err != nil {
		return Bundle{}, err
	}
	caTmpl := &x509.Certificate{
		SerialNumber:          caSerial,
		Subject:               pkix.Name{CommonName: CACommonName},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(CAValidity),
		IsCA:                  true,
		BasicConstraintsValid: true,
		MaxPathLen:            0,
		MaxPathLenZero:        true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	if err != nil {
		return Bundle{}, err
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		return Bundle{}, err
	}

	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return Bundle{}, err
	}
	leafSerial, err := serialNumber()
	if err != nil {
		return Bundle{}, err
	}
	leafTmpl := &x509.Certificate{
		SerialNumber: leafSerial,
		Subject:      pkix.Name{CommonName: "worktree UI"},
		// An hour of back-dating tolerates a phone clock slightly behind.
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(LeafValidity),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	seen := map[string]bool{}
	for _, h := range append(append([]string{}, loopbackNames...), hosts...) {
		h = strings.TrimSpace(h)
		if h == "" {
			continue
		}
		if ip := net.ParseIP(h); ip != nil {
			key := ip.String()
			if !seen[key] {
				seen[key] = true
				leafTmpl.IPAddresses = append(leafTmpl.IPAddresses, ip)
			}
			continue
		}
		key := strings.ToLower(h)
		if !seen[key] {
			seen[key] = true
			leafTmpl.DNSNames = append(leafTmpl.DNSNames, h)
		}
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTmpl, caCert, &leafKey.PublicKey, caKey)
	if err != nil {
		return Bundle{}, err
	}
	keyDER, err := x509.MarshalECPrivateKey(leafKey)
	if err != nil {
		return Bundle{}, err
	}
	return Bundle{
		CACertPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}),
		CertPEM:   pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER}),
		KeyPEM:    pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}),
		NotAfter:  leafTmpl.NotAfter,
	}, nil
}

func serialNumber() (*big.Int, error) {
	return rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
}

// Write stores the bundle: the key 0600, the certificates 0644.
func Write(p Paths, b Bundle) error {
	for _, f := range []struct {
		path string
		data []byte
		mode os.FileMode
	}{
		{p.Key, b.KeyPEM, 0o600},
		{p.Cert, b.CertPEM, 0o644},
		{p.CA, b.CACertPEM, 0o644},
	} {
		if err := os.MkdirAll(filepath.Dir(f.path), 0o755); err != nil {
			return err
		}
		if err := writeExclusive(f.path, f.data, f.mode); err != nil {
			return fmt.Errorf("writing %s: %w", f.path, err)
		}
	}
	return nil
}

// writeExclusive replaces path with a file created at mode, so a key is never
// readable, even briefly, under an earlier file's looser mode.
func writeExclusive(path string, data []byte, mode os.FileMode) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	// The umask can narrow the mode OpenFile applied; set it exactly.
	return os.Chmod(path, mode)
}

// Remove deletes whichever of the three files exist and returns their paths.
func Remove(p Paths) ([]string, error) {
	var removed []string
	for _, path := range []string{p.CA, p.Cert, p.Key} {
		err := os.Remove(path)
		switch {
		case err == nil:
			removed = append(removed, path)
		case errors.Is(err, fs.ErrNotExist):
		default:
			return removed, err
		}
	}
	return removed, nil
}

func ReadCert(path string) (*x509.Certificate, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, fmt.Errorf("%s: no certificate found", path)
	}
	return x509.ParseCertificate(block.Bytes)
}

// Uncovered returns the names cert is not valid for, in the order given.
func Uncovered(cert *x509.Certificate, names []string) []string {
	var out []string
	for _, n := range names {
		if cert.VerifyHostname(n) != nil {
			out = append(out, n)
		}
	}
	return out
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `go test ./internal/uitls/ -count=1`
Expected: PASS.

- [ ] **Step 5: Break-check the no-CA-key test**

Temporarily add a fourth file to `Write`, containing the CA key: after the loop, `os.WriteFile(filepath.Join(filepath.Dir(p.Key), "ui-ca-key.pem"), b.KeyPEM, 0o600)`. Note that `b.KeyPEM` is the leaf key, so this only proves the file-count guard. Run `TestWriteLeavesNoCAPrivateKeyOnDisk` and confirm it FAILS on the directory listing. Remove the line. Then, to prove the key-ownership guard, temporarily change `Generate` so `KeyPEM` marshals `caKey` instead of `leafKey`. Confirm the test FAILS with `holds a private key that is not the leaf's`. Restore it, and confirm the whole package passes.

- [ ] **Step 6: Commit**

```bash
git add internal/uitls/uitls.go internal/uitls/uitls_test.go
git commit --signoff -F - <<'EOF'
feat(uitls): issue the web UI certificate from a single-use CA

Generates a P-256 CA and one server certificate in a single call, and
never serialises the CA's private key. The leaf covers the loopback names
plus the configured hosts, carries serverAuth, and is valid for 397 days.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LdwrX6PaoHfKtDBE96EaPx
EOF
```

---
### Task 5: Detect this machine's `.local` name and LAN IP

**Files:**
- Create: `internal/netdetect/netdetect.go`
- Test: `internal/netdetect/netdetect_test.go`

**Interfaces:**
- Produces (package `netdetect`):
  - `func LocalName() (string, bool)`, e.g. `"mturley-mac.local", true`
  - `func LANIP() (net.IP, bool)`
  - `func Candidates() []string`: the `.local` name first, then the IP, omitting either if undetected

- [ ] **Step 1: Write the failing tests**

Create `internal/netdetect/netdetect_test.go`:

```go
package netdetect

import (
	"errors"
	"net"
	"strings"
	"testing"
)

// stub replaces the package's seams for one test.
func stub(t *testing.T, os string, scutil func() (string, error), udp func() (net.Addr, error)) {
	t.Helper()
	oldOS, oldScutil, oldUDP := goos, runScutil, dialUDP
	goos, runScutil, dialUDP = os, scutil, udp
	t.Cleanup(func() { goos, runScutil, dialUDP = oldOS, oldScutil, oldUDP })
}

func udpAddr(ip string) func() (net.Addr, error) {
	return func() (net.Addr, error) { return &net.UDPAddr{IP: net.ParseIP(ip), Port: 50000}, nil }
}

func TestCandidatesOnMac(t *testing.T) {
	stub(t, "darwin", func() (string, error) { return "mturley-mac\n", nil }, udpAddr("192.168.86.21"))
	if got := strings.Join(Candidates(), ","); got != "mturley-mac.local,192.168.86.21" {
		t.Fatalf("Candidates = %q", got)
	}
}

func TestNoLocalNameOffMac(t *testing.T) {
	called := false
	stub(t, "linux", func() (string, error) { called = true; return "box", nil }, udpAddr("10.0.0.7"))
	if name, ok := LocalName(); ok || name != "" {
		t.Fatalf("LocalName = %q, %v; want none off macOS", name, ok)
	}
	if called {
		t.Fatal("scutil was run off macOS")
	}
	if got := strings.Join(Candidates(), ","); got != "10.0.0.7" {
		t.Fatalf("Candidates = %q", got)
	}
}

func TestScutilFailureIsNotAnError(t *testing.T) {
	stub(t, "darwin", func() (string, error) { return "", errors.New("exit status 1") }, udpAddr("10.0.0.7"))
	if _, ok := LocalName(); ok {
		t.Fatal("LocalName reported a name after scutil failed")
	}
	stub(t, "darwin", func() (string, error) { return "  \n", nil }, udpAddr("10.0.0.7"))
	if _, ok := LocalName(); ok {
		t.Fatal("LocalName reported a name for blank scutil output")
	}
}

func TestLANIPRejectsUnusableAddresses(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "0.0.0.0", "fe80::1"} {
		stub(t, "darwin", func() (string, error) { return "", errors.New("x") }, udpAddr(ip))
		if got, ok := LANIP(); ok {
			t.Errorf("LANIP with local address %s = %v, want none", ip, got)
		}
	}
	stub(t, "darwin", func() (string, error) { return "", errors.New("x") },
		func() (net.Addr, error) { return nil, errors.New("network is unreachable") })
	if _, ok := LANIP(); ok {
		t.Error("LANIP reported an address with no route")
	}
	if got := Candidates(); len(got) != 0 {
		t.Errorf("Candidates = %v, want none", got)
	}
}
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `go test ./internal/netdetect/ -count=1`
Expected: FAIL to compile, with `undefined: goos`.

- [ ] **Step 3: Implement**

Create `internal/netdetect/netdetect.go`:

```go
// Package netdetect finds the addresses another device on the LAN would use
// to reach this machine, so setup can offer them rather than asking.
package netdetect

import (
	"net"
	"os/exec"
	"runtime"
	"strings"
)

// Seams for tests.
var (
	goos      = runtime.GOOS
	runScutil = func() (string, error) {
		out, err := exec.Command("scutil", "--get", "LocalHostName").Output()
		return string(out), err
	}
	// Dialing UDP picks a route and a local address without sending a
	// packet. 192.0.2.1 is TEST-NET-1 (RFC 5737), which nothing answers.
	dialUDP = func() (net.Addr, error) {
		c, err := net.Dial("udp4", "192.0.2.1:9")
		if err != nil {
			return nil, err
		}
		defer c.Close()
		return c.LocalAddr(), nil
	}
)

// LocalName returns this Mac's mDNS name, e.g. "mturley-mac.local". It reads
// LocalHostName rather than os.Hostname(): the plain hostname can be handed
// out by the network and drift from the name mDNS advertises. macOS only.
func LocalName() (string, bool) {
	if goos != "darwin" {
		return "", false
	}
	out, err := runScutil()
	if err != nil {
		return "", false
	}
	name := strings.TrimSpace(out)
	if name == "" {
		return "", false
	}
	return name + ".local", true
}

// LANIP returns the IPv4 address of the interface that routes outbound.
func LANIP() (net.IP, bool) {
	addr, err := dialUDP()
	if err != nil {
		return nil, false
	}
	u, ok := addr.(*net.UDPAddr)
	if !ok || u.IP == nil {
		return nil, false
	}
	v4 := u.IP.To4()
	if v4 == nil || v4.IsLoopback() || v4.IsUnspecified() {
		return nil, false
	}
	return v4, true
}

// Candidates returns the detected addresses, the .local name first: it
// survives the router handing out a different IP.
func Candidates() []string {
	var out []string
	if name, ok := LocalName(); ok {
		out = append(out, name)
	}
	if ip, ok := LANIP(); ok {
		out = append(out, ip.String())
	}
	return out
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `go test ./internal/netdetect/ -count=1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/netdetect/netdetect.go internal/netdetect/netdetect_test.go
git commit --signoff -F - <<'EOF'
feat(netdetect): detect the .local name and LAN IP other devices can use

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LdwrX6PaoHfKtDBE96EaPx
EOF
```

---
### Task 6: Route table, Host allowlist, and the two listeners

**Files:**
- Modify: `internal/webui/server.go`
- Create: `internal/webui/security.go`
- Create: `internal/webui/hostguard.go`
- Test: `internal/webui/hostguard_test.go`
- Test: `internal/webui/listen_test.go`
- Modify: `internal/webui/bind_test.go` (replace its contents)
- Modify: `cmd/ui.go` (one line only: drop `Bind: uiBind,`)

**Interfaces:**
- Consumes: `uisession.Store` (Task 3), `uitls.Generate` / `uitls.Write` / `uitls.DefaultPaths` (Task 4, tests only).
- Produces:
  - `type webui.Security struct { Password string; Sessions *uisession.Store; AllowedHosts []string; CertFile, KeyFile string; HTTPSPort int }`
  - `func (*Security) Remote() bool`
  - `webui.Server.Security *Security`. The `Bind` field is **removed**.
  - `type route struct { pattern string; handler http.HandlerFunc }` and `func (s *Server) routes() []route`
  - `func (s *Server) wrap(h http.Handler) http.Handler`: the guard chain, which Task 7 extends
  - `func (s *Server) Serve(httpLn, httpsLn net.Listener) error` (`httpsLn` may be nil)
  - `func (s *Server) Start() error`: refuses a nil or incomplete `Security`

**Note for the implementer:** existing tests build `&Server{}` with no `Security` and call `Handler()`, over 80 call sites. A nil `Security` must keep those passing: `wrap` skips the Host and session layers when it is nil. `Start` and `Serve` are the only ways to open a listener, and both refuse a nil `Security`, so production cannot serve without it.

- [ ] **Step 1: Write the failing Host allowlist tests**

Create `internal/webui/hostguard_test.go`:

```go
package webui

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestHostAllowed(t *testing.T) {
	extra := []string{"mturley-mac.local", "192.168.86.21"}
	cases := []struct {
		host string
		want bool
	}{
		{"localhost", true},
		{"localhost:8475", true},
		{"LOCALHOST:5175", true}, // the Vite dev proxy forwards its own port
		{"127.0.0.1", true},
		{"127.0.0.1:8476", true},
		{"[::1]", true},
		{"[::1]:8476", true},
		{"::1", true},
		{"mturley-mac.local:8476", true},
		{"MTurley-Mac.local", true},
		{"mturley-mac.local.", true}, // a fully-qualified name with its trailing dot
		{"192.168.86.21:8476", true},
		{"mturley-mac.local:9999", true}, // the port is deliberately ignored
		{"evil.example", false},
		{"evil.example:8475", false},
		{"127.0.0.1.evil.example", false},
		{"192.168.86.22", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := hostAllowed(tc.host, extra); got != tc.want {
			t.Errorf("hostAllowed(%q) = %v, want %v", tc.host, got, tc.want)
		}
	}
}

func TestHostGuardRefusesBeforeRouting(t *testing.T) {
	// A route that succeeds for an allowed Host, so a 400 can only have come
	// from the guard and not from the route. (Static assets need no session,
	// so this keeps passing once Task 7 adds one.)
	srv := &Server{
		WebFS:    fstest.MapFS{"index.html": {Data: []byte("<!doctype html>")}},
		Security: &Security{Password: "pw", AllowedHosts: []string{"mturley-mac.local"}},
	}
	h := srv.Handler()

	ok := httptest.NewRequest("GET", "/", nil)
	ok.Host = "mturley-mac.local:8476"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, ok)
	if rec.Code != http.StatusOK {
		t.Fatalf("allowed Host: status %d, want 200", rec.Code)
	}

	bad := httptest.NewRequest("GET", "/", nil)
	bad.Host = "rebound.evil.example"
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bad)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unlisted Host: status %d, want 400", rec.Code)
	}
}

func TestHostGuardIsOffWithoutSecurity(t *testing.T) {
	// In-process tests build a bare Server; httptest's default Host is
	// example.com. Start and Serve refuse a nil Security.
	srv := &Server{WebFS: fstest.MapFS{"index.html": {Data: []byte("x")}}}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200", rec.Code)
	}
}
```

- [ ] **Step 2: Write the failing listener tests**

Replace the entire contents of `internal/webui/bind_test.go` with:

```go
package webui

import "testing"

func TestListenAddrIsAlwaysLoopback(t *testing.T) {
	s := &Server{Port: 8475}
	if got, want := s.listenAddr(), "127.0.0.1:8475"; got != want {
		t.Fatalf("listenAddr() = %q, want %q", got, want)
	}
}
```

Create `internal/webui/listen_test.go`:

```go
package webui

import (
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/uisession"
	"github.com/mturley/worktree/internal/uitls"
)

func TestStartRefusesWithoutAuthentication(t *testing.T) {
	for name, sec := range map[string]*Security{
		"nil":         nil,
		"no password": {Sessions: &uisession.Store{}},
		"no sessions": {Password: "pw"},
	} {
		err := (&Server{Port: 0, Security: sec}).Start()
		if err == nil || !strings.Contains(err.Error(), "authentication") {
			t.Errorf("%s: Start() = %v, want a refusal naming authentication", name, err)
		}
	}
}

// securedForListen builds a Server with a working session store and, when
// withTLS is set, a freshly issued certificate.
func securedForListen(t *testing.T, withTLS bool) (*Server, []byte) {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	sec := &Security{Password: "pw", Sessions: &uisession.Store{DB: conn}}
	var caPEM []byte
	if withTLS {
		b, err := uitls.Generate(nil, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		p := uitls.DefaultPaths(t.TempDir())
		if err := uitls.Write(p, b); err != nil {
			t.Fatal(err)
		}
		sec.CertFile, sec.KeyFile = p.Cert, p.Key
		caPEM = b.CACertPEM
	}
	srv := &Server{
		DB:       conn,
		WebFS:    fstest.MapFS{"index.html": {Data: []byte("<!doctype html>ok")}},
		Security: sec,
	}
	return srv, caPEM
}

func listenLoopback(t *testing.T) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	return ln
}

func TestServeSpeaksHTTPOnLoopbackAndTLSOnTheRemotePort(t *testing.T) {
	srv, caPEM := securedForListen(t, true)
	httpLn, httpsLn := listenLoopback(t), listenLoopback(t)
	done := make(chan error, 1)
	go func() { done <- srv.Serve(httpLn, httpsLn) }()
	t.Cleanup(func() {
		httpLn.Close()
		httpsLn.Close()
		<-done
	})

	plain := &http.Client{Timeout: 5 * time.Second}

	// Loopback listener: plain HTTP.
	resp, err := plain.Get("http://" + httpLn.Addr().String() + "/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("HTTP listener: status %d, want 200", resp.StatusCode)
	}

	// Remote listener: plain HTTP is answered with Go's TLS-server refusal.
	resp, err = plain.Get("http://" + httpsLn.Addr().String() + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(body), "HTTPS server") {
		t.Fatalf("plain HTTP to the TLS port: %d %q, want Go's 400 HTTP-to-HTTPS refusal", resp.StatusCode, body)
	}

	// Remote listener: TLS, verified against the generated CA.
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(caPEM)
	secure := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{
		TLSClientConfig: &tls.Config{RootCAs: pool},
	}}
	resp, err = secure.Get("https://" + httpsLn.Addr().String() + "/")
	if err != nil {
		t.Fatalf("HTTPS listener: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("HTTPS listener: status %d, want 200", resp.StatusCode)
	}
}

func TestServeWithoutRemoteServesOnlyHTTP(t *testing.T) {
	srv, _ := securedForListen(t, false)
	if srv.Security.Remote() {
		t.Fatal("Remote() = true with no certificate")
	}
	httpLn := listenLoopback(t)
	done := make(chan error, 1)
	go func() { done <- srv.Serve(httpLn, nil) }()
	t.Cleanup(func() { httpLn.Close(); <-done })
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Get("http://" + httpLn.Addr().String() + "/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d, want 200", resp.StatusCode)
	}
}

func TestServeFailsOnAMissingCertificate(t *testing.T) {
	srv, _ := securedForListen(t, false)
	srv.Security.CertFile = filepath.Join(t.TempDir(), "missing-cert.pem")
	srv.Security.KeyFile = filepath.Join(t.TempDir(), "missing-key.pem")
	httpLn, httpsLn := listenLoopback(t), listenLoopback(t)
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(httpLn, httpsLn) }()
	select {
	case err := <-errc:
		if err == nil {
			t.Fatal("Serve returned nil with a missing certificate")
		}
	case <-time.After(5 * time.Second):
		httpLn.Close()
		httpsLn.Close()
		t.Fatal("Serve kept running with a missing certificate")
	}
}
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `go test ./internal/webui/ -run 'TestHost|TestListenAddr|TestStart|TestServe' -count=1`
Expected: FAIL to compile, with `undefined: hostAllowed` and `unknown field Security`.

- [ ] **Step 4: Add `Security`**

Create `internal/webui/security.go`:

```go
package webui

import (
	"errors"

	"github.com/mturley/worktree/internal/uisession"
)

// Security is the web UI's authentication and remote-access configuration.
// Start and Serve refuse to open a listener without it.
type Security struct {
	// Password is what POST /api/login checks. Required.
	Password string
	// Sessions stores logins. Required.
	Sessions *uisession.Store
	// AllowedHosts are accepted in the Host header, beyond the loopback
	// names that always are. They match the certificate's names.
	AllowedHosts []string
	// CertFile and KeyFile, both set, enable the HTTPS listener.
	CertFile string
	KeyFile  string
	// HTTPSPort is where that listener binds, on every interface.
	HTTPSPort int
}

// Remote reports whether the HTTPS listener for other devices is configured.
func (sec *Security) Remote() bool {
	return sec != nil && sec.CertFile != "" && sec.KeyFile != ""
}

func (sec *Security) validate() error {
	if sec == nil || sec.Password == "" || sec.Sessions == nil {
		return errors.New("webui: refusing to serve without authentication configured")
	}
	return nil
}
```

- [ ] **Step 5: Add the Host guard**

Create `internal/webui/hostguard.go`:

```go
package webui

import (
	"log"
	"net"
	"net/http"
	"strings"
)

// loopbackHosts are always accepted in the Host header.
var loopbackHosts = []string{"localhost", "127.0.0.1", "::1"}

// hostAllowed reports whether a Host header names this server. DNS
// rebinding serves an attacker's page under the attacker's hostname, so the
// hostname is what must match. The port is ignored on purpose: it varies
// legitimately between the two listeners and the Vite dev proxy.
func hostAllowed(hostHeader string, extra []string) bool {
	name := hostHeader
	if h, _, err := net.SplitHostPort(hostHeader); err == nil {
		name = h
	}
	name = strings.TrimSuffix(strings.TrimPrefix(name, "["), "]")
	name = strings.TrimSuffix(name, ".")
	if name == "" {
		return false
	}
	for _, list := range [][]string{loopbackHosts, extra} {
		for _, allowed := range list {
			if sameHost(name, allowed) {
				return true
			}
		}
	}
	return false
}

func sameHost(a, b string) bool {
	if strings.EqualFold(a, b) {
		return true
	}
	ia, ib := net.ParseIP(a), net.ParseIP(b)
	return ia != nil && ib != nil && ia.Equal(ib)
}

// hostGuard refuses a request whose Host is not allowed, before anything
// else sees it.
func hostGuard(extra []string, logger *log.Logger, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !hostAllowed(r.Host, extra) {
			if logger != nil {
				logger.Printf("refused a request for Host %q; if that name is yours, add it to ui.allowed_hosts in the worktree config", r.Host)
			}
			http.Error(w, "unrecognized Host header", http.StatusBadRequest)
			return
		}
		h.ServeHTTP(w, r)
	})
}
```

- [ ] **Step 6: Restructure `server.go`**

In `internal/webui/server.go`:

1. In the `Server` struct, delete the `Bind` field and its comment. Add, directly after the `Logger` field:

```go
	// Security is required to serve (Start and Serve refuse a nil one). A
	// Handler built without it skips the Host and session guards, which is
	// what in-process tests rely on.
	Security *Security
```

2. Replace `Handler`, the whole `registerAPI` function, `listenAddr` and `Start` with the code below. The route list is the existing registrations, moved verbatim into a table, and the order is kept. Add `"errors"` to the imports if the compiler asks; `security.go` already uses it.

```go
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	for _, rt := range s.routes() {
		mux.HandleFunc(rt.pattern, rt.handler)
	}
	if !s.DevMode && s.WebFS != nil {
		mux.HandleFunc("/", s.serveStatic)
	}
	return s.wrap(mux)
}

// wrap applies the request guards. Outermost first: the Host allowlist, so
// nothing routes a rebound request; then the request-forgery guard.
func (s *Server) wrap(h http.Handler) http.Handler {
	h = guardMutations(h)
	if s.Security != nil {
		h = hostGuard(s.Security.AllowedHosts, s.Logger, h)
	}
	return h
}

type route struct {
	pattern string
	handler http.HandlerFunc
}

// routes is the API route table. Every entry declares its method, and tests
// iterate it, so a route added here is covered by the auth tests
// automatically.
func (s *Server) routes() []route {
	return []route{
		{"GET /api/worktrees", s.handleWorktrees},
		{"GET /api/timeline", s.handleGlobalTimeline},
		{"GET /api/worktree-timeline", s.handleWorktreeTimeline},
		{"POST /api/worktrees/poll", s.handlePollWorktree},
		{"GET /api/watchers", s.handleWatchers},
		{"POST /api/watchers/poll", s.handleWatchersPoll},
		{"GET /api/worktree-resources", s.handleWorktreeResources},
		{"POST /api/resource-meta", s.handleSetResourceMeta},
		{"POST /api/resource-read", s.handleResourceRead},
		{"POST /api/worktree-resources/add", s.handleAddResource},
		{"POST /api/worktrees/delete", s.handleDeleteWorktree},
		{"POST /api/worktree-resources/remove", s.handleRemoveResource},
		{"POST /api/worktree-resources/primary", s.handleSetResourcePrimary},
		{"GET /api/stream", s.handleStream},

		// Slack thread/reply/react + image proxies (folded in from slack-mini).
		{"GET /api/thread", s.handleThread},
		{"POST /api/thread/mark-read", s.handleMarkRead},
		{"POST /api/thread/mark-unread", s.handleMarkUnread},
		{"POST /api/thread/reply", s.handleReply},
		{"POST /api/thread/react", s.handleReact},
		{"GET /api/slack-config", s.handleSlackConfig},
		{"GET /api/slack-autocomplete", s.handleSlackAutocomplete},
		{"GET /api/thread-events", s.handleThreadEvents},
		{"GET /api/worktree-info", s.handleWorktreeInfo},
		{"GET /api/cmux", s.handleCmux},
		{"GET /api/cmux-groups", s.handleCmuxGroups},
		{"POST /api/cmux/select", s.handleCmuxSelect},
		{"POST /api/cmux/create", s.handleCmuxCreate},
		{"GET /api/jira-icon", s.handleJiraIcon},
		{"GET /api/slack-avatar", s.handleSlackAvatar},
		{"POST /api/worktrees/create", s.handleCreateWorktree},
		{"GET /api/repos", s.handleRepos},
		{"GET /api/repo-dotfiles", s.handleRepoDotfiles},
		{"GET /api/slack-emoji", s.handleSlackEmoji},
		{"GET /api/slack-file", s.handleSlackFile},
		// Open-host proxy for third-party unfurl images (preview/favicon/footer).
		{"GET /api/slack-image", s.handleImage},

		{"POST /api/resource-resolve", s.handleResourceResolve},
		{"GET /api/resource-type", s.handleResourceType},
		// The same open-host image proxy handler as /api/slack-image, under a
		// name that is honest about who is calling it. A link's favicon and
		// preview image are third-party URLs from arbitrary sites, which is
		// exactly what handleImage was built for.
		{"GET /api/link-image", s.handleImage},
	}
}

// listenAddr is the plain-HTTP listener's address. It is always loopback:
// other devices use the HTTPS listener.
func (s *Server) listenAddr() string {
	return net.JoinHostPort("127.0.0.1", strconv.Itoa(s.Port))
}

// Start opens the loopback HTTP listener and, when remote access is
// configured, the HTTPS listener on every interface, then serves both.
func (s *Server) Start() error {
	if err := s.Security.validate(); err != nil {
		return err
	}
	httpLn, err := net.Listen("tcp", s.listenAddr())
	if err != nil {
		return err
	}
	var httpsLn net.Listener
	if s.Security.Remote() {
		// Every interface, loopback included: the .local name resolves to
		// 127.0.0.1 on this machine, so the phone's URL works here too.
		httpsLn, err = net.Listen("tcp", net.JoinHostPort("", strconv.Itoa(s.Security.HTTPSPort)))
		if err != nil {
			httpLn.Close()
			return err
		}
	}
	return s.Serve(httpLn, httpsLn)
}

// Serve serves on listeners that are already open; httpsLn may be nil. It
// returns when either server stops, and closes both.
func (s *Server) Serve(httpLn, httpsLn net.Listener) error {
	if err := s.Security.validate(); err != nil {
		return err
	}
	h := s.Handler()
	errc := make(chan error, 2)

	local := &http.Server{Handler: h, ReadHeaderTimeout: 10 * time.Second}
	if s.Logger != nil {
		s.Logger.Printf("worktree UI listening on http://%s", httpLn.Addr())
	}
	go func() { errc <- local.Serve(httpLn) }()

	var remote *http.Server
	if httpsLn != nil {
		remote = &http.Server{Handler: h, ReadHeaderTimeout: 10 * time.Second}
		if s.Logger != nil {
			s.Logger.Printf("worktree UI listening for other devices on https://%s", httpsLn.Addr())
		}
		go func() { errc <- remote.ServeTLS(httpsLn, s.Security.CertFile, s.Security.KeyFile) }()
	}

	err := <-errc
	local.Close()
	if remote != nil {
		remote.Close()
	}
	return err
}
```

3. In `cmd/ui.go`, delete `Bind: uiBind, ` from the `webui.Server` literal. Nothing else in `cmd` changes in this task. `worktree ui` will refuse to start until Task 8 supplies `Security`; that is expected between tasks.

- [ ] **Step 7: Run the whole module and confirm it builds and passes**

Run: `go build ./... && go test ./internal/webui/ ./cmd/ -count=1`
Expected: PASS, including every pre-existing `internal/webui` test.

- [ ] **Step 8: Break-check the Host guard**

Temporarily make `hostAllowed` return `true` unconditionally. Run `go test ./internal/webui/ -run TestHostGuardRefusesBeforeRouting -count=1` and confirm it FAILS with `unlisted Host: status 200, want 400`. Restore it.

- [ ] **Step 9: Commit**

```bash
git add internal/webui/server.go internal/webui/security.go internal/webui/hostguard.go internal/webui/hostguard_test.go internal/webui/listen_test.go internal/webui/bind_test.go cmd/ui.go
git commit --signoff -F - <<'EOF'
feat(webui): serve HTTP on loopback and HTTPS for other devices

The plain-HTTP listener is now always 127.0.0.1. When remote access is
configured, a second listener serves HTTPS on every interface. Requests
whose Host is not a loopback name or a configured host are refused with
400 before routing, and the server refuses to start without
authentication configured. API routes move into a table that tests can
iterate.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LdwrX6PaoHfKtDBE96EaPx
EOF
```

---
### Task 7: Login, sessions and the deny-by-default session check

**Files:**
- Create: `internal/webui/auth.go`
- Modify: `internal/webui/server.go` (`wrap` and `routes` only)
- Test: `internal/webui/auth_test.go`

**Interfaces:**
- Consumes: `Security`, `wrap`, `routes` (Task 6); `uisession` (Task 3).
- Produces HTTP API:
  - `POST /api/login` `{"password"}` → 200 `sessionDTO`, sets the cookie · 401 wrong password · 400 bad body. The only `/api/` route reachable without a session.
  - `POST /api/logout` → 200 `{"ok":true}`, revokes the current session and clears the cookie
  - `GET /api/session` → 200 `sessionDTO` for the current session
  - `GET /api/sessions` → 200 `[]sessionDTO`, newest first, `current` true on exactly one
  - `POST /api/sessions/revoke` `{"handle"}` → 200 `{"ok":true}` · 404 unknown handle · 400 missing handle; clears the cookie when revoking the current session
  - Any `/api/` request without a live session → 401 `{"error":"login required"}` with header `X-Worktree-Login-Required: 1`
  - `sessionDTO` JSON: `{"handle","label","created_at","last_seen_at","current"}`, with times in RFC 3339

- [ ] **Step 1: Write the failing tests**

Create `internal/webui/auth_test.go`:

```go
package webui

import (
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/uisession"
)

const testPassword = "correct horse battery staple"

type testClock struct{ t time.Time }

func (c *testClock) now() time.Time { return c.t }

func securedServer(t *testing.T) (*Server, *uisession.Store, *testClock) {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	clock := &testClock{t: time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)}
	store := &uisession.Store{DB: conn, Now: clock.now}
	old := loginFailDelay
	loginFailDelay = 0
	t.Cleanup(func() { loginFailDelay = old })
	return &Server{DB: conn, Security: &Security{Password: testPassword, Sessions: store}}, store, clock
}

// apiRequest builds a request the Host and forgery guards accept, so a test
// observes only the session check.
func apiRequest(method, path, body string, cookies ...*http.Cookie) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Host = "127.0.0.1:8475"
	if method != http.MethodGet {
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Sec-Fetch-Site", "same-origin")
	}
	for _, c := range cookies {
		req.AddCookie(c)
	}
	return req
}

func serve(h http.Handler, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func sessionCookieFrom(t *testing.T, rec *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookieName {
			return c
		}
	}
	t.Fatalf("no %s cookie in response (status %d)", sessionCookieName, rec.Code)
	return nil
}

func login(t *testing.T, h http.Handler) *http.Cookie {
	t.Helper()
	rec := serve(h, apiRequest("POST", "/api/login", `{"password":"`+testPassword+`"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("login: status %d %s", rec.Code, rec.Body)
	}
	return sessionCookieFrom(t, rec)
}

func TestEveryAPIRouteRequiresASession(t *testing.T) {
	srv, store, _ := securedServer(t)
	token, _, err := store.Create("test")
	if err != nil {
		t.Fatal(err)
	}
	cookie := &http.Cookie{Name: sessionCookieName, Value: token}

	// Stub handlers for the real route table, behind the real guard chain.
	// This proves the chain over every registered route without running
	// handlers that need Slack, cmux or git.
	stub := http.NewServeMux()
	routes := srv.routes()
	if len(routes) == 0 {
		t.Fatal("route table is empty")
	}
	for _, rt := range routes {
		stub.HandleFunc(rt.pattern, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		})
	}
	h := srv.wrap(stub)

	for _, rt := range routes {
		method, path, ok := strings.Cut(rt.pattern, " ")
		if !ok {
			t.Fatalf("route %q declares no method", rt.pattern)
		}
		if strings.Contains(path, "{") {
			t.Fatalf("route %q has a wildcard; teach this test to fill it in", rt.pattern)
		}
		rec := serve(h, apiRequest(method, path, "{}"))
		if rt.pattern == "POST /api/login" {
			if rec.Code != http.StatusNoContent {
				t.Errorf("%s without a session: status %d, want it reachable", rt.pattern, rec.Code)
			}
		} else if rec.Code != http.StatusUnauthorized || rec.Header().Get(loginRequiredHeader) != "1" {
			t.Errorf("%s without a session: status %d, header %q; want 401 with %s: 1",
				rt.pattern, rec.Code, rec.Header().Get(loginRequiredHeader), loginRequiredHeader)
		}
		if rec := serve(h, apiRequest(method, path, "{}", cookie)); rec.Code != http.StatusNoContent {
			t.Errorf("%s with a session: status %d, want 204", rt.pattern, rec.Code)
		}
	}
}

func TestUnregisteredAPIPathStillRequiresASession(t *testing.T) {
	srv, _, _ := securedServer(t)
	rec := serve(srv.Handler(), apiRequest("GET", "/api/not-a-route", ""))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401: the check is on the /api/ prefix, not the route list", rec.Code)
	}
}

func TestStaticAssetsNeedNoSession(t *testing.T) {
	srv, _, _ := securedServer(t)
	srv.WebFS = fstest.MapFS{
		"index.html":    {Data: []byte("<!doctype html>")},
		"assets/app.js": {Data: []byte("1")},
	}
	h := srv.Handler()
	for _, path := range []string{"/", "/assets/app.js", "/worktree/some/path"} {
		if rec := serve(h, apiRequest("GET", path, "")); rec.Code != http.StatusOK {
			t.Errorf("GET %s: status %d, want 200 (the login page must load)", path, rec.Code)
		}
	}
}

func TestLoginWithWrongPasswordSetsNoCookie(t *testing.T) {
	srv, _, _ := securedServer(t)
	for _, pw := range []string{"wrong", "", testPassword + "x"} {
		body, _ := json.Marshal(map[string]string{"password": pw})
		rec := serve(srv.Handler(), apiRequest("POST", "/api/login", string(body)))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("password %q: status %d, want 401", pw, rec.Code)
		}
		if len(rec.Result().Cookies()) != 0 {
			t.Errorf("password %q: set a cookie", pw)
		}
	}
}

func TestLoginSetsASessionCookie(t *testing.T) {
	srv, _, _ := securedServer(t)
	h := srv.Handler()
	req := apiRequest("POST", "/api/login", `{"password":"`+testPassword+`"}`)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36")
	rec := serve(h, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d %s", rec.Code, rec.Body)
	}
	c := sessionCookieFrom(t, rec)
	if !c.HttpOnly || c.SameSite != http.SameSiteLaxMode || c.Path != "/" || c.MaxAge != 30*24*60*60 {
		t.Errorf("cookie = %+v, want HttpOnly, SameSite=Lax, Path=/, Max-Age=2592000", c)
	}
	if c.Secure {
		t.Error("Secure set on a login over plain HTTP: the browser would discard the cookie")
	}
	if strings.Contains(rec.Body.String(), c.Value) {
		t.Error("login response body contains the session token")
	}

	rec = serve(h, apiRequest("GET", "/api/session", "", c))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/session with the new cookie: status %d", rec.Code)
	}
	var dto sessionDTO
	if err := json.Unmarshal(rec.Body.Bytes(), &dto); err != nil {
		t.Fatal(err)
	}
	if !dto.Current || dto.Label != "Android — Chrome" || dto.Handle != uisession.HandleFor(c.Value) {
		t.Errorf("session = %+v", dto)
	}
}

func TestLoginOverTLSSetsASecureCookie(t *testing.T) {
	srv, _, _ := securedServer(t)
	req := apiRequest("POST", "/api/login", `{"password":"`+testPassword+`"}`)
	req.TLS = &tls.ConnectionState{}
	c := sessionCookieFrom(t, serve(srv.Handler(), req))
	if !c.Secure {
		t.Fatal("Secure not set on a login that arrived over TLS")
	}
}

func TestLoginIsRefusedCrossSite(t *testing.T) {
	srv, _, _ := securedServer(t)
	req := apiRequest("POST", "/api/login", `{"password":"`+testPassword+`"}`)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	rec := serve(srv.Handler(), req)
	if rec.Code != http.StatusForbidden || len(rec.Result().Cookies()) != 0 {
		t.Fatalf("status %d, cookies %v; want 403 and no cookie", rec.Code, rec.Result().Cookies())
	}
}

func TestHostGuardRunsBeforeTheSessionCheck(t *testing.T) {
	srv, _, _ := securedServer(t)
	h := srv.Handler()
	c := login(t, h)
	req := apiRequest("GET", "/api/session", "", c)
	req.Host = "rebound.evil.example"
	if rec := serve(h, req); rec.Code != http.StatusBadRequest {
		t.Fatalf("valid session, unlisted Host: status %d, want 400", rec.Code)
	}
}

func TestRevokedSessionIsRefusedOnItsNextRequest(t *testing.T) {
	srv, _, _ := securedServer(t)
	h := srv.Handler()
	phone, laptop := login(t, h), login(t, h)

	rec := serve(h, apiRequest("GET", "/api/sessions", "", laptop))
	var list []sessionDTO
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	var current int
	for _, s := range list {
		if s.Current {
			current++
		}
	}
	if len(list) != 2 || current != 1 {
		t.Fatalf("sessions = %+v, want two with exactly one current", list)
	}

	body, _ := json.Marshal(map[string]string{"handle": uisession.HandleFor(phone.Value)})
	if rec := serve(h, apiRequest("POST", "/api/sessions/revoke", string(body), laptop)); rec.Code != http.StatusOK {
		t.Fatalf("revoke: status %d %s", rec.Code, rec.Body)
	}
	if rec := serve(h, apiRequest("GET", "/api/session", "", phone)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("revoked phone: status %d, want 401", rec.Code)
	}
	if rec := serve(h, apiRequest("GET", "/api/session", "", laptop)); rec.Code != http.StatusOK {
		t.Fatalf("laptop after revoking phone: status %d, want 200", rec.Code)
	}
	if rec := serve(h, apiRequest("POST", "/api/sessions/revoke", string(body), laptop)); rec.Code != http.StatusNotFound {
		t.Fatalf("revoking an unknown handle: status %d, want 404", rec.Code)
	}
}

func TestSessionsNeverExposeTokens(t *testing.T) {
	srv, _, _ := securedServer(t)
	h := srv.Handler()
	a, b := login(t, h), login(t, h)
	rec := serve(h, apiRequest("GET", "/api/sessions", "", a))
	for _, c := range []*http.Cookie{a, b} {
		if strings.Contains(rec.Body.String(), c.Value) {
			t.Fatal("GET /api/sessions returned a session token")
		}
	}
}

func TestRevokingTheCurrentSessionClearsTheCookie(t *testing.T) {
	srv, _, _ := securedServer(t)
	h := srv.Handler()
	c := login(t, h)
	body, _ := json.Marshal(map[string]string{"handle": uisession.HandleFor(c.Value)})
	rec := serve(h, apiRequest("POST", "/api/sessions/revoke", string(body), c))
	if rec.Code != http.StatusOK || sessionCookieFrom(t, rec).MaxAge >= 0 {
		t.Fatalf("status %d; want 200 and the cookie cleared", rec.Code)
	}
}

func TestExpiredSessionIsRefused(t *testing.T) {
	srv, _, clock := securedServer(t)
	h := srv.Handler()
	c := login(t, h)
	clock.t = clock.t.Add(uisession.Lifetime)
	if rec := serve(h, apiRequest("GET", "/api/session", "", c)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401 for an expired session", rec.Code)
	}
}

func TestLastSeenIsNotWrittenOnEveryRequest(t *testing.T) {
	srv, store, clock := securedServer(t)
	h := srv.Handler()
	c := login(t, h)
	lastSeen := func() time.Time {
		sess, ok, err := store.Lookup(c.Value)
		if err != nil || !ok {
			t.Fatalf("Lookup = %v, %v", ok, err)
		}
		return sess.LastSeenAt
	}

	clock.t = clock.t.Add(6 * time.Minute)
	serve(h, apiRequest("GET", "/api/session", "", c))
	first := lastSeen()
	if !first.Equal(clock.t) {
		t.Fatalf("last_seen_at = %v after a request past the interval, want %v", first, clock.t)
	}

	clock.t = clock.t.Add(time.Minute)
	serve(h, apiRequest("GET", "/api/session", "", c))
	if got := lastSeen(); !got.Equal(first) {
		t.Fatalf("last_seen_at rewritten to %v inside the throttle window, want %v", got, first)
	}
}

func TestLogoutRevokesAndClearsTheCookie(t *testing.T) {
	srv, _, _ := securedServer(t)
	h := srv.Handler()
	c := login(t, h)
	rec := serve(h, apiRequest("POST", "/api/logout", "", c))
	if rec.Code != http.StatusOK || sessionCookieFrom(t, rec).MaxAge >= 0 {
		t.Fatalf("logout: status %d; want 200 and the cookie cleared", rec.Code)
	}
	if rec := serve(h, apiRequest("GET", "/api/session", "", c)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("after logout: status %d, want 401", rec.Code)
	}
}

func TestPasswordMatches(t *testing.T) {
	for _, tc := range []struct {
		got, want string
		ok        bool
	}{
		{"pw", "pw", true},
		{"pw", "PW", false},
		{"p", "pw", false},
		{"", "", false}, // an unset password never matches
	} {
		if passwordMatches(tc.got, tc.want) != tc.ok {
			t.Errorf("passwordMatches(%q, %q) = %v", tc.got, tc.want, !tc.ok)
		}
	}
}
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `go test ./internal/webui/ -run 'Session|Login|Logout|Revok|Password|Static|LastSeen|Expired|HostGuardRunsBefore' -count=1`
Expected: FAIL to compile, with `undefined: loginFailDelay`, `undefined: sessionCookieName`, and similar.

- [ ] **Step 3: Implement**

Create `internal/webui/auth.go`:

```go
package webui

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/mturley/worktree/internal/uisession"
)

const (
	sessionCookieName = "worktree_session"
	// loginRequiredHeader marks a 401 as "log in to worktree". Some Slack
	// handlers also return 401, for Slack's own credentials, and the UI
	// must not confuse the two.
	loginRequiredHeader = "X-Worktree-Login-Required"
)

// loginFailDelay slows every wrong-password answer. A package var so tests
// need not wait. There is no lockout: on a single-user tool a lockout only
// locks out the user.
var loginFailDelay = 750 * time.Millisecond

type sessionContextKey struct{}

func currentSession(r *http.Request) (uisession.Session, bool) {
	sess, ok := r.Context().Value(sessionContextKey{}).(uisession.Session)
	return sess, ok
}

// requireSession refuses every /api/ request without a live session, except
// the login call. It checks the path prefix, not a list of routes, so a
// route added later is covered without anyone remembering to list it.
func (s *Server) requireSession(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") ||
			(r.Method == http.MethodPost && r.URL.Path == "/api/login") {
			h.ServeHTTP(w, r)
			return
		}
		sess, ok := s.sessionFromRequest(r)
		if !ok {
			w.Header().Set(loginRequiredHeader, "1")
			writeError(w, http.StatusUnauthorized, "login required")
			return
		}
		h.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), sessionContextKey{}, sess)))
	})
}

func (s *Server) sessionFromRequest(r *http.Request) (uisession.Session, bool) {
	c, err := r.Cookie(sessionCookieName)
	if err != nil {
		return uisession.Session{}, false
	}
	sess, ok, err := s.Security.Sessions.Lookup(c.Value)
	if err != nil {
		if s.Logger != nil {
			s.Logger.Printf("session lookup: %v", err)
		}
		return uisession.Session{}, false
	}
	if !ok {
		return uisession.Session{}, false
	}
	if _, err := s.Security.Sessions.Touch(sess); err != nil && s.Logger != nil {
		s.Logger.Printf("session touch: %v", err)
	}
	return sess, true
}

// passwordMatches compares in constant time. Both sides are hashed first:
// subtle.ConstantTimeCompare returns early when lengths differ, which would
// reveal the password's length.
func passwordMatches(got, want string) bool {
	if want == "" {
		return false
	}
	g, w := sha256.Sum256([]byte(got)), sha256.Sum256([]byte(want))
	return subtle.ConstantTimeCompare(g[:], w[:]) == 1
}

type sessionDTO struct {
	Handle     string `json:"handle"`
	Label      string `json:"label"`
	CreatedAt  string `json:"created_at"`
	LastSeenAt string `json:"last_seen_at"`
	Current    bool   `json:"current"`
}

func tosessionDTO(sess uisession.Session, current bool) sessionDTO {
	return sessionDTO{
		Handle:     sess.Handle,
		Label:      sess.Label,
		CreatedAt:  sess.CreatedAt.Format(time.RFC3339),
		LastSeenAt: sess.LastSeenAt.Format(time.RFC3339),
		Current:    current,
	}
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		// Per request, because one server has both listeners. A Secure
		// cookie set over plain HTTP would be discarded by the browser.
		Secure: r.TLS != nil,
	})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if s.Security == nil {
		writeError(w, http.StatusServiceUnavailable, "authentication is not configured")
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if !passwordMatches(req.Password, s.Security.Password) {
		time.Sleep(loginFailDelay)
		writeError(w, http.StatusUnauthorized, "incorrect password")
		return
	}
	if _, err := s.Security.Sessions.DeleteExpired(); err != nil && s.Logger != nil {
		s.Logger.Printf("deleting expired sessions: %v", err)
	}
	token, sess, err := s.Security.Sessions.Create(uisession.Label(r.UserAgent()))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not create a session")
		return
	}
	setSessionCookie(w, r, token, int(uisession.Lifetime/time.Second))
	writeJSON(w, http.StatusOK, tosessionDTO(sess, true))
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	sess, ok := currentSession(r)
	if s.Security == nil || !ok {
		writeError(w, http.StatusServiceUnavailable, "authentication is not configured")
		return
	}
	if _, err := s.Security.Sessions.Revoke(sess.Handle); err != nil {
		writeError(w, http.StatusInternalServerError, "could not log out")
		return
	}
	setSessionCookie(w, r, "", -1)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	sess, ok := currentSession(r)
	if s.Security == nil || !ok {
		writeError(w, http.StatusServiceUnavailable, "authentication is not configured")
		return
	}
	writeJSON(w, http.StatusOK, tosessionDTO(sess, true))
}

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	cur, ok := currentSession(r)
	if s.Security == nil || !ok {
		writeError(w, http.StatusServiceUnavailable, "authentication is not configured")
		return
	}
	list, err := s.Security.Sessions.List()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list sessions")
		return
	}
	out := make([]sessionDTO, 0, len(list))
	for _, sess := range list {
		out = append(out, tosessionDTO(sess, sess.Handle == cur.Handle))
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleRevokeSession(w http.ResponseWriter, r *http.Request) {
	cur, ok := currentSession(r)
	if s.Security == nil || !ok {
		writeError(w, http.StatusServiceUnavailable, "authentication is not configured")
		return
	}
	var req struct {
		Handle string `json:"handle"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil || req.Handle == "" {
		writeError(w, http.StatusBadRequest, "missing handle")
		return
	}
	found, err := s.Security.Sessions.Revoke(req.Handle)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not revoke the session")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "no such session")
		return
	}
	if req.Handle == cur.Handle {
		setSessionCookie(w, r, "", -1)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
```

In `internal/webui/server.go`, replace `wrap` with:

```go
// wrap applies the request guards. Outermost first: the Host allowlist, so
// nothing routes a rebound request; then the request-forgery guard; then the
// session check.
func (s *Server) wrap(h http.Handler) http.Handler {
	if s.Security != nil {
		h = s.requireSession(h)
	}
	h = guardMutations(h)
	if s.Security != nil {
		h = hostGuard(s.Security.AllowedHosts, s.Logger, h)
	}
	return h
}
```

Append these entries to the end of the slice `routes()` returns:

```go
		// Authentication. POST /api/login is the one /api/ route
		// requireSession lets through without a session.
		{"POST /api/login", s.handleLogin},
		{"POST /api/logout", s.handleLogout},
		{"GET /api/session", s.handleSession},
		{"GET /api/sessions", s.handleSessions},
		{"POST /api/sessions/revoke", s.handleRevokeSession},
```

- [ ] **Step 4: Run the package and confirm it passes**

Run: `go test ./internal/webui/ -count=1`
Expected: PASS, including every pre-existing test (they build `&Server{}` with no `Security`).

- [ ] **Step 5: Break-check**

1. Temporarily change the prefix check in `requireSession` to `!strings.HasPrefix(r.URL.Path, "/api/thread")`. Run `TestEveryAPIRouteRequiresASession` and confirm it FAILS, naming routes such as `GET /api/worktrees ... status 204, want 401`. Restore it.
2. Temporarily move `h = s.requireSession(h)` to after the `hostGuard` line, making it outermost. Run `TestHostGuardRunsBeforeTheSessionCheck` and confirm it FAILS with status 401. Restore it.

- [ ] **Step 6: Commit**

```bash
git add internal/webui/auth.go internal/webui/auth_test.go internal/webui/server.go
git commit --signoff -F - <<'EOF'
feat(webui): require a login session for every API request

Adds password login, logout, the current session, the device list and
per-device revocation. Every /api/ path except login requires a live
session. The cookie is HttpOnly and SameSite=Lax, and Secure whenever
the login arrived over TLS.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LdwrX6PaoHfKtDBE96EaPx
EOF
```

---
### Task 8: `worktree ui` builds its security settings and drops `--bind`

**Files:**
- Modify: `cmd/ui.go`
- Create: `cmd/ui_security.go`
- Test: `cmd/ui_security_test.go`
- Delete: `cmd/bind.go`, `cmd/bind_test.go`

**Interfaces:**
- Consumes: `config.UIConfig`, `config.PermissionsTooOpen` (Task 2); `uisession.Store` (Task 3); `uitls.ReadCert`, `uitls.Uncovered` (Task 4); `netdetect.Candidates` (Task 5); `webui.Security` (Task 6).
- Produces (package `cmd`):
  - `func buildSecurity(ui config.UIConfig, sessions *uisession.Store, localOnly bool) (*webui.Security, error)`
  - `func checkRemovedFlags(cmd *cobra.Command) error`
  - `func warnConfigPermissions(path string, w io.Writer)`
  - `func certCoverageWarning(certFile string, candidates []string) (string, error)`
  - `func remoteURL(ui config.UIConfig) string`
  - flags: `--local-only`, `--revoke-all-sessions`; `--bind` and `--yes` stay registered only to fail with a pointed error, and are hidden

- [ ] **Step 1: Write the failing tests**

Create `cmd/ui_security_test.go`:

```go
package cmd

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/uisession"
	"github.com/mturley/worktree/internal/uitls"
)

func writeTestCert(t *testing.T, hosts []string) uitls.Paths {
	t.Helper()
	b, err := uitls.Generate(hosts, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	p := uitls.DefaultPaths(t.TempDir())
	if err := uitls.Write(p, b); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestBuildSecurityRequiresAPassword(t *testing.T) {
	for _, localOnly := range []bool{false, true} {
		_, err := buildSecurity(config.UIConfig{}, &uisession.Store{}, localOnly)
		if err == nil || !strings.Contains(err.Error(), "ui.password") || !strings.Contains(err.Error(), "worktree setup") {
			t.Errorf("localOnly=%v: err = %v, want an instructional error naming ui.password and worktree setup", localOnly, err)
		}
	}
}

func TestBuildSecurityWithoutTLSIsLoopbackOnly(t *testing.T) {
	sec, err := buildSecurity(config.UIConfig{Password: "pw", HTTPSPort: 8476}, &uisession.Store{}, false)
	if err != nil {
		t.Fatal(err)
	}
	if sec.Remote() {
		t.Fatal("Remote() = true without a certificate")
	}
}

func TestBuildSecurityEnablesRemoteWhenBothFilesExist(t *testing.T) {
	p := writeTestCert(t, []string{"mturley-mac.local"})
	ui := config.UIConfig{
		Password: "pw", HTTPSPort: 8476, AllowedHosts: []string{"mturley-mac.local"},
		TLS: config.UITLSConfig{CertFile: p.Cert, KeyFile: p.Key},
	}
	sec, err := buildSecurity(ui, &uisession.Store{}, false)
	if err != nil {
		t.Fatal(err)
	}
	if !sec.Remote() || sec.HTTPSPort != 8476 || sec.AllowedHosts[0] != "mturley-mac.local" {
		t.Fatalf("Security = %+v", sec)
	}

	sec, err = buildSecurity(ui, &uisession.Store{}, true)
	if err != nil {
		t.Fatal(err)
	}
	if sec.Remote() {
		t.Fatal("--local-only still enabled the HTTPS listener")
	}
}

func TestBuildSecurityRejectsHalfATLSConfig(t *testing.T) {
	for _, tlsCfg := range []config.UITLSConfig{{CertFile: "c.pem"}, {KeyFile: "k.pem"}} {
		_, err := buildSecurity(config.UIConfig{Password: "pw", TLS: tlsCfg}, &uisession.Store{}, true)
		if err == nil || !strings.Contains(err.Error(), "both cert_file and key_file") {
			t.Errorf("%+v: err = %v", tlsCfg, err)
		}
	}
}

func TestBuildSecurityRejectsAMissingCertificateFile(t *testing.T) {
	dir := t.TempDir()
	ui := config.UIConfig{Password: "pw", TLS: config.UITLSConfig{
		CertFile: filepath.Join(dir, "nope-cert.pem"), KeyFile: filepath.Join(dir, "nope-key.pem"),
	}}
	if _, err := buildSecurity(ui, &uisession.Store{}, false); err == nil || !strings.Contains(err.Error(), "nope-cert.pem") {
		t.Fatalf("err = %v, want it to name the missing file", err)
	}
}

func TestRemovedFlagsFailWithAPointer(t *testing.T) {
	for _, name := range []string{"bind", "yes"} {
		f := uiCmd.Flags().Lookup(name)
		if f == nil {
			t.Fatalf("--%s is not registered; it must stay registered to fail helpfully", name)
		}
		if !f.Hidden {
			t.Errorf("--%s is not hidden", name)
		}
		value := "0.0.0.0"
		if name == "yes" {
			value = "true"
		}
		if err := uiCmd.Flags().Set(name, value); err != nil {
			t.Fatal(err)
		}
		err := checkRemovedFlags(uiCmd)
		f.Changed = false
		if err == nil || !strings.Contains(err.Error(), "worktree setup") {
			t.Errorf("--%s: err = %v, want a pointer to worktree setup", name, err)
		}
	}
	if err := checkRemovedFlags(uiCmd); err != nil {
		t.Fatalf("no removed flags passed: err = %v", err)
	}
}

func TestWarnConfigPermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	warnConfigPermissions(path, &out)
	if out.Len() != 0 {
		t.Fatalf("warned about a 0600 file: %q", out.String())
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	warnConfigPermissions(path, &out)
	if !strings.Contains(out.String(), "chmod 600") {
		t.Fatalf("output %q, want a chmod 600 hint", out.String())
	}
}

func TestCertCoverageWarning(t *testing.T) {
	p := writeTestCert(t, []string{"mturley-mac.local", "192.168.86.21"})
	for _, tc := range []struct {
		candidates []string
		warn       bool
	}{
		{nil, false},
		{[]string{"mturley-mac.local", "192.168.86.21"}, false},
		{[]string{"mturley-mac.local", "192.168.1.50"}, false}, // the name still works
		{[]string{"other-mac.local", "192.168.1.50"}, true},
	} {
		msg, err := certCoverageWarning(p.Cert, tc.candidates)
		if err != nil {
			t.Fatal(err)
		}
		if (msg != "") != tc.warn {
			t.Errorf("candidates %v: warning %q, want warn=%v", tc.candidates, msg, tc.warn)
		}
		if tc.warn && !strings.Contains(msg, "192.168.1.50") {
			t.Errorf("warning %q does not name the uncovered address", msg)
		}
	}
}

func TestRemoteURL(t *testing.T) {
	for _, tc := range []struct {
		hosts []string
		want  string
	}{
		{nil, ""},
		{[]string{"mturley-mac.local", "192.168.86.21"}, "https://mturley-mac.local:8476"},
		{[]string{"fd00::5"}, "https://[fd00::5]:8476"},
	} {
		if got := remoteURL(config.UIConfig{HTTPSPort: 8476, AllowedHosts: tc.hosts}); got != tc.want {
			t.Errorf("remoteURL(%v) = %q, want %q", tc.hosts, got, tc.want)
		}
	}
}
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `go test ./cmd/ -run 'TestBuildSecurity|TestRemovedFlags|TestWarnConfig|TestCertCoverage|TestRemoteURL' -count=1`
Expected: FAIL to compile, with `undefined: buildSecurity`.

- [ ] **Step 3: Implement the helpers**

Create `cmd/ui_security.go`:

```go
package cmd

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/uisession"
	"github.com/mturley/worktree/internal/uitls"
	"github.com/mturley/worktree/internal/webui"
	"github.com/spf13/cobra"
)

// buildSecurity turns the ui config into the server's security settings and
// refuses any configuration the web UI does not allow. With localOnly, no
// HTTPS listener is configured even when a certificate is.
func buildSecurity(ui config.UIConfig, sessions *uisession.Store, localOnly bool) (*webui.Security, error) {
	if ui.Password == "" {
		return nil, fmt.Errorf(`the web UI requires a password, and none is configured.

  Run "worktree setup" to generate one, or set ui.password yourself in
  %s

  The password is required on every listener, including 127.0.0.1`, config.ConfigPath())
	}
	sec := &webui.Security{
		Password:     ui.Password,
		Sessions:     sessions,
		AllowedHosts: ui.AllowedHosts,
		HTTPSPort:    ui.HTTPSPort,
	}
	cert, key := ui.TLS.CertFile, ui.TLS.KeyFile
	if (cert == "") != (key == "") {
		return nil, errors.New(`ui.tls needs both cert_file and key_file, and only one is set. Run "worktree setup" to reissue them`)
	}
	if cert == "" || localOnly {
		return sec, nil
	}
	for _, f := range []string{cert, key} {
		if _, err := os.Stat(f); err != nil {
			return nil, fmt.Errorf(`ui.tls file %s: %w. Run "worktree setup" to reissue it`, f, err)
		}
	}
	sec.CertFile, sec.KeyFile = cert, key
	return sec, nil
}

// checkRemovedFlags fails on --bind and --yes. Both are kept registered, and
// hidden, only so that an old launch command gets this pointer rather than
// "unknown flag".
func checkRemovedFlags(cmd *cobra.Command) error {
	if cmd.Flags().Changed("bind") || cmd.Flags().Changed("yes") {
		return errors.New(`--bind and --yes have been removed. The web UI now serves plain HTTP on 127.0.0.1 only; other devices connect over HTTPS once remote access is configured. Run "worktree setup" to configure it, and drop these flags from the launch command`)
	}
	return nil
}

// warnConfigPermissions warns when the config file, which holds the web UI
// password, is readable by anyone but its owner.
func warnConfigPermissions(path string, w io.Writer) {
	open, err := config.PermissionsTooOpen(path)
	if err != nil || !open {
		return
	}
	fmt.Fprintf(w, "warning: %s holds the web UI password and is readable by other users. Run: chmod 600 %s\n", path, path)
}

// certCoverageWarning returns a warning when the certificate covers none of
// this machine's currently detected addresses, or "" when it covers any of
// them (or nothing was detected).
func certCoverageWarning(certFile string, candidates []string) (string, error) {
	if len(candidates) == 0 {
		return "", nil
	}
	cert, err := uitls.ReadCert(certFile)
	if err != nil {
		return "", err
	}
	uncovered := uitls.Uncovered(cert, candidates)
	if len(uncovered) < len(candidates) {
		return "", nil
	}
	return fmt.Sprintf(`the HTTPS certificate does not cover this machine's current address (%s), so other devices will get a certificate error. Run "worktree setup" and change the remote access addresses`,
		strings.Join(uncovered, ", ")), nil
}

// remoteURL is the address to open on another device, or "" if none is set.
func remoteURL(ui config.UIConfig) string {
	if len(ui.AllowedHosts) == 0 {
		return ""
	}
	return "https://" + net.JoinHostPort(ui.AllowedHosts[0], strconv.Itoa(ui.HTTPSPort))
}
```

- [ ] **Step 4: Rewire `cmd/ui.go`**

1. Replace the `var (...)` flag block and `init` with:

```go
var (
	uiPort          int
	uiNoOpen        bool
	uiAPIOnly       bool
	uiLocalOnly     bool
	uiRevokeAll     bool
	uiRemovedBind   string
	uiRemovedAssume bool
)

var uiCmd = &cobra.Command{
	Use:     "ui",
	Short:   "Start the worktree web UI",
	GroupID: "worktree",
	RunE:    runUI,
}

func init() {
	uiCmd.Flags().IntVar(&uiPort, "port", defaultUIPort, "HTTP server port (always bound to 127.0.0.1)")
	uiCmd.Flags().BoolVar(&uiNoOpen, "no-open", false, "do not open the browser")
	uiCmd.Flags().BoolVar(&uiAPIOnly, "api-only", false, "serve API only (for use with the Vite dev server); implies --local-only")
	uiCmd.Flags().BoolVar(&uiLocalOnly, "local-only", false, "do not start the HTTPS listener for other devices")
	uiCmd.Flags().BoolVar(&uiRevokeAll, "revoke-all-sessions", false, "log out every device, then exit")
	// Removed. Registered only so checkRemovedFlags can explain.
	uiCmd.Flags().StringVar(&uiRemovedBind, "bind", "", "removed; see worktree setup")
	uiCmd.Flags().BoolVar(&uiRemovedAssume, "yes", false, "removed; see worktree setup")
	_ = uiCmd.Flags().MarkHidden("bind")
	_ = uiCmd.Flags().MarkHidden("yes")
	rootCmd.AddCommand(uiCmd)
}
```

2. Replace the beginning of `runUI`, from the function signature through the end of the `confirmBind` block, with:

```go
func runUI(cmd *cobra.Command, args []string) error {
	if err := checkRemovedFlags(cmd); err != nil {
		return err
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	conn, err := wdb.Open()
	if err != nil {
		return fmt.Errorf("opening worktree db: %w", err)
	}
	defer conn.Close()
	sessions := &uisession.Store{DB: conn}

	if uiRevokeAll {
		n, err := sessions.RevokeAll()
		if err != nil {
			return fmt.Errorf("revoking sessions: %w", err)
		}
		fmt.Printf("Logged out %d session(s). Every device must log in again.\n", n)
		return nil
	}

	// If a worktree UI is already listening on the port, don't abort with an
	// "address already in use" error — just open the running one in the browser
	// (unless --no-open / --api-only) and exit successfully.
	if serverAlreadyListening(uiPort) {
		openURL := fmt.Sprintf("http://127.0.0.1:%d%s", uiPort, detailPathForCwd(conn))
		fmt.Printf("worktree UI already running on %s — opening in browser\n", openURL)
		if !uiNoOpen && !uiAPIOnly {
			openBrowser(openURL)
		}
		return nil
	}

	sec, err := buildSecurity(cfg.UI, sessions, uiLocalOnly || uiAPIOnly)
	if err != nil {
		return err
	}
	warnConfigPermissions(config.ConfigPath(), os.Stderr)
```

3. After `logger := log.New(...)`, add:

```go
	if _, err := sessions.DeleteExpired(); err != nil {
		logger.Printf("deleting expired sessions: %v", err)
	}
	if sec.Remote() {
		if msg, err := certCoverageWarning(sec.CertFile, netdetect.Candidates()); err != nil {
			logger.Printf("warning: reading the HTTPS certificate: %v", err)
		} else if msg != "" {
			logger.Printf("warning: %s", msg)
		}
		if u := remoteURL(cfg.UI); u != "" {
			logger.Printf("open on other devices: %s", u)
		}
	}
```

4. In the `webui.Server` literal, add `Security: sec,`.

5. Delete `stdinIsTerminal` and `isTerminalFile` with their comments. Remove `golang.org/x/term` from this file's imports, and add `"github.com/mturley/worktree/internal/config"`, `"github.com/mturley/worktree/internal/netdetect"` and `"github.com/mturley/worktree/internal/uisession"`.

6. Delete `cmd/bind.go` and `cmd/bind_test.go`:

```bash
git rm cmd/bind.go cmd/bind_test.go
```

Before deleting, run `grep -rn 'bindIsLoopback\|confirmBind\|errBindDeclined\|isTerminalFile\|stdinIsTerminal' --include='*.go' .` and confirm the only hits are in those two files and the lines removed above.

- [ ] **Step 5: Run the module and confirm it passes**

Run: `go build ./... && go vet ./cmd/ && go test ./cmd/ ./internal/... -count=1`
Expected: PASS. `go vet` reports nothing.

- [ ] **Step 6: Commit**

```bash
git add cmd/ui.go cmd/ui_security.go cmd/ui_security_test.go
git commit --signoff -F - <<'EOF'
feat(cmd): start the web UI with authentication and remote access

worktree ui now requires ui.password, serves HTTPS to other devices when
setup has issued a certificate, warns when that certificate no longer
covers this machine's address, and gains --local-only and
--revoke-all-sessions. --bind and --yes are removed and fail with a
pointer to worktree setup.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LdwrX6PaoHfKtDBE96EaPx
EOF
```

The `git rm` in Step 4 has already staged the deletions, so they land in this commit.

---
### Task 9: Setup generates the password and configures remote access

**Files:**
- Create: `internal/setup/uiaccess.go`
- Test: `internal/setup/uiaccess_test.go`
- Modify: `internal/setup/setup.go` (`Plan`, `BuildPlan`, `Preview`, `HasWork`, `Execute`, `PreviewUninstall`, `ExecuteUninstall`)

**Interfaces:**
- Consumes: `config.UIConfig`, `writeConfig` (Task 2); `uitls` (Task 4); `netdetect.Candidates` (Task 5).
- Produces (package `setup`, unexported):
  - `type uiIO interface { ConfirmDefault(prompt string, defaultYes bool) bool; PromptLine(prompt string) string; Printf(format string, args ...any) }`
  - `type uiAccessDeps struct { io uiIO; detect func() []string; paths uitls.Paths; now func() time.Time; random io.Reader }`
  - `func ensurePassword(cfg *config.Config, d uiAccessDeps) (bool, error)`
  - `func configureRemoteAccess(cfg *config.Config, d uiAccessDeps) (bool, error)`
  - `func configureUI(configPath string, d uiAccessDeps) error`
  - `func removeRemoteAccess(configPath string, d uiAccessDeps) error`

**Prompt flow**, which the tests script answer by answer:

| State | Prompts, in order |
|---|---|
| Not configured | `Enable HTTPS access to the web UI from other devices (e.g. your phone)?` [y/N] → if yes: list detected → `Use these addresses?` [Y/n] (only if anything was detected) → if no: `Which IP address should other devices use? (Enter to skip)`, repeated until it gets an IP or an empty answer |
| Configured, certificate unreadable | `Re-issue it?` [Y/n] → if no, continue to the "change" prompt |
| Configured, expires within 30 days | `Renew it now?` [Y/n] → if no, continue to the "change" prompt |
| Configured | `Change remote access addresses?` [y/N] → if yes: the same address flow as above, with an empty answer keeping the existing addresses |

- [ ] **Step 1: Write the failing tests**

Create `internal/setup/uiaccess_test.go`:

```go
package setup

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/uitls"
)

// scriptedIO answers prompts from queues and fails the test on any prompt it
// was not scripted for.
type scriptedIO struct {
	t        *testing.T
	confirms []bool
	lines    []string
	prompts  []string
	out      strings.Builder
}

func (s *scriptedIO) ConfirmDefault(prompt string, _ bool) bool {
	s.prompts = append(s.prompts, prompt)
	if len(s.confirms) == 0 {
		s.t.Fatalf("unscripted confirm: %q", prompt)
	}
	v := s.confirms[0]
	s.confirms = s.confirms[1:]
	return v
}

func (s *scriptedIO) PromptLine(prompt string) string {
	s.prompts = append(s.prompts, prompt)
	if len(s.lines) == 0 {
		s.t.Fatalf("unscripted prompt: %q", prompt)
	}
	v := s.lines[0]
	s.lines = s.lines[1:]
	return v
}

func (s *scriptedIO) Printf(format string, args ...any) { fmt.Fprintf(&s.out, format, args...) }

func (s *scriptedIO) done() {
	s.t.Helper()
	if len(s.confirms) != 0 || len(s.lines) != 0 {
		s.t.Fatalf("unused answers: confirms %v, lines %v", s.confirms, s.lines)
	}
}

func (s *scriptedIO) asked(substr string) bool {
	return slices.ContainsFunc(s.prompts, func(p string) bool { return strings.Contains(p, substr) })
}

var setupNow = time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)

func testDeps(t *testing.T, io *scriptedIO, detected ...string) uiAccessDeps {
	return uiAccessDeps{
		io:     io,
		detect: func() []string { return detected },
		paths:  uitls.DefaultPaths(t.TempDir()),
		now:    func() time.Time { return setupNow },
		random: bytes.NewReader(bytes.Repeat([]byte{7}, 64)),
	}
}

func TestEnsurePasswordGeneratesAndPrintsOnce(t *testing.T) {
	io := &scriptedIO{t: t}
	cfg := config.DefaultConfig()
	changed, err := ensurePassword(&cfg, testDeps(t, io))
	if err != nil || !changed {
		t.Fatalf("ensurePassword = %v, %v", changed, err)
	}
	if len(cfg.UI.Password) != 24 {
		t.Fatalf("password %q: want 24 characters", cfg.UI.Password)
	}
	if !strings.Contains(io.out.String(), cfg.UI.Password) {
		t.Fatal("the generated password was not shown; the user needs it to log in")
	}
}

func TestEnsurePasswordKeepsAnExistingOne(t *testing.T) {
	io := &scriptedIO{t: t}
	cfg := config.DefaultConfig()
	cfg.UI.Password = "mine"
	changed, err := ensurePassword(&cfg, testDeps(t, io))
	if err != nil || changed || cfg.UI.Password != "mine" {
		t.Fatalf("ensurePassword = %v, %v; password %q", changed, err, cfg.UI.Password)
	}
	if strings.Contains(io.out.String(), "mine") {
		t.Fatal("an existing password was printed")
	}
}

func TestRemoteAccessIsOffByDefault(t *testing.T) {
	io := &scriptedIO{t: t, confirms: []bool{false}}
	d := testDeps(t, io, "mturley-mac.local")
	cfg := config.DefaultConfig()
	changed, err := configureRemoteAccess(&cfg, d)
	io.done()
	if err != nil || changed || cfg.UI.RemoteEnabled() {
		t.Fatalf("configureRemoteAccess = %v, %v", changed, err)
	}
	if _, err := os.Stat(d.paths.CA); err == nil {
		t.Fatal("a certificate was written after declining")
	}
}

func TestRemoteAccessAcceptsDetectedAddresses(t *testing.T) {
	io := &scriptedIO{t: t, confirms: []bool{true, true}}
	d := testDeps(t, io, "mturley-mac.local", "192.168.86.21")
	cfg := config.DefaultConfig()
	changed, err := configureRemoteAccess(&cfg, d)
	io.done()
	if err != nil || !changed {
		t.Fatalf("configureRemoteAccess = %v, %v", changed, err)
	}
	if strings.Join(cfg.UI.AllowedHosts, ",") != "mturley-mac.local,192.168.86.21" {
		t.Fatalf("AllowedHosts = %v", cfg.UI.AllowedHosts)
	}
	if cfg.UI.TLS.CertFile != d.paths.Cert || cfg.UI.TLS.KeyFile != d.paths.Key {
		t.Fatalf("TLS = %+v, want %+v", cfg.UI.TLS, d.paths)
	}
	cert, err := uitls.ReadCert(d.paths.Cert)
	if err != nil {
		t.Fatal(err)
	}
	if got := uitls.Uncovered(cert, cfg.UI.AllowedHosts); len(got) != 0 {
		t.Fatalf("certificate does not cover %v", got)
	}
	out := io.out.String()
	for _, want := range []string{d.paths.CA, "https://mturley-mac.local:8476", "network may be monitored"} {
		if !strings.Contains(out, want) {
			t.Errorf("output does not mention %q:\n%s", want, out)
		}
	}
}

func TestRemoteAccessDeclinedDetectionAsksForAnIP(t *testing.T) {
	io := &scriptedIO{t: t, confirms: []bool{true, false}, lines: []string{"not-an-ip", "192.168.1.50"}}
	d := testDeps(t, io, "mturley-mac.local", "192.168.86.21")
	cfg := config.DefaultConfig()
	changed, err := configureRemoteAccess(&cfg, d)
	io.done()
	if err != nil || !changed {
		t.Fatalf("configureRemoteAccess = %v, %v", changed, err)
	}
	if strings.Join(cfg.UI.AllowedHosts, ",") != "192.168.1.50" {
		t.Fatalf("AllowedHosts = %v, want only the typed IP", cfg.UI.AllowedHosts)
	}
	if !strings.Contains(io.out.String(), "not an IP address") {
		t.Error("an invalid answer was not explained")
	}
}

func TestRemoteAccessEmptyAnswerSkips(t *testing.T) {
	io := &scriptedIO{t: t, confirms: []bool{true, false}, lines: []string{""}}
	d := testDeps(t, io, "mturley-mac.local")
	cfg := config.DefaultConfig()
	changed, err := configureRemoteAccess(&cfg, d)
	io.done()
	if err != nil || changed || cfg.UI.RemoteEnabled() {
		t.Fatalf("configureRemoteAccess = %v, %v", changed, err)
	}
	if entries, _ := os.ReadDir(filepath.Dir(d.paths.CA)); len(entries) != 0 {
		t.Fatalf("files written after skipping: %v", entries)
	}
}

func TestRemoteAccessWithNothingDetectedGoesStraightToThePrompt(t *testing.T) {
	io := &scriptedIO{t: t, confirms: []bool{true}, lines: []string{"10.0.0.7"}}
	cfg := config.DefaultConfig()
	changed, err := configureRemoteAccess(&cfg, testDeps(t, io))
	io.done()
	if err != nil || !changed {
		t.Fatalf("configureRemoteAccess = %v, %v", changed, err)
	}
	if io.asked("Use these addresses") {
		t.Fatal("offered detected addresses when none were detected")
	}
}

// configured returns a config whose remote access was set up by the real flow.
func configured(t *testing.T, d uiAccessDeps) config.Config {
	t.Helper()
	cfg := config.DefaultConfig()
	setupIO := d.io
	d.io = &scriptedIO{t: t, confirms: []bool{true, true}}
	if _, err := configureRemoteAccess(&cfg, d); err != nil {
		t.Fatal(err)
	}
	d.io = setupIO
	return cfg
}

func TestConfiguredDecliningChangeTouchesNothing(t *testing.T) {
	io := &scriptedIO{t: t, confirms: []bool{false}}
	d := testDeps(t, io, "mturley-mac.local")
	cfg := configured(t, d)
	before, _ := os.ReadFile(d.paths.Cert)
	beforeKey, _ := os.ReadFile(d.paths.Key)
	beforeCfg := cfg

	changed, err := configureRemoteAccess(&cfg, d)
	io.done()
	if err != nil || changed {
		t.Fatalf("configureRemoteAccess = %v, %v", changed, err)
	}
	after, _ := os.ReadFile(d.paths.Cert)
	afterKey, _ := os.ReadFile(d.paths.Key)
	if !bytes.Equal(before, after) || !bytes.Equal(beforeKey, afterKey) {
		t.Fatal("certificate or key rewritten after declining to change")
	}
	if !slices.Equal(beforeCfg.UI.AllowedHosts, cfg.UI.AllowedHosts) || beforeCfg.UI.TLS != cfg.UI.TLS {
		t.Fatal("config changed after declining to change")
	}
	if !strings.Contains(io.out.String(), "https://mturley-mac.local:8476") {
		t.Errorf("current addresses not shown:\n%s", io.out.String())
	}
}

func TestConfiguredAcceptingChangeReissues(t *testing.T) {
	io := &scriptedIO{t: t, confirms: []bool{true, false}, lines: []string{"192.168.1.50"}}
	d := testDeps(t, io, "mturley-mac.local")
	cfg := configured(t, d)
	before, _ := os.ReadFile(d.paths.CA)

	changed, err := configureRemoteAccess(&cfg, d)
	io.done()
	if err != nil || !changed {
		t.Fatalf("configureRemoteAccess = %v, %v", changed, err)
	}
	after, _ := os.ReadFile(d.paths.CA)
	if bytes.Equal(before, after) {
		t.Fatal("CA not reissued")
	}
	if strings.Join(cfg.UI.AllowedHosts, ",") != "192.168.1.50" {
		t.Fatalf("AllowedHosts = %v", cfg.UI.AllowedHosts)
	}
	if !strings.Contains(io.out.String(), "remove the old") {
		t.Errorf("no reinstall warning:\n%s", io.out.String())
	}
}

func TestConfiguredEmptyAnswerKeepsExistingAddresses(t *testing.T) {
	io := &scriptedIO{t: t, confirms: []bool{true, false}, lines: []string{""}}
	d := testDeps(t, io, "mturley-mac.local")
	cfg := configured(t, d)
	changed, err := configureRemoteAccess(&cfg, d)
	io.done()
	if err != nil || changed || strings.Join(cfg.UI.AllowedHosts, ",") != "mturley-mac.local" {
		t.Fatalf("configureRemoteAccess = %v, %v; hosts %v", changed, err, cfg.UI.AllowedHosts)
	}
}

func TestConfiguredOffersRenewalNearExpiry(t *testing.T) {
	io := &scriptedIO{t: t, confirms: []bool{true}}
	d := testDeps(t, io, "mturley-mac.local")
	cfg := configured(t, d)
	old, _ := uitls.ReadCert(d.paths.Cert)

	later := setupNow.Add(uitls.LeafValidity - 10*24*time.Hour)
	d.now = func() time.Time { return later }
	changed, err := configureRemoteAccess(&cfg, d)
	io.done()
	if err != nil || !changed {
		t.Fatalf("configureRemoteAccess = %v, %v", changed, err)
	}
	renewed, _ := uitls.ReadCert(d.paths.Cert)
	if !renewed.NotAfter.After(old.NotAfter) {
		t.Fatalf("NotAfter %v not later than %v", renewed.NotAfter, old.NotAfter)
	}
	if !io.asked("Renew") || io.asked("Change remote access") {
		t.Fatalf("prompts = %v, want renewal and no change prompt", io.prompts)
	}
}

func TestConfigureUIWritesAnOwnerOnlyConfig(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	io := &scriptedIO{t: t, confirms: []bool{false}}
	d := testDeps(t, io)
	if err := configureUI(config.ConfigPath(), d); err != nil {
		t.Fatal(err)
	}
	io.done()
	info, err := os.Stat(config.ConfigPath())
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("config mode %v, want 0600", info.Mode().Perm())
	}
	cfg, _ := config.Load()
	if cfg.UI.Password == "" {
		t.Fatal("password not saved")
	}
}

func TestRemoveRemoteAccess(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	io := &scriptedIO{t: t}
	d := testDeps(t, io, "mturley-mac.local")
	cfg := configured(t, d)
	cfg.UI.Password = "keep-me"
	if err := writeConfig(config.ConfigPath(), cfg); err != nil {
		t.Fatal(err)
	}

	if err := removeRemoteAccess(config.ConfigPath(), d); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{d.paths.CA, d.paths.Cert, d.paths.Key} {
		if _, err := os.Stat(f); err == nil {
			t.Errorf("%s still exists", f)
		}
	}
	got, _ := config.Load()
	if got.UI.RemoteEnabled() || len(got.UI.AllowedHosts) != 0 || got.UI.Password != "keep-me" {
		t.Fatalf("UI after uninstall = %+v; want TLS and hosts cleared, password kept", got.UI)
	}
	if !strings.Contains(io.out.String(), "Trusted credentials") {
		t.Errorf("no phone removal steps:\n%s", io.out.String())
	}
}

func TestRemoveRemoteAccessWithNothingConfiguredWritesNothing(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	io := &scriptedIO{t: t}
	if err := removeRemoteAccess(config.ConfigPath(), testDeps(t, io)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(config.ConfigPath()); err == nil {
		t.Fatal("uninstall created a config file")
	}
}
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `go test ./internal/setup/ -count=1`
Expected: FAIL to compile, with `undefined: uiAccessDeps`.

- [ ] **Step 3: Implement**

Create `internal/setup/uiaccess.go`:

```go
package setup

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/netdetect"
	"github.com/mturley/worktree/internal/uitls"
	"github.com/mturley/worktree/internal/ui"
)

// renewWindow is how close to expiry setup offers to renew the certificate.
const renewWindow = 30 * 24 * time.Hour

// uiIO is the terminal interaction the web UI steps need, so tests can
// script the answers.
type uiIO interface {
	ConfirmDefault(prompt string, defaultYes bool) bool
	PromptLine(prompt string) string
	Printf(format string, args ...any)
}

type terminalIO struct{}

func (terminalIO) ConfirmDefault(p string, d bool) bool { return ui.ConfirmDefault(p, d) }
func (terminalIO) PromptLine(p string) string           { return ui.PromptLine(p) }
func (terminalIO) Printf(f string, a ...any)            { fmt.Printf(f, a...) }

type uiAccessDeps struct {
	io     uiIO
	detect func() []string
	paths  uitls.Paths
	now    func() time.Time
	random io.Reader
}

func defaultUIAccessDeps(configPath string) uiAccessDeps {
	return uiAccessDeps{
		io:     terminalIO{},
		detect: netdetect.Candidates,
		paths:  uitls.DefaultPaths(filepath.Dir(configPath)),
		now:    time.Now,
		random: rand.Reader,
	}
}

// configureUI runs the web UI steps and saves the config if either changed
// it. It reloads the config first: earlier steps in this run may have
// written it, and saving a stale copy would undo them.
func configureUI(configPath string, d uiAccessDeps) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	d.io.Printf("\n%s\n", ui.Bold("Web UI:"))
	pw, err := ensurePassword(&cfg, d)
	if err != nil {
		return err
	}
	remote, err := configureRemoteAccess(&cfg, d)
	if err != nil {
		return err
	}
	if !pw && !remote {
		return writeConfigIfLoose(configPath, cfg)
	}
	if err := writeConfig(configPath, cfg); err != nil {
		return err
	}
	d.io.Printf("  %s Updated %s\n", ui.Green("✓"), ui.ShortPath(configPath))
	return nil
}

// writeConfigIfLoose rewrites an existing config only to tighten its mode:
// it may hold a password from before setup wrote configs owner-only.
func writeConfigIfLoose(configPath string, cfg config.Config) error {
	open, err := config.PermissionsTooOpen(configPath)
	if err != nil || !open || cfg.UI.Password == "" {
		return err
	}
	return writeConfig(configPath, cfg)
}

// ensurePassword generates a password when none is configured, and prints it
// once, because the user needs it to log in from another device.
func ensurePassword(cfg *config.Config, d uiAccessDeps) (bool, error) {
	if cfg.UI.Password != "" {
		return false, nil
	}
	b := make([]byte, 18)
	if _, err := io.ReadFull(d.random, b); err != nil {
		return false, fmt.Errorf("generating a password: %w", err)
	}
	cfg.UI.Password = base64.RawURLEncoding.EncodeToString(b)
	d.io.Printf("  %s Generated a web UI password: %s\n", ui.Green("✓"), cfg.UI.Password)
	d.io.Printf("    It is saved as ui.password in the worktree config.\n")
	return true, nil
}

// configureRemoteAccess sets up, renews or changes the HTTPS listener's
// certificate and addresses. It reports whether it changed cfg.
func configureRemoteAccess(cfg *config.Config, d uiAccessDeps) (bool, error) {
	if !cfg.UI.RemoteEnabled() {
		if !d.io.ConfirmDefault("  Enable HTTPS access to the web UI from other devices (e.g. your phone)?", false) {
			return false, nil
		}
		hosts := chooseRemoteHosts(d)
		if hosts == nil {
			d.io.Printf("  %s Skipped remote access\n", ui.Dim("—"))
			return false, nil
		}
		return true, issueCertificate(cfg, hosts, d)
	}

	d.io.Printf("  Remote access: %s\n", describeRemote(cfg.UI))
	cert, err := uitls.ReadCert(cfg.UI.TLS.CertFile)
	switch {
	case err != nil:
		d.io.Printf("  %s Could not read the certificate: %v\n", ui.Yellow("!"), err)
		if d.io.ConfirmDefault("  Re-issue it?", true) {
			return true, reissue(cfg, cfg.UI.AllowedHosts, d)
		}
	case cert.NotAfter.Sub(d.now()) < renewWindow:
		d.io.Printf("  %s Certificate expires %s\n", ui.Yellow("!"), cert.NotAfter.Format("2006-01-02"))
		if d.io.ConfirmDefault("  Renew it now?", true) {
			return true, reissue(cfg, cfg.UI.AllowedHosts, d)
		}
	default:
		d.io.Printf("  Certificate expires %s\n", cert.NotAfter.Format("2006-01-02"))
	}

	if !d.io.ConfirmDefault("  Change remote access addresses?", false) {
		return false, nil
	}
	hosts := chooseRemoteHosts(d)
	if hosts == nil {
		d.io.Printf("  %s Kept the existing addresses\n", ui.Dim("—"))
		return false, nil
	}
	return true, reissue(cfg, hosts, d)
}

// chooseRemoteHosts offers the detected addresses, then falls back to asking
// for an IP. nil means the user skipped.
func chooseRemoteHosts(d uiAccessDeps) []string {
	if candidates := d.detect(); len(candidates) > 0 {
		d.io.Printf("\n  Detected:\n")
		for _, c := range candidates {
			d.io.Printf("    %s\n", c)
		}
		if d.io.ConfirmDefault("  Use these addresses?", true) {
			return candidates
		}
	}
	for {
		answer := strings.TrimSpace(d.io.PromptLine("  Which IP address should other devices use? (Enter to skip)"))
		if answer == "" {
			return nil
		}
		if net.ParseIP(answer) != nil {
			return []string{answer}
		}
		d.io.Printf("  %s %q is not an IP address\n", ui.Yellow("!"), answer)
	}
}

// reissue replaces an existing certificate. The old CA's key no longer
// exists, so the phone needs the new CA.
func reissue(cfg *config.Config, hosts []string, d uiAccessDeps) error {
	d.io.Printf("  %s This creates a new CA. On your phone, remove the old %q certificate and install the new one.\n",
		ui.Yellow("!"), uitls.CACommonName)
	return issueCertificate(cfg, hosts, d)
}

func issueCertificate(cfg *config.Config, hosts []string, d uiAccessDeps) error {
	bundle, err := uitls.Generate(hosts, d.now())
	if err != nil {
		return fmt.Errorf("generating the certificate: %w", err)
	}
	if err := uitls.Write(d.paths, bundle); err != nil {
		return err
	}
	cfg.UI.AllowedHosts = hosts
	cfg.UI.TLS = config.UITLSConfig{CertFile: d.paths.Cert, KeyFile: d.paths.Key}
	if cfg.UI.HTTPSPort == 0 {
		cfg.UI.HTTPSPort = config.DefaultHTTPSPort
	}
	d.io.Printf("  %s Issued an HTTPS certificate for %s, valid until %s\n",
		ui.Green("✓"), strings.Join(hosts, ", "), bundle.NotAfter.Format("2006-01-02"))
	d.io.Printf(`
    To use it from your phone:
      1. Copy %s to the phone (for example by email or USB).
      2. Android: Settings → Security → Encryption & credentials → Install a
         certificate → CA certificate. Menu names vary by Android version.
      3. Open %s

    While this CA is installed, Android shows a persistent
    "network may be monitored" notice. That is expected for any
    user-installed CA and does not mean anything is wrong.

    Renewal: run "worktree setup" again before %s.
`, d.paths.CA, remoteURLFor(cfg.UI), bundle.NotAfter.Format("2006-01-02"))
	return nil
}

func describeRemote(u config.UIConfig) string {
	s := remoteURLFor(u)
	if len(u.AllowedHosts) > 1 {
		s += " (also " + strings.Join(u.AllowedHosts[1:], ", ") + ")"
	}
	return s
}

func remoteURLFor(u config.UIConfig) string {
	if len(u.AllowedHosts) == 0 {
		return ""
	}
	return "https://" + net.JoinHostPort(u.AllowedHosts[0], strconv.Itoa(u.HTTPSPort))
}

// removeRemoteAccess deletes the certificate files and clears ui.tls and
// ui.allowed_hosts, keeping the password. It writes the config only if it
// had something to clear.
func removeRemoteAccess(configPath string, d uiAccessDeps) error {
	removed, err := uitls.Remove(d.paths)
	for _, f := range removed {
		d.io.Printf("  %s Removed %s\n", ui.Green("✓"), f)
	}
	if err != nil {
		return err
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	cleared := cfg.UI.TLS != (config.UITLSConfig{}) || len(cfg.UI.AllowedHosts) > 0
	if cleared {
		cfg.UI.TLS = config.UITLSConfig{}
		cfg.UI.AllowedHosts = nil
		if err := writeConfig(configPath, cfg); err != nil {
			return err
		}
		d.io.Printf("  %s Cleared remote access from %s\n", ui.Green("✓"), ui.ShortPath(configPath))
	}
	if len(removed) > 0 || cleared {
		d.io.Printf(`
    Also remove the CA from your phone. Android: Settings → Security →
    Encryption & credentials → Trusted credentials → User → %q → Remove.
`, uitls.CACommonName)
	}
	return nil
}
```

`cmd/ui_security.go` (Task 8) has its own `remoteURL`. The setup package cannot import `cmd`, so `remoteURLFor` is a deliberate small duplicate. Both are four lines and both are tested.

- [ ] **Step 4: Wire it into the plan and uninstall**

In `internal/setup/setup.go`:

1. Add `ConfigureUI bool` to `Plan`, after `TestJiraCreds`.
2. In `BuildPlan`, after `plan.TestJiraCreds = true`, add `plan.ConfigureUI = true`.
3. In `Preview`, after the `p.ConfigureJiraProjects` block, add:

```go
	if p.ConfigureUI {
		fmt.Println("  • Configure the web UI password and HTTPS access from other devices")
	}
```

4. In `HasWork`, add `|| p.ConfigureUI` to the returned expression.
5. In `Execute`, before the final `return nil`, add:

```go
	if p.ConfigureUI {
		if err := configureUI(p.ConfigPath, defaultUIAccessDeps(p.ConfigPath)); err != nil {
			return fmt.Errorf("configuring the web UI: %w", err)
		}
	}
```

6. In `PreviewUninstall`, before the "Preserve worktree data" line, add:

```go
	fmt.Println("  • Remove the web UI's HTTPS certificate files and remote access settings (the password is kept)")
```

7. In `ExecuteUninstall`, after `removeAllCompletions()`, add:

```go
	if err := removeRemoteAccess(configPath, defaultUIAccessDeps(configPath)); err != nil {
		fmt.Printf("  %s Removing web UI remote access: %v\n", ui.Yellow("!"), err)
	}
```

- [ ] **Step 5: Run the package and confirm it passes**

Run: `go build ./... && go test ./internal/setup/ -count=1`
Expected: PASS.

**Do not run `worktree setup` itself to check this.** It edits the real shell RC, installs completions and tests live credentials, and `XDG_CONFIG_HOME` does not contain those side effects. Non-interactive runs (`NONINTERACTIVE=1 make install`) stay safe by construction: `ui.ConfirmDefault` returns its default on EOF, so the enable prompt declines, and `ui.PromptLine` returns `""`, which the IP prompt treats as "skip". `TestRemoteAccessIsOffByDefault` and `TestRemoteAccessEmptyAnswerSkips` cover those two answers.

- [ ] **Step 6: Commit**

```bash
git add internal/setup/uiaccess.go internal/setup/uiaccess_test.go internal/setup/setup.go
git commit --signoff -F - <<'EOF'
feat(setup): generate the web UI password and configure HTTPS access

Setup now generates ui.password when none is set, and offers HTTPS access
from other devices. It detects this Mac's .local name and LAN IP, falls
back to asking for an IP, and on later runs offers to renew the
certificate or change the addresses. Uninstall removes the certificate
files and the remote access settings, and explains how to remove the CA
from the phone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LdwrX6PaoHfKtDBE96EaPx
EOF
```

---
### Task 10: Login screen and the authentication gate

**Files:**
- Modify: `ui/src/api/client.ts`
- Modify: `ui/src/api/types.ts`
- Modify: `ui/src/api/slackApi.ts`
- Create: `ui/src/hooks/useSession.ts`
- Create: `ui/src/pages/LoginPage.tsx`
- Modify: `ui/src/App.tsx`
- Test: `ui/src/api/client.test.ts` (append)
- Test: `ui/src/App.test.tsx` (create)

**Interfaces:**
- Consumes: the Task 7 HTTP API, including the `X-Worktree-Login-Required: 1` header.
- Produces:
  - `client.ts`: `class HttpError extends Error { status: number }`, `const LOGIN_REQUIRED_EVENT = "worktree:login-required"`, `function reportIfLoginRequired(res: Response): boolean`, and `api.session()`, `api.login(password)`, `api.sessions()`, `api.revokeSession(handle)`
  - `types.ts`: `interface SessionInfo { handle: string; label: string; created_at: string; last_seen_at: string; current: boolean }`
  - `useSession(): { state: "loading" | "authenticated" | "unauthenticated" | "error"; error: unknown; retry: () => void }`
  - `LoginPage` component

**Two rules the implementation must keep:**
1. `api.session()` and `api.login()` never dispatch `LOGIN_REQUIRED_EVENT`. The session query listens for that event and refetches itself, so a session call that dispatched it on 401 would loop forever.
2. A 401 **without** the login-required header is Slack's credentials failing, not worktree's. `slackApi.ts` keeps throwing `ApiAuthError` for those.

- [ ] **Step 1: Write the failing client tests**

Append to `ui/src/api/client.test.ts`, and add `HttpError`, `LOGIN_REQUIRED_EVENT` and `reportIfLoginRequired` to its import from `./client`:

```ts
function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return { ok: status < 400, status, headers: new Headers(headers), json: async () => body } as unknown as Response
}

describe("login-required handling", () => {
  it("dispatches the login-required event for a marked 401 and throws HttpError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      response(401, { error: "login required" }, { "X-Worktree-Login-Required": "1" }),
    ))
    const listener = vi.fn()
    window.addEventListener(LOGIN_REQUIRED_EVENT, listener)
    try {
      const err = await api.worktrees().catch((e) => e)
      expect(err).toBeInstanceOf(HttpError)
      expect((err as HttpError).status).toBe(401)
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(LOGIN_REQUIRED_EVENT, listener)
    }
  })

  it("does not treat an unmarked 401 as a login prompt", () => {
    const listener = vi.fn()
    window.addEventListener(LOGIN_REQUIRED_EVENT, listener)
    try {
      expect(reportIfLoginRequired(response(401, {}))).toBe(false)
      expect(listener).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(LOGIN_REQUIRED_EVENT, listener)
    }
  })

  it("never dispatches from the session or login calls, which would loop", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      response(401, { error: "login required" }, { "X-Worktree-Login-Required": "1" }),
    ))
    const listener = vi.fn()
    window.addEventListener(LOGIN_REQUIRED_EVENT, listener)
    try {
      await expect(api.session()).rejects.toBeInstanceOf(HttpError)
      await expect(api.login("x")).rejects.toBeInstanceOf(HttpError)
      expect(listener).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(LOGIN_REQUIRED_EVENT, listener)
    }
  })

  it("POSTs the password to /api/login", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, { handle: "h" }))
    vi.stubGlobal("fetch", fetchMock)
    await api.login("pw")
    expect(fetchMock).toHaveBeenCalledWith("/api/login", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "pw" }),
    }))
  })

  it("POSTs the handle to /api/sessions/revoke", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, { ok: true }))
    vi.stubGlobal("fetch", fetchMock)
    await api.revokeSession("abc")
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/revoke", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ handle: "abc" }),
    }))
  })
})
```

- [ ] **Step 2: Write the failing app tests**

Create `ui/src/App.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

vi.mock("./pages/HomePage", () => ({ HomePage: () => <div>home page</div> }))
vi.mock("./pages/WorktreeDetailPage", () => ({ WorktreeDetailPage: () => <div>detail page</div> }))
vi.mock("./components/HomeWorktreeBanner", () => ({ HomeWorktreeBanner: () => null }))
// vi.mock factories are hoisted above this file's declarations, so the spy
// must be hoisted with them.
const { sse } = vi.hoisted(() => ({ sse: vi.fn() }))
vi.mock("./hooks/useSSE", () => ({ useSSE: () => sse() }))

import { App } from "./App"
import { LOGIN_REQUIRED_EVENT } from "./api/client"

type Reply = { status: number; body: unknown }
const LOGIN_REQUIRED = { "X-Worktree-Login-Required": "1" }

// routes maps "METHOD /path" to a function producing the reply.
function mockServer(routes: Record<string, () => Reply>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`
    const r = routes[key]?.() ?? { status: 404, body: { error: `unmocked ${key}` } }
    return {
      ok: r.status < 400,
      status: r.status,
      headers: new Headers(r.status === 401 ? LOGIN_REQUIRED : {}),
      json: async () => r.body,
    } as unknown as Response
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

const session = { handle: "h1", label: "Mac — Chrome", created_at: "", last_seen_at: "", current: true }

const renderApp = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider><App /></MantineProvider>
    </QueryClientProvider>,
  )

beforeEach(() => {
  window.history.replaceState({}, "", "/")
  sse.mockClear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("App authentication gate", () => {
  it("shows the login screen, and opens no event stream, without a session", async () => {
    mockServer({ "GET /api/session": () => ({ status: 401, body: { error: "login required" } }) })
    renderApp()
    expect(await screen.findByRole("button", { name: "Log in" })).toBeInTheDocument()
    expect(screen.queryByText("home page")).not.toBeInTheDocument()
    expect(sse).not.toHaveBeenCalled()
  })

  it("shows the app with a session", async () => {
    mockServer({ "GET /api/session": () => ({ status: 200, body: session }) })
    renderApp()
    expect(await screen.findByText("home page")).toBeInTheDocument()
    expect(sse).toHaveBeenCalled()
  })

  it("shows the server's message for a wrong password", async () => {
    mockServer({
      "GET /api/session": () => ({ status: 401, body: { error: "login required" } }),
      "POST /api/login": () => ({ status: 401, body: { error: "incorrect password" } }),
    })
    renderApp()
    await userEvent.type(await screen.findByLabelText("Password"), "nope")
    await userEvent.click(screen.getByRole("button", { name: "Log in" }))
    expect(await screen.findByText("incorrect password")).toBeInTheDocument()
  })

  it("enters the app after a correct password, keeping the URL", async () => {
    window.history.replaceState({}, "", "/worktree/%2Fwt%2Ffoo")
    let loggedIn = false
    mockServer({
      "GET /api/session": () => (loggedIn ? { status: 200, body: session } : { status: 401, body: { error: "login required" } }),
      "POST /api/login": () => { loggedIn = true; return { status: 200, body: session } },
    })
    renderApp()
    await userEvent.type(await screen.findByLabelText("Password"), "right")
    await userEvent.click(screen.getByRole("button", { name: "Log in" }))
    expect(await screen.findByText("detail page")).toBeInTheDocument()
  })

  it("returns to the login screen when a request reports the session gone", async () => {
    let loggedIn = true
    mockServer({
      "GET /api/session": () => (loggedIn ? { status: 200, body: session } : { status: 401, body: { error: "login required" } }),
    })
    renderApp()
    await screen.findByText("home page")
    loggedIn = false
    act(() => { window.dispatchEvent(new Event(LOGIN_REQUIRED_EVENT)) })
    expect(await screen.findByRole("button", { name: "Log in" })).toBeInTheDocument()
  })

  it("offers a retry when the server cannot be reached", async () => {
    let up = false
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (!up) throw new TypeError("Failed to fetch")
      return { ok: true, status: 200, headers: new Headers(), json: async () => session } as unknown as Response
    }))
    renderApp()
    const retry = await screen.findByRole("button", { name: "Retry" })
    up = true
    await userEvent.click(retry)
    expect(await screen.findByText("home page")).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `cd ui && npx vitest run src/api/client.test.ts src/App.test.tsx`
Expected: FAIL. The client tests fail with `HttpError` not exported; the App tests fail because no login screen renders.

- [ ] **Step 4: Implement the client**

In `ui/src/api/client.ts`:

1. Add `SessionInfo` to the `import type { ... } from "./types"` list.
2. Replace `fetchJSON` with:

```ts
export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = "HttpError"
  }
}

/** Fired when a request is refused because the user must log in. */
export const LOGIN_REQUIRED_EVENT = "worktree:login-required"

/**
 * Reports a login-required response to the app, and returns whether it was
 * one. Only a 401 carrying X-Worktree-Login-Required counts: some Slack
 * endpoints return 401 for Slack's own credentials, which is not a reason to
 * show the login screen.
 */
export function reportIfLoginRequired(res: Response): boolean {
  if (res.status !== 401 || res.headers?.get("X-Worktree-Login-Required") !== "1") return false
  window.dispatchEvent(new Event(LOGIN_REQUIRED_EVENT))
  return true
}

async function fetchJSON<T>(url: string, init?: RequestInit, opts: { reportLoginRequired?: boolean } = {}): Promise<T> {
  const res = await fetch(url, init)
  if (opts.reportLoginRequired !== false) reportIfLoginRequired(res)
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new HttpError((data && data.error) || `HTTP ${res.status}`, res.status)
  return data as T
}
```

3. Add these entries at the top of the `api` object:

```ts
  // session and login must not report login-required: the session query
  // refetches on that event, so reporting from here would loop.
  session: () => fetchJSON<SessionInfo>("/api/session", undefined, { reportLoginRequired: false }),
  login: (password: string) =>
    fetchJSON<SessionInfo>("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }, { reportLoginRequired: false }),
  sessions: () => fetchJSON<SessionInfo[]>("/api/sessions"),
  revokeSession: (handle: string) =>
    fetchJSON<{ ok: boolean }>("/api/sessions/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle }),
    }),
```

In `ui/src/api/types.ts`, append:

```ts
/** A web UI login session, as GET /api/session(s) returns it. */
export interface SessionInfo {
  /** Hash of the session token: safe to show, and what revoking takes. */
  handle: string
  label: string
  created_at: string
  last_seen_at: string
  current: boolean
}
```

In `ui/src/api/slackApi.ts`:

1. Add `import { reportIfLoginRequired } from './client'` after the header comment.
2. Directly after the `ApiAuthError` class, add:

```ts
export class LoginRequiredError extends Error {
  constructor() {
    super('Log in to worktree to continue.')
    this.name = 'LoginRequiredError'
  }
}

// A 401 is either worktree asking for a login (the app shows the login
// screen) or Slack rejecting its stored credentials (the thread view says so).
function throwIfUnauthorized(res: Response): void {
  if (res.status !== 401) return
  if (reportIfLoginRequired(res)) throw new LoginRequiredError()
  throw new ApiAuthError()
}
```

3. Replace every occurrence of this block (five: in `handleJSON`, `markRead`, `markUnread`, `postReply`, `toggleReaction`):

```ts
  if (res.status === 401) {
    throw new ApiAuthError()
  }
```

with:

```ts
  throwIfUnauthorized(res)
```

4. In `autocomplete`, directly after `const res = await fetch(...)`, add `reportIfLoginRequired(res)`.

- [ ] **Step 5: Implement the session hook**

Create `ui/src/hooks/useSession.ts`:

```ts
import { useEffect } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api, HttpError, LOGIN_REQUIRED_EVENT } from "../api/client"

export type SessionState = "loading" | "authenticated" | "unauthenticated" | "error"

/**
 * Whether this browser is logged in. Refetches whenever any request reports
 * that login is required, e.g. after this device was revoked elsewhere.
 */
export function useSession(): { state: SessionState; error: unknown; retry: () => void } {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ["session"], queryFn: api.session, retry: false, staleTime: Infinity })

  useEffect(() => {
    const onLoginRequired = () => { void qc.invalidateQueries({ queryKey: ["session"] }) }
    window.addEventListener(LOGIN_REQUIRED_EVENT, onLoginRequired)
    return () => window.removeEventListener(LOGIN_REQUIRED_EVENT, onLoginRequired)
  }, [qc])

  const retry = () => { void q.refetch() }
  if (q.isPending) return { state: "loading", error: null, retry }
  // Checked before data: after a refetch fails, TanStack keeps the last
  // successful data alongside the new error.
  if (q.error instanceof HttpError && q.error.status === 401) return { state: "unauthenticated", error: null, retry }
  if (q.isError) return { state: "error", error: q.error, retry }
  return { state: "authenticated", error: null, retry }
}
```

- [ ] **Step 6: Implement the login page and the gate**

Create `ui/src/pages/LoginPage.tsx`:

```tsx
import { useState, type FormEvent } from "react"
import { Alert, Button, Center, Paper, PasswordInput, Stack, Title } from "@mantine/core"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "../api/client"

export function LoginPage() {
  const qc = useQueryClient()
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!password) return
    setSubmitting(true)
    setError(null)
    try {
      await api.login(password)
      // Everything cached while logged out is a refusal; start clean. This
      // also refetches the session, which lets the app through.
      await qc.resetQueries()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed")
      setSubmitting(false)
    }
  }

  return (
    <Center mih="100vh" p="md">
      <Paper withBorder p="lg" w={340} maw="100%">
        <form onSubmit={submit}>
          <Stack gap="md">
            <Title order={3}>worktree</Title>
            <PasswordInput
              label="Password"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              autoFocus
              autoComplete="current-password"
            />
            {error && <Alert color="red" title="Couldn't log in">{error}</Alert>}
            <Button type="submit" loading={submitting} disabled={!password}>Log in</Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  )
}
```

Replace `ui/src/App.tsx` with:

```tsx
import { Route, Router, Switch } from "wouter"
import { Alert, Button, Center, Stack } from "@mantine/core"
import { useSSE } from "./hooks/useSSE"
import { useSession } from "./hooks/useSession"
import { HomeWorktreeBanner } from "./components/HomeWorktreeBanner"
import { useHomeLocation } from "./lib/useHomeLocation"
import { HomePage } from "./pages/HomePage"
import { LoginPage } from "./pages/LoginPage"
import { WorktreeDetailPage } from "./pages/WorktreeDetailPage"

export function App() {
  const session = useSession()
  if (session.state === "loading") return null
  if (session.state === "unauthenticated") return <LoginPage />
  if (session.state === "error") {
    return (
      <Center mih="100vh" p="md">
        <Stack gap="sm" maw={420}>
          <Alert color="red" title="Couldn't reach the worktree server">
            {session.error instanceof Error ? session.error.message : "The request failed."}
          </Alert>
          <Button variant="default" onClick={session.retry}>Retry</Button>
        </Stack>
      </Center>
    )
  }
  return <AuthenticatedApp />
}

// Mounted only with a session, so the event stream never opens while logged
// out. The login screen leaves the URL untouched, so a deep link from a cmux
// pane lands on its page once logged in.
function AuthenticatedApp() {
  useSSE()
  return (
    // The custom hook keeps this tab's home worktree in the URL across every
    // navigation — the only carrier that survives a cmux pane restore.
    <Router hook={useHomeLocation}>
      {/*
        Outside the Switch, not inside a page: it belongs on every route but
        one, and putting it in each page would mean remembering to add it to
        the next page someone writes. Inside the Router because it reads the
        current location to decide.
      */}
      <HomeWorktreeBanner />
      <Switch>
        <Route path="/" component={HomePage} />
        <Route path="/worktree/:path*" component={WorktreeDetailPage} />
        <Route>Not found</Route>
      </Switch>
    </Router>
  )
}
```

- [ ] **Step 7: Run the UI suite and type check**

Run: `cd ui && npm test && npx tsc -b`
Expected: every test passes, including the pre-existing `slackApi`, `useThread` and `useSSE` tests, and `tsc` exits 0. Check the exit code itself (`echo $?`), not the output of a pipe.

- [ ] **Step 8: Commit**

```bash
git add ui/src/api/client.ts ui/src/api/client.test.ts ui/src/api/types.ts ui/src/api/slackApi.ts ui/src/hooks/useSession.ts ui/src/pages/LoginPage.tsx ui/src/App.tsx ui/src/App.test.tsx
git commit --signoff -F - <<'EOF'
feat(ui): add the login screen and gate the app on a session

The app checks GET /api/session before rendering anything else, shows a
password form when there is no session, and returns to it whenever a
request reports that login is required. A 401 without the login-required
header is still treated as Slack's credentials failing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LdwrX6PaoHfKtDBE96EaPx
EOF
```

---
### Task 11: Devices panel

**Files:**
- Create: `ui/src/components/DevicesModal.tsx`
- Create: `ui/src/components/DevicesButton.tsx`
- Modify: `ui/src/pages/HomePage.tsx`
- Test: `ui/src/components/DevicesModal.test.tsx`
- Test: `ui/src/pages/HomePage.test.tsx` (append one test)

**Interfaces:**
- Consumes: `api.sessions`, `api.revokeSession`, `SessionInfo` (Task 10); `relativeTime` from `ui/src/lib/relativeTime.ts`.
- Produces: `DevicesModal({ opened, onClose })` and `DevicesButton()`, an icon button labelled "Devices".

- [ ] **Step 1: Write the failing tests**

Create `ui/src/components/DevicesModal.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { SessionInfo } from "../api/types"
import { DevicesModal } from "./DevicesModal"

const laptop: SessionInfo = { handle: "h-laptop", label: "Mac — Chrome", created_at: "2026-09-01T10:00:00Z", last_seen_at: "2026-09-15T10:00:00Z", current: true }
const phone: SessionInfo = { handle: "h-phone", label: "Android — Chrome", created_at: "2026-09-02T10:00:00Z", last_seen_at: "2026-09-14T10:00:00Z", current: false }

function reply(body: unknown, status = 200) {
  return { ok: status < 400, status, headers: new Headers(), json: async () => body } as unknown as Response
}

function renderModal(qc = new QueryClient()) {
  render(
    <QueryClientProvider client={qc}>
      <MantineProvider><DevicesModal opened onClose={() => {}} /></MantineProvider>
    </QueryClientProvider>,
  )
  return qc
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("DevicesModal", () => {
  it("lists every session and marks only the current one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply([laptop, phone])))
    renderModal()
    const rows = await screen.findAllByTestId("device-row")
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText("Mac — Chrome")).toBeInTheDocument()
    expect(within(rows[0]).getByText("This device")).toBeInTheDocument()
    expect(within(rows[1]).queryByText("This device")).not.toBeInTheDocument()
  })

  it("revokes another device by handle and refreshes the list", async () => {
    let sessions = [laptop, phone]
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/sessions/revoke") {
        sessions = [laptop]
        return reply({ ok: true })
      }
      return reply(sessions)
    })
    vi.stubGlobal("fetch", fetchMock)
    renderModal()
    await userEvent.click(await screen.findByRole("button", { name: "Log out Android — Chrome" }))
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/revoke", expect.objectContaining({
      body: JSON.stringify({ handle: "h-phone" }),
    }))
    await waitFor(() => expect(screen.getAllByTestId("device-row")).toHaveLength(1))
  })

  it("revoking this device invalidates the session, which shows the login screen", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url === "/api/sessions/revoke" ? reply({ ok: true }) : reply([laptop, phone]),
    ))
    const qc = new QueryClient()
    qc.setQueryData(["session"], laptop)
    renderModal(qc)
    await userEvent.click(await screen.findByRole("button", { name: "Log out Mac — Chrome" }))
    await waitFor(() => expect(qc.getQueryState(["session"])?.isInvalidated).toBe(true))
  })

  it("explains a failed revoke", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url === "/api/sessions/revoke" ? reply({ error: "no such session" }, 404) : reply([laptop, phone]),
    ))
    renderModal()
    await userEvent.click(await screen.findByRole("button", { name: "Log out Android — Chrome" }))
    expect(await screen.findByText("no such session")).toBeInTheDocument()
  })
})
```

Append to `ui/src/pages/HomePage.test.tsx`, inside or after the existing `describe`:

```tsx
describe("HomePage devices", () => {
  it("offers the Devices panel from the header at both widths", () => {
    for (const width of ["narrow", "wide"] as const) {
      setViewport(width)
      wrap()
      expect(screen.getByRole("button", { name: "Devices" })).toBeInTheDocument()
      cleanup()
    }
  })
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd ui && npx vitest run src/components/DevicesModal.test.tsx src/pages/HomePage.test.tsx`
Expected: FAIL. `DevicesModal` cannot be resolved, and HomePage has no "Devices" button.

- [ ] **Step 3: Implement**

Create `ui/src/components/DevicesModal.tsx`:

```tsx
import { Alert, Badge, Button, Group, Loader, Modal, Stack, Text } from "@mantine/core"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "../api/client"
import type { SessionInfo } from "../api/types"
import { relativeTime } from "../lib/relativeTime"

/** Every browser logged in to this worktree UI, each revocable on its own. */
export function DevicesModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: api.sessions, enabled: opened })
  const revoke = useMutation({
    mutationFn: (s: SessionInfo) => api.revokeSession(s.handle),
    onSuccess: (_data, s) => {
      // Revoking this browser's own session is logging out: the session
      // query refetches, gets a 401, and the app shows the login screen.
      if (s.current) void qc.invalidateQueries({ queryKey: ["session"] })
      else void qc.invalidateQueries({ queryKey: ["sessions"] })
    },
  })

  return (
    <Modal opened={opened} onClose={onClose} title="Devices" size="lg">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Every browser logged in to this worktree UI. Logging one out revokes its access immediately.
        </Text>
        {sessions.isLoading && <Loader size="sm" />}
        {sessions.error && (
          <Alert color="red" title="Couldn't load devices">{sessions.error.message}</Alert>
        )}
        {revoke.error && (
          <Alert color="red" title="Couldn't log out that device">{revoke.error.message}</Alert>
        )}
        {sessions.data?.map((s) => (
          <Group key={s.handle} justify="space-between" wrap="nowrap" data-testid="device-row">
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Group gap={6} wrap="nowrap">
                <Text fw={500} truncate>{s.label}</Text>
                {s.current && <Badge size="xs" variant="light">This device</Badge>}
              </Group>
              <Text size="xs" c="dimmed">
                Logged in {relativeTime(s.created_at)} · last seen {relativeTime(s.last_seen_at)}
              </Text>
            </Stack>
            <Button
              size="xs"
              variant="light"
              color="red"
              aria-label={`Log out ${s.label}`}
              loading={revoke.isPending && revoke.variables?.handle === s.handle}
              onClick={() => revoke.mutate(s)}
            >
              Log out
            </Button>
          </Group>
        ))}
      </Stack>
    </Modal>
  )
}
```

Create `ui/src/components/DevicesButton.tsx`:

```tsx
import { useState } from "react"
import { ActionIcon, Tooltip } from "@mantine/core"
import { IconDevices } from "@tabler/icons-react"
import { DevicesModal } from "./DevicesModal"

export function DevicesButton() {
  const [opened, setOpened] = useState(false)
  return (
    <>
      <Tooltip label="Devices">
        <ActionIcon variant="default" aria-label="Devices" onClick={() => setOpened(true)}>
          <IconDevices size={16} />
        </ActionIcon>
      </Tooltip>
      <DevicesModal opened={opened} onClose={() => setOpened(false)} />
    </>
  )
}
```

In `ui/src/pages/HomePage.tsx`:

1. Add `import { DevicesButton } from "../components/DevicesButton"`.
2. In the narrow layout, replace `<Group justify="flex-end">{newWorktreeButton}</Group>` with:

```tsx
        <Group justify="flex-end" gap="xs">
          {newWorktreeButton}
          <DevicesButton />
        </Group>
```

3. In the wide layout, replace `{newWorktreeButton}` inside the `Worktrees` title `Group` with:

```tsx
            <Group gap="xs">
              {newWorktreeButton}
              <DevicesButton />
            </Group>
```

- [ ] **Step 4: Run the UI suite and type check**

Run: `cd ui && npm test && npx tsc -b; echo "exit=$?"`
Expected: all tests pass, and `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/DevicesModal.tsx ui/src/components/DevicesButton.tsx ui/src/components/DevicesModal.test.tsx ui/src/pages/HomePage.tsx ui/src/pages/HomePage.test.tsx
git commit --signoff -F - <<'EOF'
feat(ui): add a Devices panel for logging out individual browsers

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LdwrX6PaoHfKtDBE96EaPx
EOF
```

---
### Task 12: Documentation

**Files:**
- Modify: `.claude/CLAUDE.md`
- Modify: `docs/web-ui-architecture.md`

**Interfaces:** none. This task changes documentation only.

- [ ] **Step 1: Find every stale reference**

Run: `grep -rn -- '--bind\|--yes\|confirmBind\|bindIsLoopback\|no authentication\|NO authentication' --include='*.md' . | grep -v node_modules | grep -v docs/superpowers/`
Every hit outside `docs/superpowers/` (specs and plans are historical records) must be rewritten or removed in the steps below.

- [ ] **Step 2: Update `.claude/CLAUDE.md`**

1. In the package list under `internal/`, add these entries in alphabetical position:

```markdown
  - `netdetect` — detects this machine's `.local` name (`scutil --get
    LocalHostName`, macOS only) and the LAN IP of the outbound interface.
    Used by setup to offer remote access addresses, and by `worktree ui` to
    warn when the certificate no longer covers them.
  - `uisession` — web UI login sessions in the worktree DB (`ui_sessions`).
    The cookie holds a random token; the table holds only its SHA-256, the
    session's **handle**, which is also how the UI names a session to revoke
    it. 30-day lifetime; `last_seen_at` rewritten at most every 5 minutes.
  - `uitls` — issues the web UI's HTTPS certificate. Creates a CA and signs
    exactly one leaf in the same call; the CA private key is never
    serialised, so the CA installed on a phone can sign nothing else.
    Changing addresses or renewing therefore means reinstalling the CA on
    the phone.
```

2. Extend the `webui` entry with this sentence: "Every `/api/` request except `POST /api/login` requires a session (`auth.go`), behind a Host allowlist (`hostguard.go`) and the request-forgery guard (`middleware.go`); see `docs/web-ui-architecture.md` "Authentication and remote access"."

3. In "Build & Test", after the `make dev` line, add:

```markdown
`worktree ui` requires `ui.password` in the config (`worktree setup`
generates one) on every listener, including loopback. It serves plain HTTP
on `127.0.0.1:8475` and, once setup has configured remote access, HTTPS on
every interface at `ui.https_port` (8476). There is no `--bind`.
```

- [ ] **Step 3: Update `docs/web-ui-architecture.md`**

1. In the `worktree ui` flag list near the top, delete the `--bind` and `--yes` bullets and add:

```markdown
  - `--local-only` — skip the HTTPS listener for other devices.
    `--api-only` implies it.
  - `--revoke-all-sessions` — delete every login session, then exit.
    Every device must log in again.
```

2. Replace the whole bind section, from the paragraph that begins "`bracketed) and defaults to `127.0.0.1`" through the `cmux-tool-servers` paragraph that ends "while the user may opt out explicitly.", with a new `### Authentication and remote access` section containing:

```markdown
### Authentication and remote access

**Listeners.** `Server.Start` opens plain HTTP on `127.0.0.1:<--port>`,
always loopback, and, when `Security.Remote()` (both `ui.tls` files set),
HTTPS on every interface at `ui.https_port`. Loopback stays HTTP so cmux
panes and the browser-open path need no certificate trust on this machine.
The HTTPS listener includes loopback because the `.local` name resolves to
127.0.0.1 here. `Start` and `Serve` refuse a nil or incomplete `Security`;
`Handler()` built without one skips the Host and session guards, which is
what in-process tests rely on.

**Guard order** (`Server.wrap`), outermost first:
1. `hostGuard` — the Host header's hostname must be `localhost`,
   `127.0.0.1`, `::1` or a `ui.allowed_hosts` entry. The port is ignored:
   rebinding changes the name, and the port varies between the two
   listeners and the Vite proxy (`Host: localhost:5175`). 400 otherwise.
2. `guardMutations` — JSON content type and same-origin for non-GET.
3. `requireSession` — every `/api/` path except `POST /api/login` needs a
   live session. It checks the prefix, not the route table, so new routes
   are covered automatically. A refusal is 401 with
   `X-Worktree-Login-Required: 1`; the UI shows the login screen only for
   401s carrying that header, because Slack handlers also return 401 when
   Slack's own credentials fail.

**Sessions** (`internal/uisession`, table `ui_sessions`). The cookie
`worktree_session` is HttpOnly, SameSite=Lax, Path=/, 30-day Max-Age, and
Secure when the login arrived over TLS (`r.TLS != nil`), decided per
request because one server has both listeners. Routes: `POST /api/login`,
`POST /api/logout`, `GET /api/session`, `GET /api/sessions`,
`POST /api/sessions/revoke {handle}`. The UI's Devices panel (home page
header) lists and revokes sessions.

**Setup** (`internal/setup/uiaccess.go`). Generates `ui.password` if unset
and prints it once. Offers remote access: detects the `.local` name and LAN
IP (`internal/netdetect`), falls back to asking for an IP, writes
`ui.allowed_hosts` (the certificate SANs and the Host allowlist, so they
cannot disagree) and `ui.tls`, and issues `ui-ca.pem`, `ui-cert.pem` and
`ui-key.pem` next to `config.yaml`. On later runs it offers renewal within
30 days of expiry, and a change of addresses. Either one creates a new CA
that must be reinstalled on the phone. `setup --uninstall` removes the
files and clears `ui.tls`/`ui.allowed_hosts`, keeping the password. The
config file is written 0600.

**Launchers.** An external launcher that still passes `--bind` or `--yes`
now fails with an error pointing at `worktree setup`. Remove those flags
from the launch command.
```

3. Re-run the Step 1 grep. The only remaining hits should be under `docs/superpowers/`.

- [ ] **Step 4: Commit**

```bash
git add .claude/CLAUDE.md docs/web-ui-architecture.md
git commit --signoff -F - <<'EOF'
docs: document web UI authentication and remote access

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LdwrX6PaoHfKtDBE96EaPx
EOF
```

---

### Task 13: Drop `--bind` and `--yes` from `cmux-tool-servers` (in `~/git/work-scripts`)

This task is in a **different repository**: `~/git/work-scripts`, a public GitHub repo (`mturley/work-scripts`). Run every command in it with `git -C ~/git/work-scripts ...` or an absolute path. Do not `cd` away from the worktree for the rest of the plan.

**Files (all under `~/git/work-scripts`):**
- Modify: `src/cmux-tool-servers/cmux-tool-servers.sh` (replace its contents)
- Modify: `src/cmux-tool-servers/README.md`
- Modify: `README.md` (the `cmux-tool-servers` entry only)

**Interfaces:**
- Consumes: Task 8's behaviour. `worktree ui` rejects `--bind` and `--yes`, and serves other devices over HTTPS once `worktree setup` has configured remote access.
- Produces: `cmux-tool-servers` with no options besides `-h`/`--help`. `--bind`/`--yes` (including `--bind=ADDR`) exit 2 with a pointer to `worktree setup`.

**Constraints specific to this repo** (from its `CLAUDE.md`):
- bash 3.2 compatible: no `mapfile`, `readarray` or associative arrays. POSIX `grep`/`sed`/`awk` flags only.
- Keep `src/cmux-tool-servers/README.md` and the root `README.md` entry in step with the script.
- There is no test suite. Verification is by running the script's argument handling directly (Step 4).
- Commit with `--signoff` and the attribution lines from Global Constraints. **Do not push.**

- [ ] **Step 1: Check the starting state**

Run: `git -C ~/git/work-scripts status --short`
Expected: no changes to the three files above. If any of them is already modified, stop and report it rather than overwriting someone's work.

- [ ] **Step 2: Replace the script**

Replace the entire contents of `~/git/work-scripts/src/cmux-tool-servers/cmux-tool-servers.sh` with:

```bash
#!/usr/bin/env bash
# cmux-tool-servers - Run `handler ui` and `worktree ui` side by side in mprocs.
#
# Both agent-handler (`handler ui`) and worktree (`worktree ui`) expose their
# full feature set only when run inside cmux, hence the "cmux" prefix. This
# launches both UIs in a single mprocs session so they can share one terminal
# surface.
#
# Reinstall-without-quitting workflow:
#   When hacking on the handler/worktree projects themselves you often want to
#   `go install` (or equivalent) a fresh binary. The old binary has to be killed
#   first. Each mprocs pane therefore runs its command through a self-restarting
#   supervisor: when the child process exits for ANY reason (you kill it, it
#   crashes, it exits cleanly), the supervisor waits 5 seconds and relaunches it.
#   So you can kill the running `handler`/`worktree`, install the new binary, and
#   within 5s the pane comes back up on the new binary — no need to quit mprocs.
#   Quitting mprocs (or Ctrl-C) stops everything as usual.
#
# The supervisor is this same script re-invoked in a hidden `--supervise` mode,
# so there is only one file to maintain.
#
# Reaching the worktree UI from other devices:
#   There is nothing to pass here. `worktree ui` requires a login on every
#   listener, and serves other devices over HTTPS once `worktree setup` has
#   configured remote access. This script used to forward --bind and --yes;
#   `worktree ui` no longer accepts either, so they are rejected here with the
#   same pointer rather than passed through to fail in the pane every 5 seconds.

set -euo pipefail

RESTART_DELAY=5

usage() {
  cat <<'EOF'
Usage: cmux-tool-servers

Run `handler ui` and `worktree ui` in parallel panes in mprocs. Each pane
restarts its command 5 seconds after it exits, so you can kill a running
binary, install a new one, and have it come back automatically.

To use the worktree UI from another device (e.g. your phone), run
`worktree setup` once to enable HTTPS remote access. `worktree ui` then serves
it automatically; there is no flag to pass here.

Requires: mprocs, handler, worktree (all on PATH). Best run inside cmux.
EOF
}

removed_flag() {
  cat >&2 <<EOF
cmux-tool-servers: $1 has been removed.
  \`worktree ui\` now requires a login and serves other devices over HTTPS
  once remote access is configured. Run \`worktree setup\` to configure it,
  then run cmux-tool-servers with no options.
EOF
  exit 2
}


# Hidden supervise mode: `cmux-tool-servers --supervise <cmd> [args...]`
# Runs the command in a loop, restarting RESTART_DELAY seconds after each exit.
# NOTE: `set -e` must not apply here — the child exiting non-zero is expected.
if [ "${1:-}" = "--supervise" ]; then
  shift
  if [ "$#" -eq 0 ]; then
    echo "cmux-tool-servers: --supervise requires a command" >&2
    exit 2
  fi
  set +e
  while true; do
    "$@"
    status=$?
    echo ""
    echo "[cmux-tool-servers] '$*' exited (status $status). Restarting in ${RESTART_DELAY}s… (kill mprocs to stop)"
    sleep "$RESTART_DELAY"
  done
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --bind|--bind=*)
      removed_flag "--bind"
      ;;
    --yes)
      removed_flag "--yes"
      ;;
    *)
      echo "cmux-tool-servers: unknown argument '$1'" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# Preflight: everything we need must be on PATH.
missing=""
for tool in mprocs handler worktree; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    missing="$missing $tool"
  fi
done
if [ -n "$missing" ]; then
  echo "cmux-tool-servers: required tool(s) not found on PATH:$missing" >&2
  exit 1
fi

# Resolve this script's own path so mprocs invokes the same file for --supervise,
# regardless of how it was called (symlink in bin/, direct path, etc.).
self="$0"
if command -v realpath >/dev/null 2>&1; then
  self="$(realpath "$0")"
fi

exec mprocs \
  --names "handler,worktree" \
  "$self --supervise handler ui --no-open" \
  "$self --supervise worktree ui --no-open"
```

- [ ] **Step 3: Update both READMEs**

In `~/git/work-scripts/src/cmux-tool-servers/README.md`:

1. Delete the `### Options` subsection (its heading and table).
2. Replace the whole `## Reaching the worktree UI from another device` section, from that heading up to (not including) `## Reinstall-without-quitting workflow`, with:

```markdown
## Reaching the worktree UI from another device

There is no option to pass here. `worktree ui` requires a login on every
listener, including this machine. Once you have run `worktree setup` and
enabled HTTPS remote access, it also serves other devices over HTTPS, and this
script picks that up with no changes:

1. Run `worktree setup` and answer yes to HTTPS access. It offers this Mac's
   `.local` name and LAN IP, generates a password if you have none, and writes
   a CA certificate to install on the phone.
2. Install that CA on the phone, as setup describes.
3. Run `cmux-tool-servers`, then open the URL `worktree ui` prints in its pane
   (e.g. `https://<name>.local:8476`) on the phone and log in.

On macOS the application firewall will prompt once to allow incoming
connections for the `worktree` binary. `handler ui` is not affected by any of
this and stays on loopback.

`--bind` and `--yes` were removed. Passing either now exits with a pointer to
`worktree setup`, rather than launching a pane that fails and restarts every
5 seconds.
```

3. Under `## Behavior on failure`, add a bullet: `` - `--bind` or `--yes` exits non-zero with a pointer to `worktree setup` (both were removed). ``

In `~/git/work-scripts/README.md`, in the `cmux-tool-servers` entry:

1. Replace the three-line usage block with:

```bash
cmux-tool-servers                  # opens the two UIs in mprocs
```

2. Replace the paragraph that begins `` `--bind ADDR` is passed through to `worktree ui` `` (ending "stays on loopback.") with:

```markdown
To use the worktree UI from another device, run `worktree setup` once to
enable HTTPS remote access; `worktree ui` then serves it with a login, and
there is nothing to pass to this script. `handler ui` stays on loopback.
```

Then confirm nothing stale is left:
Run: `grep -rn -- '--bind\|--yes\|no authentication' ~/git/work-scripts/README.md ~/git/work-scripts/src/cmux-tool-servers/`
Expected: hits only in the "were removed" sentences and the `removed_flag` handling.

- [ ] **Step 4: Verify the argument handling**

These invocations all exit before the preflight and `exec mprocs`, so they start no processes. Run each one and check its exit code:

```bash
S=~/git/work-scripts/src/cmux-tool-servers/cmux-tool-servers.sh
bash -n "$S"; echo "syntax=$?"                                   # syntax=0
"$S" --help >/dev/null; echo "help=$?"                            # help=0
"$S" --bind 0.0.0.0 2>&1; echo "bind=$?"                          # message naming worktree setup, bind=2
"$S" --bind=0.0.0.0 2>/dev/null; echo "bindeq=$?"                 # bindeq=2
"$S" --yes 2>/dev/null; echo "yes=$?"                             # yes=2
"$S" --bogus 2>/dev/null; echo "bogus=$?"                         # bogus=2
/bin/bash --version | head -1                                     # confirm this is macOS's bash 3.2
/bin/bash -n "$S"; echo "bash32syntax=$?"                          # bash32syntax=0
```

**Never run the script with no arguments, or with only `--supervise`.** Both launch mprocs or a restart loop. And **never kill any mprocs process**: stopping the running `cmux-tool-servers` session is the user's to do.

- [ ] **Step 5: Commit in work-scripts (do not push)**

```bash
git -C ~/git/work-scripts add src/cmux-tool-servers/cmux-tool-servers.sh src/cmux-tool-servers/README.md README.md
git -C ~/git/work-scripts commit --signoff -F - <<'EOF'
Drop --bind and --yes from cmux-tool-servers

worktree ui no longer accepts either: it requires a login everywhere and
serves other devices over HTTPS once `worktree setup` has configured remote
access. Passing them here now exits with a pointer to worktree setup,
rather than launching a worktree pane that fails and restarts every five
seconds.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LdwrX6PaoHfKtDBE96EaPx
EOF
```

**Rollout note:** no `cmux-tool-servers` session is running. The user runs a standalone `worktree ui` while this plan executes. **Never stop, restart or replace that process, or any mprocs process**, and never run `make install` or `make dev`: the manual verification uses `bin/worktree` on spare ports. Push `work-scripts` at the same time `worktree` lands on `main`.

---

## Manual verification (after all tasks)

These need a real phone and a real browser, so they are not part of any task. Run them before merging.

1. `go build -o bin/worktree . && bin/worktree setup`. Confirm the password is generated and printed, that `mturley-mac.local` and the LAN IP are offered, and that `~/.config/worktree/` holds exactly `config.yaml`, `ui-ca.pem`, `ui-cert.pem` and `ui-key.pem`, with `config.yaml` and `ui-key.pem` at 0600.
2. Install `ui-ca.pem` on the Android phone. Start `bin/worktree ui --port 8485` (a spare port, leaving any running UI alone). Open `https://mturley-mac.local:8476` on the phone: no certificate warning, and a login screen. Log in.
3. On the laptop, open `http://127.0.0.1:8485`, log in, and open Devices. Two sessions are listed, and this one is marked. Log out the phone, then reload on the phone: the login screen returns.
4. From the laptop, `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8485/api/worktrees` prints `401`, and `curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: rebound.example' http://127.0.0.1:8485/` prints `400`.
5. `bin/worktree ui --bind 0.0.0.0` fails with the pointer to `worktree setup`, and so does `~/git/work-scripts/src/cmux-tool-servers/cmux-tool-servers.sh --bind 0.0.0.0`.
6. `bin/worktree ui --revoke-all-sessions` reports the count, and the laptop tab returns to the login screen on its next request.
