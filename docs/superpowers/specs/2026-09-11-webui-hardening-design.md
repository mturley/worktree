# Web UI hardening — design

**Status:** implemented (merged in 11acf5b). Built from
`docs/superpowers/plans/2026-09-15-webui-hardening.md`; where the two differ,
that plan's "Decisions made while planning" and the code govern.
**Date:** 2026-09-11

## The problem

`internal/webui/server.go:25` states it plainly: "the UI has no
authentication." The default bind is loopback and `confirmBind` prompts before
a non-loopback one, but that prompt is answerable with `--yes`, and the UI is
meant to be reachable from other devices. Where it is, the whole API is
reachable unauthenticated, over plain HTTP.

What that exposes, in rough order of severity:

| Endpoint | Effect for an unauthenticated caller |
|---|---|
| `POST /api/thread/reply` | Posts a message to Slack as the user |
| `POST /api/thread/react`, `/mark-read`, `/mark-unread` | Mutates Slack state |
| `POST /api/worktrees/delete` | Deletes a worktree |
| `POST /api/worktrees/create`, `/api/cmux/create`, `/api/cmux/select` | Creates worktrees, drives cmux workspaces |
| `GET /api/thread`, `/api/slack-autocomplete`, `/api/slack-file` | Reads Slack content, enumerates users and channels |
| `GET /api/slack-image` | Proxies a fetch of any public URL |

The Slack write path is the sharpest: a standing project rule reserves all
Slack writing to the user, and that endpoint posts as him for anyone who asks.

## Scope

Five pieces, which together make reaching the port insufficient to use the
API, and make the traffic unreadable in transit:

1. **TLS for remote devices**: a second, HTTPS-only listener for other
   devices, with a single-purpose CA generated at setup whose signing key is
   destroyed once it has issued the server certificate. The existing
   loopback listener stays plain HTTP.
2. **Authentication** — a password in config, exchanged for a session.
3. **Server-side sessions**, so a device can be logged out individually.
4. **A `Host` header allowlist**, which blocks DNS rebinding independently of
   the above.
5. **Extending the outbound-address blocklist** to IPv6 forms that embed an
   IPv4 address.

The two request-forgery middlewares (`Content-Type` enforcement and cross-site
rejection) answer a different question — who may *cause* a call — and are
specified in the Link resource spec and already shipped (`guardMutations`,
`internal/webui/middleware.go`). Neither concern
supersedes the other.

---

## 1. TLS

### Two listeners: HTTP on loopback, HTTPS for everything else

`worktree ui` serves on two ports:

| Listener | Address | Protocol | When |
|---|---|---|---|
| Local | `127.0.0.1:8475` (`--port`) | HTTP | Always |
| Remote | `:8476` — all interfaces, loopback included (`ui.https_port`) | HTTPS only | Only when remote access is configured (below) |

The split exists because the laptop is itself a client. cmux panes and the
browser-open path use `http://127.0.0.1:8475`, and serving that over TLS would
mean trusting the CA on the Mac too. Keeping loopback on HTTP means those URL
builders (`internal/webui/cmux_api.go` `worktreeDetailURL`, `cmd/ui.go`) do not
change, and only other devices ever see the certificate.

Two ports rather than one because a wildcard bind and a loopback bind on the
same port do not coexist portably.

The HTTPS listener binds all interfaces **including loopback** because the
`.local` name resolves to `127.0.0.1` and `::1` on the Mac itself, so the
phone's URL also works when opened on the laptop.

**This replaces `--bind` and its confirmation prompt.** Remote exposure is no
longer chosen per run: it exists exactly when remote access has been
configured in setup. `--bind` is removed and fails with an error pointing at
`worktree setup`. `--local-only` skips the HTTPS listener for a run. Plain
HTTP is never served beyond loopback, so there is no combination to warn
about or waive.

### Remote access addresses

The certificate must name the address the phone connects with, so setup asks
for it. The chosen addresses are persisted as `ui.allowed_hosts`, which serves
as both the certificate's SANs and the Host allowlist (section 4), so the two
cannot disagree.

**Detection.** Setup detects two candidates:

- The **`.local` name**, from `scutil --get LocalHostName` with `.local`
  appended. Not `os.Hostname()`: the plain hostname can come from the network
  and drift from the mDNS name. macOS only; elsewhere this candidate is absent.
