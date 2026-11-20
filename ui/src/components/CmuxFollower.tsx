import { useEffect, useRef, useState } from "react"
import { Button, Group, Modal, Stack, Text } from "@mantine/core"
import { useLocation } from "wouter"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { api } from "../api/client"
import { onCmuxFocus } from "../lib/cmuxFocusBus"
import { hasUnsavedChanges } from "../lib/unsavedChanges"
import { worktreeName } from "../lib/homeWorktree"
import { WorktreeGlyph } from "./WorktreeGlyph"
import { useFollowCmux } from "../hooks/useFollowCmux"
import { useCmuxTwoWaySync } from "../hooks/useCmuxTwoWaySync"

const PREFIX = "/worktree/"

/**
 * How long, after two-way sync asks cmux to switch, focus events for any
 * other worktree are ignored (unless cmux confirms the switch first). cmux's
 * events arrive late: without this, a report of the workspace the tab just
 * left would drag it straight back.
 */
export const TWO_WAY_GUARD_MS = 2000

interface Guard {
  path: string
  until: number
}

/**
 * Switches cmux to `path`'s workspace, unless it has none or cmux already
 * shows one of them. The cmux query is reused when fresh and fetched when
 * not, so a page that never loaded it still switches.
 *
 * The guard goes up at once, before the lookup: a stale focus event during
 * that round trip would otherwise drag the tab back. Switches run one at a
 * time through `queue`, and each first checks the tab is still on `path`, so
 * a quick A → B → C sends only what is current when its turn comes and cmux
 * cannot finish on a worktree the user has already left.
 */
function selectWorkspaceFor(
  qc: QueryClient,
  path: string,
  guard: { current: Guard | null },
  queue: { current: Promise<void> },
): Promise<void> {
  const mine: Guard = { path, until: Date.now() + TWO_WAY_GUARD_MS }
  guard.current = mine
  // Only drop the guard this call set: a newer navigation owns it otherwise.
  const release = () => { if (guard.current === mine) guard.current = null }

  const run = async () => {
    let matches
    try {
      const cmux = await qc.fetchQuery({ queryKey: ["cmux"], queryFn: () => api.cmux(), staleTime: 30_000 })
      matches = cmux.available ? cmux.matches?.[path] ?? [] : []
    } catch {
      release()
      return
    }
    const stillHere = worktreeAt(window.location.pathname) === path
    if (!stillHere || matches.length === 0 || matches.some((ws) => ws.selected)) {
      release()
      return
    }
    // The window counts from the request, not from when it was queued.
    mine.until = Date.now() + TWO_WAY_GUARD_MS
    try {
      const res = await api.cmuxSelect(matches[0].ref)
      if (!res.ok) release()
      else void qc.invalidateQueries({ queryKey: ["cmux"] })
    } catch {
      release()
    }
  }
  const next = queue.current.then(run)
  queue.current = next
  return next
}

/** The worktree path a location shows, or null off the worktree pages. */
export function worktreeAt(location: string): string | null {
  if (!location.startsWith(PREFIX)) return null
  try {
    return decodeURIComponent(location.slice(PREFIX.length))
  } catch {
    return null
  }
}

/** Marks this component's own prompt, which never counts as "a modal open". */
const PROMPT_ATTR = "data-cmux-follow-prompt"

/**
 * Whether any modal is open, other than the follower's own prompt. Every
 * Mantine Modal and Drawer marks its content `aria-modal="true"` while
 * mounted; popovers, menus and tooltips do not, so they never count. Nested
 * modals are just more of them: "none open" means all of them closed.
 */
export function modalOpen(): boolean {
  for (const el of document.querySelectorAll('[aria-modal="true"]')) {
    if (!el.closest(`[${PROMPT_ATTR}]`)) return true
  }
  return false
}

interface Pending {
  path: string
  /** Asked because a modal is open, rather than over unsaved edits. */
  modal: boolean
  /** Something had unsaved edits when asked. */
  dirty: boolean
}

/**
 * Moves a tab with "Follow cmux" on to the worktree cmux just switched
 * to. Rendered once, inside the Router, on every page.
 *
 * Unsaved edits are never dropped silently: the tab asks first, and staying
 * turns following off — otherwise the very next switch would ask again.
 *
 * Leaving a worktree page any other way (the back link, browser back, a
 * notification, a link to another worktree) also turns following off: the
 * user has chosen where to be, and the next cmux switch should not overrule
 * it.
 *
 * Unless "Two-way sync" is on: then the tab's own move to a worktree page
 * switches cmux to that worktree's workspace instead, and a move anywhere
 * else (the home page, to pick the next worktree) leaves cmux alone. Either
 * way following stays on. See TWO_WAY_GUARD_MS for the one wrinkle.
 *
 * A switch never pulls the tab out from under an open modal: it asks
 * instead ("Close modal and follow" — navigating closes them, see the keyed
 * worktree route and SettingsProvider; "Stop following"; "Follow after
 * modal closes", which queues the switch until no modal is open, a later
 * cmux switch replacing it without asking again). The user navigating, or
 * turning following off, drops a queued switch.
 */
