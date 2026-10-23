import { Component, type ReactNode } from "react"
import { Button, Stack, Text } from "@mantine/core"

const RELOAD_KEY = "worktree.preloadReloadAt"
const RELOAD_GUARD_MS = 10_000

/**
 * Reloads the page when Vite fails to preload a lazy chunk — almost always
 * because `make install` replaced the build and the old chunk's hashed name is
 * gone. A reload fetches the new index and its chunks. A reload within the
 * last few seconds means the chunk is missing from the new build too, so it
 * lets the error through to DiffViewBoundary rather than looping.
 */
export function installPreloadReload() {
  if (installed) return
  installed = true
  window.addEventListener("vite:preloadError", (event) => {
    let last = 0
    try {
      last = Number(window.sessionStorage.getItem(RELOAD_KEY)) || 0
    } catch {
      // Storage blocked: no loop guard, so don't risk reloading.
      return
    }
    if (Date.now() - last < RELOAD_GUARD_MS) return
    try {
      window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
    } catch {
      return
    }
    event.preventDefault()
    window.location.reload()
  })
}
let installed = false

/**
 * Wraps the lazily loaded DiffView. It must stay out of DiffView's chunk:
 * it catches that chunk failing to load (or DiffView throwing), so the page
 * shows a way out instead of an empty area under its header.
 */
export class DiffViewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <Stack gap="xs" align="flex-start" p="md">
        <Text size="sm" c="red">
          Couldn't load the diff view — reload the page.
        </Text>
        <Button size="xs" variant="light" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </Stack>
    )
  }
}