- The **LAN IP**, as the local address of the interface that routes outbound,
  found by opening a UDP socket toward a documentation address (`192.0.2.1`).
  This sends no packets. IPv4 only.

**First run** (not yet configured):

```
Enable HTTPS access from other devices (e.g. your phone)? [y/N] y

Detected:
  mturley-mac.local
  192.168.86.21
Use these addresses? [Y/n] n
Which IP address should other devices use? 192.168.1.50
```

- Accepting persists both detected addresses.
- Declining prompts for an IP, which must parse as an IP address. An invalid
  answer re-prompts. An empty answer skips remote access.
- If nothing is detected, setup goes straight to the IP prompt.

**Later runs** (already configured):

```
Remote access: https://mturley-mac.local:8476 (also 192.168.86.21)
Certificate expires 2027-10-17.
Change remote access addresses? [y/N]
```

Answering yes re-runs detection and prompting, then re-issues the
certificate. Setup states plainly that this means **re-installing the CA on
the phone**, because the old CA's key no longer exists. Setup also offers to
renew when the certificate expires within 30 days.

**Stability.** The `.local` name survives the router handing out a different
IP, so listing it first is what keeps the certificate valid as the LAN IP
changes. The IP is a fallback for clients that cannot resolve mDNS.

**Startup check.** When the HTTPS listener starts, it compares the currently
detected `.local` name and LAN IP against the certificate. If neither is
covered, it logs a warning naming the uncovered addresses and the fix
(`worktree setup`). This is a warning, not an error: the listener is still
correct for whatever names the certificate does carry.

### Certificate generation

worktree generates its own certificates, in `worktree setup`. This reverses an
earlier draft that leaned on `mkcert`, for a specific reason: `mkcert` installs
a **general-purpose** CA into the system trust store, and a general-purpose CA
trusted by a phone can mint a valid certificate for any site in the world. The
point of this design is a CA that cannot.

### A single-purpose CA whose key is destroyed

Whenever remote access is enabled or its addresses change, setup does the
following:

1. Generate a CA keypair and a self-signed CA certificate (ECDSA P-256),
   `basicConstraints` CA:TRUE, subject `worktree local UI CA`.
2. Generate a server keypair, and sign a leaf certificate with the CA.
3. Write three files:
   - `~/.config/worktree/ui-key.pem` — the **server** key, 0600
   - `~/.config/worktree/ui-cert.pem` — the server certificate, 0644
   - `~/.config/worktree/ui-ca.pem` — the CA certificate, 0644, the file to
     install on the phone
4. **Destroy the CA private key.** It is never written to disk — it exists
   only in memory during step 2 and is discarded when setup exits.

Step 4 is the design. Android's user trust store only accepts certificates
carrying `basicConstraints=CA:TRUE`, so the thing installed on a phone is
necessarily a CA and cannot be a bare leaf. What *can* be arranged is that the
CA's signing key does not survive the ceremony: the laptop then holds only a
leaf key, and an attacker who takes it can impersonate this UI and nothing
else. A CA that cannot sign again has the blast radius of the leaf it already
signed.

X.509 name constraints were considered as the alternative bound and rejected:
enforcement could not be confirmed on Android, and a restriction that may or
may not be honoured is not a control.

### Certificate parameters

- **SANs are mandatory and are the only names checked** — modern browsers
  ignore the Common Name entirely. Include `127.0.0.1`, `::1`, `localhost`,
  and every entry of `ui.allowed_hosts` (IP entries as IP SANs, names as DNS
  SANs), so the TLS names and the Host allowlist cannot disagree.
- **`ExtKeyUsage: serverAuth`** on the leaf.
- **Validity: 397 days** for the leaf, 400 for the CA. Chosen to sit under the
  398-day ceiling browsers apply to server certificates, rather than gambling
  on user-added CAs being exempt from it. Setup prints the expiry date.
- Renewal is re-running `worktree setup` and re-installing the new
  `ui-ca.pem` on the phone. That is the price of destroying the CA key, and it
  falls due about once a year.

### Configuration

```yaml
ui:
  password: "..."
  https_port: 8476
  allowed_hosts: ["mturley-mac.local", "192.168.86.21"]
  tls:
    cert_file: ~/.config/worktree/ui-cert.pem
    key_file:  ~/.config/worktree/ui-key.pem
```

