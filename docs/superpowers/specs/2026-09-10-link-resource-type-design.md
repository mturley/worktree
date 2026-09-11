# Link resource type — design

**Status:** approved design, not yet implemented
**Date:** 2026-09-10

## Goal

Follow an arbitrary web page as a worktree resource. Any URL that is not a
GitHub PR, a Jira issue, or a Slack thread becomes a `link` resource: worktree
resolves its title, favicon and embed metadata once when you follow it, shows
that on the resource cards, and renders the page itself in an iframe where the
activity feed would otherwise be.

A link has **no activity, no events, no unread state, and is never polled.**

## Why it is cheap

Two things the codebase already has carry most of this feature:

1. **Polling is opt-in by type.** `pollAll` (internal/webui/poller.go) asks for
   `ActiveResources(s.DB, "pr")`, then `"jira"`, then `"slack"`, and polls each
   with its own poller. A type nothing asks for is never polled. "No watcher
   polling" therefore requires no opt-out mechanism, no flag, and no guard —
   it is the default for any type not named in that function.

2. **The SSRF-hardened fetch path exists.** `internal/webui/image_proxy.go`
   already refuses loopback, RFC1918/ULA, link-local (including the
   169.254.169.254 cloud-metadata address), CGNAT and multicast addresses via
   `isDisallowedIP`/`safeDialContext`, and caps response size. Its own comment
   anticipates this use: "Unfurl favicons/previews are small". Fetching
   user-supplied URLs server-side is the security-sensitive part of this
   feature, and its defence is already written and tested.

## Identity and detection

`resourceurl.Infer` stays strict — it returns `ok=false` for anything it does
not recognise, and every existing caller keeps that behaviour. In particular
`worktree add ./typo-path` must keep failing rather than quietly following a
"link".

A new `resourceurl.InferAny` runs `Infer` first and falls back to `link` when,
and only when, the input parses as an absolute URL with scheme `http` or
`https` and a non-empty host. Two callers opt in: the web UI's add-resource
handler and `worktree resources add`.

### The ID is a normalized URL

Normalization, applied to produce both the resource ID and the stored URL:

- scheme and host lowercased
- a default port for the scheme (`:80` on http, `:443` on https) removed
- fragment (`#...`) stripped — it never reaches the server, so two URLs
  differing only by fragment are the same page
- path and query preserved exactly, including a trailing slash

Following the same page twice therefore reuses one resource rather than
creating a near-duplicate. Normalization is deliberately conservative: no
query-parameter sorting or stripping, because `?id=2` is a different page and
we cannot know which parameters are tracking noise.

## Resolution — `internal/linkmeta`

A new leaf package with one exported function, roughly:

```go
type Meta struct {
    Title, Description, Image, SiteName, Favicon string
    Embeddable   bool
    ResolveError string
}

func Resolve(ctx context.Context, rawURL string) Meta
```

It never returns an error: a link that cannot be resolved is still a link.
Failures land in `ResolveError` and the UI falls back to showing the URL.

**Fetch.** See "Fetching a user-supplied URL safely" below — it is the part of
this feature most worth getting right, and it is not a straight reuse of the
image proxy.

**Parse.** `golang.org/x/net/html` tokenizer over the `<head>`. Fields, each
in priority order:

| Field | Source |
|---|---|
| Title | `og:title`, then `<title>` |
| Description | `og:description`, then `<meta name="description">` |
| Image | `og:image` |
| SiteName | `og:site_name`, then the host |
| Favicon | `<link rel="icon">`, `rel="shortcut icon"`, `rel="apple-touch-icon"`, then `/favicon.ico` on the resolved origin |

All URL-valued fields are resolved against the **final** response URL, not the
requested one, so a redirect to a different origin does not produce broken
relative paths.

**Embeddability.** Read from the same response's headers, no extra request:

- `X-Frame-Options: DENY` or `SAMEORIGIN` (case-insensitive) → not embeddable
- `Content-Security-Policy` containing a `frame-ancestors` directive whose
  value is `'none'`, or a source list not permitting our origin → not
  embeddable. A `frame-ancestors *` permits it.
- neither header present → embeddable

This is captured server-side because **a blocked iframe cannot be detected
from JavaScript**: the load event fires either way, and the frame's document
is cross-origin and unreadable. Without this field the UI can only show a
blank rectangle and hope. With it, the UI can say why.

**Non-HTML responses** (PDF, image, JSON): skip parsing, derive the title from
the last path segment, and honour the framing headers as usual.

