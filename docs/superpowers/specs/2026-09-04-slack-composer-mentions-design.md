# Slack composer autocomplete — @mentions, :emoji: and #channels

**Date:** 2026-09-04
**Status:** design approved, awaiting implementation plan

## Problem

`worktree ui`'s Slack thread view can read a thread and post a plain-text
reply, but it cannot mention anyone. `ui/src/components/slack/Composer.tsx` is
a Mantine `Textarea` holding raw mrkdwn; typing `@alice` posts the literal
characters, which Slack renders as text and which notifies nobody.

Everything needed to *render* a mention already exists — `Mention.tsx`,
`RichText.tsx`, `lib/mrkdwn.tsx`, and `watcher/slack/mentions.go`'s
`MentionIDs`/`ResolveMentions`. What is missing is the composing half: a way to
search the workspace directory, and an editor that can hold a mention as an
atomic object rather than a string of characters.

## Goals

- Type `@` in the reply composer and pick a **user**, a **user group**, or one
  of `@here` / `@channel` / `@everyone`; the reply posts a real mention that
  notifies.
- Type `:` and pick an emoji; type `#` and pick a channel.
- A picked candidate appears as an atomic **pill**, styled like the rendered
  mention it will become — not as raw `<@U123>` text.
- Everything the composer does today keeps working: the formatting toolbar,
  Enter to send, Shift+Enter for a newline.

## Non-goals

- **Drafts and message editing.** The composer still starts empty and its
  contents are lost on unmount, exactly as today.
- **`emojis/search`.** Documented during recon, deliberately unused — see
  "Emoji needs no Slack call" below.
- **Rich text formatting.** The toolbar keeps inserting literal mrkdwn
  characters; the editor does not gain bold/italic *styling*.
- **A "join channel" affordance** on `#` results, or filtering `#` results by
  membership.
- **Mentions anywhere but the reply composer** (no search box, no edit box).

## Recon summary

Captured 2026-09-04 by driving the real Slack web client under Playwright and
reading its network log; full detail, including request bodies and response
shapes, is in `docs/reverse-engineering/slack-web-api.md` under "Composer
autocomplete — the edge-cache `*/search` endpoints". That document is the
normative reference; this section is orientation only.

| Trigger | Endpoint (on `edgeapi.slack.com`) | Notes |
|---|---|---|
| `@` | `cache/<TEAM>/users/search` | Fuzzy, **org-wide**, not channel-scoped. Results have the `users.info` shape. |
| `@` | `cache/<TEAM>/usergroups/search` | Fired alongside. Matches name **and description**. **Returns deleted groups.** |
| `:` | `cache/<TEAM>/emojis/search` | **Custom emoji only** — no Unicode emoji. Unused; see below. |
| `#` | `cache/<TEAM>/channels/search` | Fuzzy; includes private channels the user is in. |

All four share the shape of the `usergroups/info` call the codebase already
makes: same host, same `/cache/<TEAM_OR_ENTERPRISE_ID>/…?_x_app_name=client`
path, same `{"token":…,"enterprise_token":…}` JSON body with the token **in the
body**, same `{"ok":true,"results":[…]}` envelope, same `xoxc` token + `d`
cookie we already hold.

`@here` / `@channel` / `@everyone` come from no endpoint — Slack's client
injects them locally, and so will ours.

## Architecture

Three layers, in dependency order.

### 1. Slack client (`~/git/watcher/slack`) — cross-repo

Per the repo's cross-repo rule, poller/client/schema work happens in the
watcher library, is released as a tag, and is re-pinned here. No local patch.

**Refactor first.** `UserGroupsInfo` inlines edge-call mechanics: URL
construction from `teamIDOnce`, token-in-body marshalling, the `Cookie: d=…`
header, and the `ok:false` → `ErrAuth` mapping. Extract that into a shared

```go
func (c *HTTPClient) edgeCall(ctx context.Context, path string, payload map[string]any, out any) error
```

and reimplement `UserGroupsInfo` on top of it. Four more copies of that body is
the wrong shape, and the refactor is what makes the three new methods small.

**New methods:**

```go
func (c *HTTPClient) SearchUsers(ctx context.Context, query, currentChannel string, limit int) ([]User, error)
func (c *HTTPClient) SearchUserGroups(ctx context.Context, query string, limit int) ([]UserGroup, error)
func (c *HTTPClient) SearchChannels(ctx context.Context, query string, limit int) ([]Channel, error)
```

- `SearchUsers` sends `fuzz:1`, `include_profile_only_users:true`,
  `enable_workspace_ranking:true`, and `current_channel` as a ranking hint. It
  normalizes results through the **existing** per-user mapping so display
  names and avatars match what the thread view already renders. Deleted users
  and bots are returned by Slack; filter `deleted` in the library.