Remote access is configured when `tls.cert_file` and `tls.key_file` are both
set. The HTTPS listener serves them via `ListenAndServeTLS`. Setting only one
is a startup error, and so is a configured file that does not exist.

Setup writes the config file **0600**, since it now holds the password.
Setup's config writer must carry the whole `ui` section: it currently
serialises a hand-picked subset of fields and would silently drop anything
else on the next write.

### Teardown

`worktree setup --uninstall` (`cmd/setup.go:29`) removes the three files,
clears `ui.tls` and `ui.allowed_hosts` from the config (leaving the password),
and
prints the steps to remove the CA from the phone: Settings → Security →
Encryption & credentials → Trusted credentials → User → remove. A CA left
installed on a phone after the tool is gone is exactly the loose end this
design exists to avoid, so the uninstall path names it explicitly rather than
leaving it to the user to remember.

### Expect a standing Android warning

While any user CA is installed, Android shows a persistent "network may be
monitored" notice. It is a nuisance rather than a risk, it is permanent for as
long as the CA is installed, and `worktree setup` should say so at install
time so it is not mistaken later for a sign of compromise.

**No HSTS.** It does not apply to IP addresses, and pinning the `.local` name
to HTTPS in a browser would outlast this tool's own configuration.

**No HTTP-to-HTTPS redirect.** The HTTP listener is loopback-only, so no
remote device can ever reach it to be redirected.

Startup prints both URLs, e.g. `http://127.0.0.1:8475` and
`https://mturley-mac.local:8476`, the latter being the one to open on the
phone.

## 2. Authentication

A password in `~/.config/worktree/config.yaml` (`internal/config`):

```yaml
ui:
  password: "..."
```

There is no username. The password is posted once to `POST /api/login`, which
creates a session and sets its cookie.

- Comparison via `crypto/subtle.ConstantTimeCompare`.
- A small fixed delay on failure. No lockout: on a single-user tool a lockout
  is a self-inflicted denial of service.
- Warn at startup if the config file is group- or world-readable.

### Required everywhere, including loopback

**A configured password is mandatory. The server refuses to start without
one, on any bind**, with an error naming the config key.

Loopback is not exempt, because loopback is not private: a page in the user's
own browser can reach it, and DNS rebinding can make that page same-origin
with the service. A session cookie is scoped to the host it was set for, so a
rebound origin does not receive it — which only helps if a session is required
in the first place.

This is a breaking change for existing installs: the first run after upgrading
fails until a password is set. The error message must therefore be
instructional rather than terse, and `worktree setup` gains a step that
generates a strong password and writes it to the config.

### When TLS is required

| Listener | Password | TLS |
|---|---|---|
| Loopback HTTP | Required | Never |
| Remote HTTPS | Required | Always |

TLS is required for everything that leaves the machine by construction, not
by a runtime check: the only listener reachable from another device is the
HTTPS one. There is no flag that serves plain HTTP beyond loopback, and so
nothing for `--yes` to bypass.

### Why a cookie, and not Basic or a bearer token

The UI authenticates three kinds of request, and only one can set headers:

- `fetch` calls — can set any header.
- **`EventSource`** (`GET /api/stream`) — the SSE API has no way to set
  request headers at all.
- **`<img src>`** — every avatar, favicon, Jira icon and attachment preview.
  Cannot set them either.

A bearer-token-in-header scheme would break the live stream and every image on
the page. Basic auth and cookies are both attached automatically to all three,
but a Basic credential is *ambient*: the browser sends it on cross-site
requests too, leaving every forgery path open. A cookie with `SameSite` is the
one credential that is automatic for our own page and **withheld by the
browser on cross-site POST**.

`SameSite=Lax` rather than `Strict`: `Strict` additionally withholds the
cookie on top-level cross-site *navigations*, which would force a login screen
when opening the UI from `cmux open`, a bookmark, or the home-worktree
banner's link. It buys nothing in exchange, because no GET endpoint mutates
state.

**`SameSite` is computed per site, which ignores the port**, so a different
service on the same host counts as same-site. `Origin` includes the port, and
the Link spec's cross-site middleware is what distinguishes them. Keep both.

### Cookie attributes