## Fetching a user-supplied URL safely

`linkmeta.Resolve` makes an outbound GET to a URL the user pasted. That is a
server-side request forgery surface, and it is the one part of this feature
where a mistake is not merely a bug.

**What is already solved.** `safeDialContext` (internal/webui/image_proxy.go)
resolves the host, **rejects it if ANY resolved IP is disallowed** — refusing a
dual-homed name rather than cherry-picking a public address from it — and then
dials the validated IP directly. Pinning the validated IP is what closes the
DNS-rebinding TOCTOU window: `net/http` never re-resolves the name, so a
hostname cannot pass the check and then resolve to `127.0.0.1` at connect
time. `isDisallowedIP` covers loopback, RFC1918/ULA private, link-local
(including the 169.254.169.254 cloud-metadata address), CGNAT 100.64.0.0/10,
multicast and unspecified. `linkmeta` uses this dialer unchanged, via a cloned
transport — never by mutating `http.DefaultTransport`, which is process-global.

**What is NOT already solved.** `handleImage` sets `CheckRedirect:
noFollowRedirects` — it refuses redirects outright. Link resolution cannot: a
large share of real URLs redirect (http→https, bare→www, shorteners). So this
feature introduces redirect following, and every control below is new work
rather than inherited:

- **Every hop is dialled through the same transport**, so the IP check and the
  pinning apply to each hop, not just the first. This is why the check belongs
  in the dialer and must not be reimplemented as a pre-flight lookup of the
  originally-requested host — a permitted host that 302s to an internal
  address is the classic bypass, and a pre-flight check would miss it.
- **`CheckRedirect` re-validates the scheme on every hop.** The dialer sees IPs
  and ports, never schemes. Each redirect target must be `http` or `https`
  with a non-empty host, or the redirect is refused. (Go already refuses
  unsupported schemes, but relying on that leaves the rule implicit and
  untested; assert it.)
- **`CheckRedirect` caps the chain at 5 hops**, below Go's default of 10.
- **No credentials of any kind.** No cookie jar, no `Authorization`, no
  forwarded request headers. This is a public page fetch; anything else would
  make the proxy a confused deputy.
- **The body is read through an `io.LimitReader`**, and the parser must behave
  correctly on a truncated document (a `<head>` cut mid-tag yields whatever
  fields were complete, not an error).
- **A total context timeout** bounds the whole chain, so a slow-loris redirect
  loop cannot pin a goroutine.

**Scheme policy.** Unlike the image proxy, `linkmeta` permits `http` as well as
`https` — plenty of real pages are still plaintext, and the private-range block
already prevents an `http://` URL from reaching anything internal. Non-http(s)
schemes (`file:`, `gopher:`, `ftp:`) are rejected at `InferAny`, so they never
become resources in the first place.

**Division of responsibility.** Who may call the API at all is the
webui-hardening spec's concern, not this one's. What this feature owes that
arrangement is not to weaken it: the private, link-local, loopback and
metadata address blocks in `safeDialContext` are the containment for every
outbound fetch introduced here, and they are the invariant that must not
regress.

**The iframe is a separate surface.** It renders a third-party page inside the
worktree UI's own page.

`sandbox` allows scripts, forms, same-origin and popups, and deliberately
withholds `allow-top-navigation` and `allow-downloads` — without those, a
framed page cannot navigate the worktree UI away from itself (frame-busting)
or start a download. `referrerpolicy="no-referrer"` keeps the worktree UI's
URL out of the framed site's logs.

`allow-same-origin` beside `allow-scripts` is the pair that lets a framed
document reach `parent` and delete its own `sandbox` attribute — **but only
when the frame is same-origin with its embedder.** Cross-origin, `parent`
access is blocked by the same-origin policy and the pair is inert. It is
granted because withholding it gives the framed document an opaque origin, in
which `localStorage`, `sessionStorage` and IndexedDB all throw `SecurityError`
and cookies are unreachable: most client-rendered sites then break during
bootstrap, and anything behind a login renders logged-out. Both failures look
to the user exactly like a bug in worktree — which is the failure mode the
"Can't embed page" panel exists to eliminate.

**So the same-origin case must be foreclosed deliberately, not incidentally.**
A URL like `http://127.0.0.1:8475/...` passes `InferAny` perfectly well. Today
it would be saved from framing only as a side effect: server-side resolution
refuses loopback, so `embeddable` ends up false. That is a coincidence of the
SSRF block, not a decision, and it would evaporate the moment `embeddable`
defaulted to true on a resolve error.