- `SearchUserGroups` sends `org_wide:true` and **filters `date_delete != 0` in
  the library**. Slack returns dead groups; no consumer should have to
  remember that.
- `SearchChannels` needs a new domain type — `Channel{ID, Name, IsPrivate,
  IsArchived}` — kept minimal deliberately, since the endpoint returns a full
  conversation object and we need four fields. Archived channels are filtered
  in the library. `top_channels` is omitted: it is only a ranking hint.

**Tests:** table tests against synthetic fixtures in
`~/git/watcher/slack/testdata/`. Real Slack content and real tokens are
forbidden there, as they are everywhere (see the Slack conventions in
`CLAUDE.md`); fixtures reproduce structure with invented names.

Release a tag, then `go get github.com/mturley/watcher@vX.Y.Z && go mod tidy`
here and rebuild.

### 2. Backend endpoint (`internal/webui`)

One endpoint, not three, alongside the existing `/api/thread`,
`/api/thread/reply` and `/api/slack-config`:

```
GET /api/slack-autocomplete?trigger=@&q=turl&channel=C069KSM8T9N
```

- `trigger` is one of `@`, `:`, `#`. Anything else is a 400.
- `q` is the text after the trigger, without it.
- `channel` is the thread's channel, passed to Slack as a ranking hint.

Response:

```json
{"results":[
  {"kind":"user",    "id":"UM21S8ZRR",   "label":"Mike Turley",
   "detail":"mturley", "avatar":"https://…", "token":"<@UM21S8ZRR>"},
  {"kind":"group",   "id":"S07CFUVMXBM", "label":"@zaffre-scrum",
   "detail":"OpenShift AI Dashboard Zaffre Scrum", "token":"<!subteam^S07CFUVMXBM>"},
  {"kind":"special", "id":"here",        "label":"@here",
   "detail":"Notify everyone online in this channel", "token":"<!here>"},
  {"kind":"channel", "id":"C069KSM8T9N", "label":"#odh-dashboard",
   "token":"<#C069KSM8T9N|odh-dashboard>"},
  {"kind":"emoji",   "id":"smile-cry",   "label":":smile-cry:",
   "imageUrl":"https://emoji.slack-edge.com/…", "token":":smile-cry:"}
]}
```

**The `token` field is the load-bearing part of this design.** The server
returns the exact string to insert, so mrkdwn mention encoding lives in one Go
place with table tests and the frontend never hand-builds `<@U…>` or
`<#C…|name>`. It is also what makes the pill and the serialized output
incapable of disagreeing: the pill *stores* the token it will emit.

Dispatch by trigger:

- `@` — `SearchUsers` and `SearchUserGroups` concurrently, plus the three
  specials matched locally against `q`. Merged into one ranked list: exact
  handle/name match first, then users, then groups, then specials.
