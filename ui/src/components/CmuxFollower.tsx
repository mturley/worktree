import { useEffect, useRef, useState } from "react"
import { Button, Group, Modal, Stack, Text } from "@mantine/core"
import { useLocation } from "wouter"
import { onCmuxFocus } from "../lib/cmuxFocusBus"
import { hasUnsavedChanges } from "../lib/unsavedChanges"
import { worktreeName } from "../lib/homeWorktree"
import { useFollowCmux } from "../hooks/useFollowCmux"

const PREFIX = "/worktree/"

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
 * Moves a tab with "Follow cmux focus" on to the worktree cmux just switched
 * to. Rendered once, inside the Router, on every page.
 *
 * Unsaved edits are never dropped silently: the tab asks first, and staying
 * turns following off — otherwise the very next switch would ask again.
 */
export function CmuxFollower() {
  const [follow, setFollow] = useFollowCmux()
  const [location, navigate] = useLocation()
  // The worktree a focus change wants to open while the unsaved-changes
  // prompt is up; the latest change wins.
  const [pending, setPending] = useState<string | null>(null)
  // The Router's navigate is a fresh function each render; a ref keeps the
  // focus subscription from being torn down and rebuilt on every one.
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate

  useEffect(() => {
    if (!follow) {
      setPending(null)
      return
    }
    return onCmuxFocus((msg) => {
      // A workspace with no worktree in it: nowhere to go, so stay put.
      if (!msg.path) return
      if (worktreeAt(window.location.pathname) === msg.path) {
        // Already here (e.g. the page's own "Switch cmux" button).
        setPending(null)
        return
      }
      if (hasUnsavedChanges()) {
        setPending(msg.path)
        return
      }
      navigateRef.current(`${PREFIX}${encodeURIComponent(msg.path)}`)
    })
  }, [follow])

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
          cmux switched to <b>{pending ? worktreeName(pending) : ""}</b>, but this page has unsaved
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
              if (to) navigate(`${PREFIX}${encodeURIComponent(to)}`)
            }}
          >
            Discard and follow
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