Therefore: **the UI must refuse to render an iframe whenever the link's origin
equals the worktree UI's own origin**, checked in the component and
independent of `embeddable`. Such a link shows the "Can't embed page" panel.
This is the rule that makes `allow-same-origin` safe, so it is not optional
and it gets its own test.

**Request-forgery defences, folded in here.** This feature adds a mutating
endpoint to a server that validates neither the `Origin` nor the
`Content-Type` of a request — `handleReply` decodes whatever JSON body
arrives. That combination is reachable from any page the user visits, because
a cross-origin request with a simple content type needs no CORS preflight: the
response is unreadable, but the side effect still happens.

So the API-wide protections against a request being *caused* by a page other
than our own land with this work. Two middlewares, applied to every mutating
API route rather than only the new one:

- **Require `Content-Type: application/json`** on any request carrying a body.
  A cross-origin caller cannot set that header without triggering a CORS
  preflight, and the server answers no preflight.
- **Reject cross-site requests** by `Sec-Fetch-Site`, with an `Origin`
  fallback for clients that do not send it. Same-origin requests and direct
  navigations are unaffected.

These are deliberately **not** replaced by the authentication in the
webui-hardening spec, and must not be dropped once it lands. That spec uses a
`SameSite=Lax` cookie, which a browser withholds on cross-site POST — but
`SameSite` is computed per *site*, which ignores the port, so a different
service on the same host counts as same-site. `Origin` includes the port;
this middleware is what distinguishes them. Neither control subsumes the
other.

Signed image-proxy URLs — the technique that makes a proxy accept only URLs
its own backend minted — are **not** part of this work. The frontend
constructs proxy URLs itself, and the Slack ones are extracted from image
references nested inside thread payloads, so minting them server-side means
reworking the thread rendering path rather than adding a helper. The option is
recorded in the hardening spec.

**Error text.** `resolve_error` records the real failure for debugging, but the
UI shows a generic "Couldn't load page details" — the raw error can name an
internal IP or hostname from the block message.

## Storage

`watcherdb.UpsertResourceState(conn, "link", id, stateJSON, resolvedAt, resolvedAt)`,
with `state_json`:

```json
{
  "title": "...", "description": "...", "image": "...",
  "site_name": "...", "favicon": "...",
  "embeddable": true, "resolved_at": "RFC3339", "resolve_error": ""
}
```

This reuses the existing cached-state mechanism rather than adding a table:
`enrichResourceDTO` already reads `watcher_resource_state` for every resource
and switches on type to populate the DTO, so a `case "link"` is the whole
read path.