- `#` — `SearchChannels`.
- `:` — filters the already-cached **custom** emoji map. **No Slack call.**
  The Unicode half is matched client-side from `node-emoji` and merged into
  the same menu, so `:` follows the same local-plus-remote pattern as `@`
  (with "remote" here meaning worktree's own server, not Slack).

**Emoji needs no Slack call.** `slack.go`'s `emoji()` already fetches and
caches the entire `emoji.list` map on the server, and `node-emoji` is already
a UI dependency supplying the Unicode half. `emojis/search` would add traffic
to answer a question we can already answer locally, and it returns only the
custom half anyway. The endpoint is documented in the RE doc and left unused.

**Guards.** These are requirements, not polish. The RE doc records that a
short burst of scripted calls got the user's session token revoked twice in
twenty minutes; four new call sites driven by typing is the largest increase
in Slack traffic this app has ever made.

- In-memory TTL cache (~60s) keyed by `(trigger, q, channel)`, with
  single-flight so concurrent identical queries make one Slack call.
- Minimum query length of 1: for a bare `@`, the server returns only the
  specials and makes no Slack call. (The client still shows its local
  candidates — thread participants and groups — under that same bare `@`; see
  "Hybrid lookup".)
- `count: 25`, matching what Slack's own client requests.
- On a Slack error, return the error. The UI degrades to local results (see
  below) rather than the server inventing an empty success.

### 3. Composer (`ui/src/components/slack/`)

**Foundation: Lexical** (`lexical` + `@lexical/react`), chosen over a
hand-rolled contenteditable because atomic pills, caret behaviour around them,
undo/redo and IME are exactly the edge cases it exists to solve, and over
Slate because Lexical ships a typeahead plugin and Slate does not.

- **`PlainTextPlugin`, not `RichTextPlugin`.** Formatting is literal mrkdwn
  characters (`*bold*`), not styled runs, so the document model stays "text +
  pills + line breaks" and serialization stays trivial.
- **`MentionNode extends DecoratorNode`** holding `{kind, id, label, token}`
  and rendering the existing `Mention` pill component, so a pending mention in
  the box looks like the mention it will become. `exportJSON`/`importJSON` are
  implemented even though drafts are out of scope — a serializable node costs
  little now and unblocks drafts later.
- **`LexicalTypeaheadMenuPlugin`** with a custom trigger matcher wrapping
  `detectTrigger`, so one plugin instance serves all three triggers and
  reports which fired. The menu renders through a Mantine portal.
- **`KEY_ENTER_COMMAND` at high priority:** menu open → select the highlighted
  candidate; Shift held → line break; otherwise → send. Enter must never send
  while the menu is open.
- **Paste as plain text:** a `PASTE_COMMAND` handler strips HTML, so pasting
  from a browser or from Slack cannot inject foreign markup.
- **Toolbar:** the five existing buttons keep wrapping the selection in mrkdwn
  characters, now via `$getSelection()` and `insertText` instead of textarea
  offset arithmetic.

**Logic lives in pure functions, the editor is a thin shell.** jsdom has no
real Selection or contenteditable behaviour, so anything buried in a DOM event
handler is untestable in this repo's vitest setup.

```ts
serializeToMrkdwn(editorState): string
detectTrigger(textBeforeCaret): { trigger: '@' | ':' | '#'; query: string; start: number } | null
```

- `serializeToMrkdwn` walks the editor state, emitting text runs verbatim,
  each `MentionNode` as its stored `token`, and line breaks as `\n`.
- `detectTrigger` owns the fiddly rules: a trigger counts only at
  start-of-line or after whitespace; the query ends at whitespace; Escape or a
  space closes the menu.
- `AutocompleteMenu` is presentational (items, highlighted index, callbacks),
  asserted with Testing Library and no contenteditable in sight.

### Hybrid lookup

The client answers the first keystroke from data the thread view already
holds — thread participants from `ThreadResponse`'s users map, groups from
`SlackGroupsContext`, and the three specials — filtered locally with the same
substring rule the server uses. The server call is debounced ~150ms and merged
when it lands, deduped by `(kind, id)`, with local entries keeping the higher
rank.

Two consequences, stated so they are not later mistaken for bugs:

- **The menu can reorder once**, when remote results merge in. It does not
  reorder after that.
- **Selection tracks by `(kind, id)`, not by index**, so a merge landing
  mid-keyboard-navigation cannot move the highlight under the user.

Staleness is handled by an `AbortController` per query plus a sequence
counter; a response that is not the newest is dropped, never rendered. If the
server call fails, the menu keeps its local results and shows a quiet
"workspace search unavailable" line rather than emptying itself.

## Risks

**A plain-`text` mention may not notify.** `PostReply` sends `text`; Slack's
own client sends `blocks`. If `<@U123>` in `text` renders as a pill but pings
nobody, the entire feature fails silently — the worst possible failure mode,
because it looks like it works. **The first task of the implementation plan is
a single verification post** to the user's self-DM (`DMFAS8V0X`, the only
place authorised for test posts) confirming that a `text`-encoded mention both
renders as a mention and notifies. Nothing else is built until that is
answered; if it fails, the fallback is constructing `blocks` (a `rich_text`
block with `user`/`usergroup`/`broadcast` elements) in `PostReply`, which is a
watcher-library change and would expand the plan.

**Token revocation.** See the guards above. Additionally, no part of this
feature may poll: every Slack call it makes is caused by a human keystroke.

**Lexical is a new dependency in a dependency-light repo.** Accepted
deliberately; the alternative is owning contenteditable's long tail by hand.
Confined to the composer — nothing else in the UI imports it.

## Testing

- **Library:** table tests for each new method against synthetic fixtures;
  `edgeCall` error mapping (`invalid_auth` → `ErrAuth`) tested once rather
  than per method.
- **Backend:** table tests for token construction across all five kinds, the
  deleted-group and archived-channel filters, the trigger dispatch, the 400 on
  a bad trigger, cache hits/single-flight, and the error path.
- **Frontend:** `serializeToMrkdwn` and `detectTrigger` test-first as pure
  functions; `AutocompleteMenu` with Testing Library; the existing
  `Composer.test.tsx` behaviours (Enter sends, Shift+Enter newlines, toolbar
  wraps) preserved and extended with "Enter selects while the menu is open".
- **Manual smoke:** a real thread in `worktree ui`, typing each trigger,
  confirming the posted message renders as a mention in the real Slack client.

## Documentation

`docs/reverse-engineering/slack-web-api.md` was updated with the recon
findings **as part of this design work**, not deferred. Any further discovery
during implementation — a changed response shape, a new field, a rate-limit
behaviour — updates that file in the same change, per the repo rule.
`docs/web-ui-architecture.md`'s Slack section gains the new route and DTO.