`HttpOnly`, `SameSite=Lax`, `Path=/`, 30-day `Max-Age`, and **`Secure`
whenever the login request arrived over TLS** (`r.TLS != nil`). The decision
is per request, not per server, because one server now has both listeners.
Every login from another device therefore gets a `Secure` cookie. It is
omitted only on the loopback HTTP listener, where setting it would make the
browser discard the cookie and no login would ever succeed.

Browsers scope cookies by host, not port or scheme, so a session made on
`127.0.0.1` and one made on `mturley-mac.local` are separate sessions even on
the same laptop. That is correct, and each shows up as its own device.

## 3. Server-side sessions

Sessions live in worktree's own database (`internal/db` migration), **not** in
a `watcher_*` table — this is worktree's own concern and no other consumer
shares it.

```sql
CREATE TABLE ui_sessions (
  token_hash    TEXT PRIMARY KEY,  -- hex SHA-256 of the cookie token
  label         TEXT NOT NULL,     -- derived from User-Agent at login
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
```

The cookie carries **only a random token** (32 bytes, base64url), and the
table stores only its SHA-256, so reading the database never yields a usable
login. That hash is the session's **handle**: it is what the UI shows and
what revocation takes. The token is an opaque, unguessable random
value, validated by looking up its hash. No HMAC and no derived signing key: with a table,
the token's own entropy is the security property, and a signature would add a key
to manage for nothing. (An earlier draft of this design used a stateless
signed cookie precisely to avoid this table; per-device logout is what makes
the table worth it.)

- **`label`** is derived from the `User-Agent` at login ("iPhone — Safari",
  "Mac — Chrome") so the session list is legible. Best-effort; an
  unrecognised agent is stored verbatim, truncated.
- **`last_seen_at`** is refreshed on use, but **throttled** — only written
  when the stored value is more than 5 minutes old. A write per request would
  put the DB on the hot path of every image load.
- Expired rows are deleted at startup and at each login.

### Managing sessions

- `GET /api/session` — the current session; the UI uses it to decide whether
  to show the login screen.
- `GET /api/sessions` — list, with the current session flagged.
- `POST /api/sessions/revoke` `{handle}` — delete one. Revoking the current
  session is equivalent to logging out.
- `POST /api/logout` — revoke the current session and clear the cookie.

**UI:** a "Devices" panel, reached from an icon button in the home page
header, listing each session's label, when it was created, and when it was
last seen, with a revoke button per row and the current session marked. This
is the whole point of the table, so it gets a real surface rather than a
CLI-only path.

Changing the password does **not** invalidate sessions — that was a side
effect of the old derived-key design, and with a table, revocation is explicit
and per-device. `worktree ui` gains a `--revoke-all-sessions` flag for the
"I've lost a device" case.

## 4. Host header allowlist

Every request's `Host` must match an allowlist, or it is refused with 400
before routing. This blocks DNS rebinding directly: a rebound request carries
the attacker's hostname in `Host`, not ours, however the browser has been
tricked about origins.

Always allowed: `localhost`, `127.0.0.1` and `::1`. Also allowed: every entry
of `ui.allowed_hosts`, the same list setup writes for the certificate
(section 1).

**The comparison is on the hostname alone; the port is ignored.** DNS
rebinding works by changing the *name* a page is served under, so the name
is what the check has to hold. The port varies legitimately across the two
listeners and the Vite dev proxy (which forwards `Host: localhost:5175`), and
matching it would add failure modes without adding protection. Hostnames
compare case-insensitively, and a bracketed IPv6 literal is unbracketed first.

A refused request is logged with the rejected `Host` and a pointer to
`ui.allowed_hosts`, since the likeliest cause is a legitimate name nobody
added.

## 5. Outbound address blocklist — IPv6 forms

`safehttp.IsDisallowedIP` (`internal/safehttp/safehttp.go`) is the containment for every
outbound fetch the server makes, including the Link feature's metadata
resolution. Unlike a datacenter service, there is no network segmentation
behind it — it is load-bearing and alone, so it must not have gaps.

It currently reasons about IPv4 and the standard IPv6 predicates. Extend it to
**decode any IPv4 address embedded in an IPv6 address and apply the IPv4 rules
to it**:

- IPv4-mapped (`::ffff:127.0.0.1`) — Go's `IsLoopback`/`IsPrivate` call
  `To4()` internally and should already handle this; pin it with a test rather
  than assume it.