**Note the one novelty:** worktree writes a `watcher_*` row for a type the
watcher library does not know about. That is safe and does not require a
library release — the table is a generic `(type, id) -> json` cache with no
per-type schema, and agent-handler has a physically separate database file
(see the repo's CLAUDE.md), so no other consumer can see these rows. It is
still worth recording here because every other row in that table today is
written by a library poller.

New `resourceDTO` fields: `description`, `image`, `site_name`, `favicon`,
`embeddable`, `resolve_error`. `title` is reused as-is.

`custom_name` / `custom_description` require no backend work whatsoever — they
live in `watcher_resource_meta` keyed by `(type, id)` and are already
type-agnostic.

## API

- `POST /api/worktree-resources/add` — unchanged shape; the handler switches
  from `Infer` to `InferAny`, and after a successful `resources.Add` of a
  `link`, resolves and stores metadata **before** responding, so the card is
  populated the moment it appears. A resolution failure is not an add failure.
- `POST /api/resource-resolve` `{type, id}` — re-resolve on demand, returning
  the updated DTO. Rejects any type other than `link`.
- `GET /api/resource-type?url=` — classifies a URL via `InferAny`, returning
  `{type, id}` or `{type: ""}`. Read-only, no DB write, no outbound request.
  Exists so the add-resource modal can ask the one detector what a URL is
  instead of re-implementing it (see the UI section).
- Favicon and `og:image` render through the existing image-proxy handler.

## UI

**Resource selector card.** Where a PR shows `#9688` and a Jira issue shows its
key, a link shows its **domain**: `shortResourceRef("link", id)` returns the
host with a leading `www.` removed. The favicon takes the slot the resource
status icon occupies for other types. Type badge: `Link`.

**Follow-resource modal (`AddResourceModal`).** Three changes.

The URL field's placeholder becomes "Paste any URL" — "Paste a PR, Jira, or
Slack URL" is now wrong, and it is the only place the UI states what may be
followed.

The Custom Name field must appear for a link as well as a Slack thread. Today
it is gated on `isSlackUrl(url)`, a frontend heuristic that checks whether the
string contains "slack.com". Extending that approach to links would mean
copying the PR and Jira patterns into the frontend so it could recognise what
is NOT one of them — which is precisely the duplication `internal/resourceurl`
exists to prevent (it was created because webui had hand-copied `cmd/root.go`'s
PR regex under a comment promising to keep them in sync).

So instead: a new `GET /api/resource-type?url=` returns `{type, id}` — or
`{type: ""}` for input that is not followable — by calling `InferAny`. The
modal calls it debounced as the user types and uses the answer to decide
whether to offer Custom Name (`slack` and `link` do; `pr` and `jira` have a
title from their source, which is why custom names exist at all). This
**deletes** `isSlackUrl` rather than adding a sibling to it, leaving one
detector in the codebase again.

The detected type is also shown beside the field as quiet confirmation — "Link
— example.com" — so it is obvious before submitting that a mistyped GitHub URL
is about to be followed as a plain page rather than as a PR.

**Detail pane.** `ResourceDetailPane` already switches on type — Slack renders
`SlackThreadPane` where PR/Jira render `TimelineBody`. A link renders a new
`LinkPane`: the resource card (with the custom name/description editing every
type shares), then the page.

- `embeddable === true` → an `<iframe>` filling the pane, `sandbox` set to
  allow scripts, forms and popups, `referrerpolicy="no-referrer"`.
- `embeddable === false` → **"Can't embed page"**, a sentence naming the site
  and saying it refuses to be embedded, and a button to open it.

**Open button.** `openLabel("link")` returns **"Open in new tab"**.

**Absent by construction:** no activity feed, no unread dot or badge, no
mark-read button, no watcher-freshness line, no refresh-watchers button. A
link has no events, so none of these have anything to show.

## Testing

- **Security tests are not optional here**, and each asserts a refusal, not a
  behaviour: a redirect to `127.0.0.1`, to `10.0.0.1`, and to
  `169.254.169.254` is refused *at the redirect*, not merely at the first hop;
  a redirect to a non-http(s) scheme is refused; a chain longer than 5 hops is
  refused; a host resolving to both a public and a private IP is refused; a
  body larger than the cap is truncated rather than read whole; and no
  `Cookie` or `Authorization` header is ever sent. The dialer's own IP
  predicate is already covered by the image-proxy tests — these cover the
  redirect path, which is new.
- Middleware: a POST with `Content-Type: text/plain` is refused; a POST with
  `Sec-Fetch-Site: cross-site` is refused; a same-origin POST with correct
  content type succeeds. Asserted against a mutating endpoint that predates
  this feature, not only against `/api/resource-resolve`, since the middleware
  is global.
- `linkmeta`: synthetic fixture HTML — full OG, no OG (title fallback), no
  head metadata at all, relative favicon, redirect changing origin, each
  framing-header form (`DENY`, `SAMEORIGIN`, `frame-ancestors 'none'`,
  `frame-ancestors *`, none), non-HTML content type, oversized body, and a
  timeout. Fixtures are hand-written, not captured from real sites.
- `resourceurl.InferAny`: table test asserting the link fallback, and that
  `Infer` is unchanged — including that a bare path, a `file://` URL and an
  empty string are all still rejected.
- `enrichResourceDTO`: a `link` state row populates the new fields; a
  malformed blob degrades to empty rather than erroring.
- UI: a link whose origin is the worktree UI's own origin renders the panel
  and never an iframe, **even when `embeddable` is true** — the test that
  keeps `allow-same-origin` safe.
- UI: both iframe branches, the "Can't embed page" copy, the domain in the
  selector card, the "Open in new tab" label, and the absence of the activity
  feed and unread affordances on a link.
- `AddResourceModal`: Custom Name appears for `slack` and `link` and not for
  `pr`/`jira`, driven by the classify endpoint (mocked); the placeholder no
  longer names three services; and no frontend module references "slack.com"
  as a URL test any more.

## Explicitly out of scope

- oEmbed discovery and rich embeds (video, tweets)
- JSON-LD / schema.org parsing
- Any background or lazy re-resolution — refresh is a button, nothing else
- Archiving or snapshotting page content
- Any timeline event for a link, including `watch_started`