export function CmuxFollower() {
  const [follow, setFollow] = useFollowCmux()
  const [twoWay] = useCmuxTwoWaySync()
  const qc = useQueryClient()
  const guardRef = useRef<Guard | null>(null)
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const [location, navigate] = useLocation()
  // The worktree a focus change wants to open while the prompt is up; the
  // latest change wins.
  const [pending, setPending] = useState<Pending | null>(null)
  // A switch waiting for every modal to close ("Follow after modal closes").
  // Mirrored in a ref for the focus subscription, which is not rebuilt.
  const [queued, setQueuedState] = useState<string | null>(null)
  const queuedRef = useRef<string | null>(null)
  const setQueued = (path: string | null) => {
    queuedRef.current = path
    setQueuedState(path)
  }
  // The Router's navigate is a fresh function each render; a ref keeps the
  // focus subscription from being torn down and rebuilt on every one.
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  // The worktree this component is navigating to, so the location change it
  // causes is not mistaken for the user leaving the page.
  const expectedRef = useRef<string | null>(null)
  const prevLocation = useRef(location)

  const go = (path: string) => {
    expectedRef.current = path
    navigateRef.current(`${PREFIX}${encodeURIComponent(path)}`)
  }

  // Where a switch to `path` goes: nowhere if already there, a queued switch
  // replaced while a modal is still open, a prompt over a modal or unsaved
  // edits, else straight there.
  const consider = (path: string) => {
    if (worktreeAt(window.location.pathname) === path) {
      // Already here (e.g. the page's own "Switch cmux" button).
      setPending(null)
      setQueued(null)
      return
    }
    if (modalOpen()) {
      if (queuedRef.current !== null) setQueued(path)
      else setPending({ path, modal: true, dirty: hasUnsavedChanges() })
      return
    }
    setQueued(null)
    if (hasUnsavedChanges()) {
      setPending({ path, modal: false, dirty: true })
      return
    }
    go(path)
  }
  const considerRef = useRef(consider)
  considerRef.current = consider

  useEffect(() => {
    if (!follow) {
      setPending(null)
      setQueued(null)
      return
    }
    return onCmuxFocus((msg) => {
      // A workspace with no worktree in it: nowhere to go, so stay put.
      if (!msg.path) return
      const guard = guardRef.current
      if (guard) {
        if (msg.path === guard.path) guardRef.current = null
        else if (Date.now() < guard.until) return
        else guardRef.current = null
      }
      considerRef.current(msg.path)
    })
  }, [follow])

  // A queued switch lands once no modal is open: watched on the DOM, since
  // modals come and go without telling anyone.
  useEffect(() => {
    if (queued === null) return
    const check = () => {
      if (modalOpen()) return
      const to = queuedRef.current
      setQueued(null)
      if (to) considerRef.current(to)
    }
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true })
    check()
    return () => observer.disconnect()
  }, [queued])

  useEffect(() => {
    const from = worktreeAt(prevLocation.current)
    const changed = prevLocation.current !== location
    prevLocation.current = location
    if (!changed) return
    const to = worktreeAt(location)
    const expected = expectedRef.current
    expectedRef.current = null
    if (!follow || (expected !== null && to === expected)) return
    // The user chose where to be: a switch waiting on a modal is stale now.
    setQueued(null)
    if (twoWay) {
      if (to !== null) void selectWorkspaceFor(qc, to, guardRef, queueRef)
      return
    }
    if (from !== null) setFollow(false)
  }, [location, follow, twoWay, setFollow, qc])

  // Navigating some other way while the prompt is up answers it.
  useEffect(() => {
    if (pending !== null && worktreeAt(location) === pending.path) setPending(null)
  }, [location, pending])

  const target = pending && <b><WorktreeGlyph /><span>{worktreeName(pending.path)}</span></b>
  const follow_ = () => {
    const to = pending?.path
    setPending(null)
    if (to) go(to)
  }
  const stop = () => {
    setPending(null)
    setFollow(false)
  }

  return (
    <Modal
      opened={pending !== null}
      onClose={() => {}}
      title={pending?.modal ? "A modal is open" : "Unsaved changes"}
      centered
      // A choice is required: dismissing would leave following on, and the
      // next switch would only ask again.
      withCloseButton={false}
      closeOnClickOutside={false}
      closeOnEscape={false}
      // Above any modal the page has open: that is often where the unsaved
      // edits are, and its overlay would otherwise swallow these buttons.
      zIndex={1000}
      {...{ [PROMPT_ATTR]: true }}
    >
      {pending?.modal ? (
        <Stack gap="md">
          <Text size="sm">
            cmux switched to {target}, but a modal is open here. Following now closes it
            {pending.dirty ? ", and its unsaved changes will be lost." : "."}
          </Text>
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={stop}>Stop following</Button>
            <Button
              variant="default"
              onClick={() => {
                const to = pending.path
                setPending(null)
                setQueued(to)
              }}
            >
              Follow after modal closes
            </Button>
            <Button color={pending.dirty ? "red" : undefined} onClick={follow_}>Close modal and follow</Button>
          </Group>
        </Stack>
      ) : (
        <Stack gap="md">
          <Text size="sm">
            cmux switched to {target}, but this page has unsaved
            changes. Following cmux will discard them.
          </Text>
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={stop}>Stay and stop following</Button>
            <Button color="red" onClick={follow_}>Discard and follow</Button>
          </Group>
        </Stack>
      )}
    </Modal>
  )
}