- **NAT64 (`64:ff9b::/96`)** — `64:ff9b::7f00:1` is `127.0.0.1` behind a NAT64
  gateway and is caught by none of the current checks.
- **6to4 (`2002::/16`)** — `2002:0a00:0001::` embeds `10.0.0.1`.
- IPv4-compatible (`::127.0.0.1`), deprecated but still parsed.

Also pin the behaviour for alternative IPv4 literal encodings in URLs (octal
`0177.0.0.1`, decimal `2130706433`): `net.ParseIP` rejects them, so they fall
through to `LookupIP` — the test should assert which way that lands rather
than leaving it unexamined.

---

## Testing

**Listeners**
- With remote access configured, the HTTPS port speaks TLS and refuses plain
  HTTP, and the loopback port speaks plain HTTP.
- The HTTP listener binds `127.0.0.1` regardless of configuration.
- Without remote access configured, no HTTPS listener starts. With
  `--local-only`, none starts either.
- Only one of `cert_file`/`key_file` set, or a missing file, fails startup.
- `--bind` fails with an error naming `worktree setup`.
- The startup coverage check warns when neither the detected `.local` name
  nor LAN IP is in the certificate, and is silent when either is.

**Setup: remote access addresses** (driven through the prompter with scripted
answers and a stubbed detector)
- Accepting the detected addresses persists both to `ui.allowed_hosts`.
- Declining prompts for an IP; an invalid answer re-prompts; the valid answer
  is persisted alone.
- An empty answer skips remote access and writes no certificate.
- Nothing detected goes straight to the IP prompt.
- When already configured, the addresses are shown, and declining "change"
  leaves config and certificate files untouched (compare file mtimes).
- Accepting "change" re-issues the certificate.
- `scutil` failure or a non-macOS platform yields no `.local` candidate,
  not an error.
- Writing the config preserves every `ui` field and leaves the file 0600.

**Authentication**
- Startup fails, naming the config key, when no password is configured, with
  and without remote access configured.
- Every `/api/*` route refuses a request with no session and accepts one with
  a valid session. Asserted over the registered route table, so a route added
  later is covered without anyone remembering.
- `/api/login` is reachable without a session; a wrong password is refused; a
  correct one sets a cookie with `HttpOnly`, `SameSite=Lax` and a `Max-Age`.
- `Secure` is set when the login arrived over TLS and **absent** when it
  arrived over plain HTTP on loopback. The second half matters, because a
  `Secure` cookie over HTTP is silently discarded and login would never
  succeed.
- Static assets are served without a session: the login form must be able to
  load.
- Comparison is constant-time by construction (the call site uses
  `subtle.ConstantTimeCompare`); no timing measurement, which would be flaky.

**Certificate generation**
- Generation writes exactly three files, with the server key 0600, and
  **no CA private key anywhere on disk**. This is asserted by listing the
  config directory, since it is the property the whole design rests on.
- The generated leaf carries the loopback names and every `allowed_hosts`
  entry as SANs (IPs as IP SANs, names as DNS SANs), and `serverAuth` in its
  EKU.
- The leaf verifies against the generated CA, and does not verify against an
  unrelated CA.
- `worktree setup --uninstall` removes all three files.

**Sessions**
- A revoked session id is refused on the next request.
- An expired session is refused, and expired rows are cleaned up at startup.
- `last_seen_at` is not written on every request — assert that a second
  request within the throttle window leaves the stored value unchanged.
- `GET /api/sessions` flags exactly one session as current.
- Two logins produce two independently revocable sessions.

**Host allowlist**
- A request with an unlisted `Host` is refused with 400, before routing —
  assert it on a route that would otherwise succeed with a valid session, so
  the test proves ordering and not merely rejection.
- Loopback names and `allowed_hosts` entries are accepted, with and without a
  port, case-insensitively, and bracketed IPv6 (`[::1]:8476`) is accepted.
- A request whose Host matches an allowed name on an unexpected port is still
  accepted (the port is deliberately ignored).

**Address blocklist**
- Each IPv6 form embedding a blocked IPv4 address is rejected:
  `::ffff:127.0.0.1`, `64:ff9b::7f00:1`, `2002:0a00:0001::`, `::127.0.0.1`.
- A public IPv6 address is still allowed.
- Alternative IPv4 literal encodings have their behaviour pinned.
