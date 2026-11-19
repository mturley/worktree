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
 */
export function CmuxFollower() {
  const [follow, setFollow] = useFollowCmux()
  const [twoWay] = useCmuxTwoWaySync()
  const qc = useQueryClient()
  const guardRef = useRef<Guard | null>(null)
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const [location, navigate] = useLocation()
  // The worktree a focus change wants to open while the unsaved-changes
  // prompt is up; the latest change wins.
  const [pending, setPending] = useState<string | null>(null)
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

  useEffect(() => {
    if (!follow) {
      setPending(null)
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
      if (worktreeAt(window.location.pathname) === msg.path) {
        // Already here (e.g. the page's own "Switch cmux" button).
        setPending(null)
        return
      }
      if (hasUnsavedChanges()) {
        setPending(msg.path)
        return
      }
      go(msg.path)
    })
  }, [follow])

  useEffect(() => {
    const from = worktreeAt(prevLocation.current)
    const changed = prevLocation.current !== location
    prevLocation.current = location
    if (!changed) return
    const to = worktreeAt(location)
    const expected = expectedRef.current
    expectedRef.current = null
    if (!follow || (expected !== null && to === expected)) return
    if (twoWay) {
      if (to !== null) void selectWorkspaceFor(qc, to, guardRef, queueRef)
      return
    }
    if (from !== null) setFollow(false)
  }, [location, follow, twoWay, setFollow, qc])

  // Navigating some other way while the prompt is up answers it.
  useEffect(() => {
    if (pending !== null && worktreeAt(location) === pending) setPending(null)
  }, [location, pending])

  return (
    <Modal
      opened={pending !== null}
      onClose={() => {}}
      title="Unsaved changes"
      centered
      // A choice is required: dismissing would leave following on, and the
      // next switch would only ask again.
      withCloseButton={false}
      closeOnClickOutside={false}
      closeOnEscape={false}
      // Above any modal the page has open: that is often where the unsaved
      // edits are, and its overlay would otherwise swallow these buttons.
      zIndex={1000}
    >
      <Stack gap="md">
        <Text size="sm">
          cmux switched to <b>{pending && <><WorktreeGlyph /><span>{worktreeName(pending)}</span></>}</b>, but this page has unsaved
          changes. Following cmux will discard them.
        </Text>
        <Group justify="flex-end" gap="xs">
          <Button
            variant="default"
            onClick={() => {
              setPending(null)
              setFollow(false)
            }}
          >
            Stay and stop following
          </Button>
          <Button
            color="red"
            onClick={() => {
              const to = pending
              setPending(null)
              if (to) go(to)
            }}
          >
            Discard and follow
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
