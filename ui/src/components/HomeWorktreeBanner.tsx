import { Button } from "@mantine/core"
import { IconArrowLeft } from "@tabler/icons-react"
import { useLocation } from "wouter"
import {
  getHomeWorktree,
  homeWorktreeHref,
  shouldShowHomeBanner,
  worktreeName,
} from "../lib/homeWorktree"

/**
 * The way back to the worktree this tab was opened for.
 *
 * A cmux workspace pins this UI as a pane belonging to one worktree, and
 * `worktree ui` run from inside a worktree opens the same thing. Both are easy
 * to navigate away from — into the global timeline, into another worktree —
 * and nothing on those pages remembers where you started.
 *
 * Renders nothing in a tab that was opened by hand, which is most of them.
 * Not dismissible: a navigation aid that can be hidden is missing exactly when
 * it is wanted, and it already hides itself on the page it points at.
 */
export function HomeWorktreeBanner() {
  const [location, navigate] = useLocation()
  const home = getHomeWorktree()
  if (!shouldShowHomeBanner(home, location) || !home) return null

  return (
    // Full width and left-aligned so it reads as a bar belonging to the page
    // rather than a floating control, and lands where the eye starts.
    <Button
      fullWidth
      justify="flex-start"
      size="xl"
      variant="light"
      mt="sm"
      mb="sm"
      // One step up the heading scale from the page's own worktree title
      // (order={4} on the detail page), so the way back reads as louder than
      // where you currently are — which is the point of it.
      styles={{ label: { fontSize: "var(--mantine-h3-font-size)" } }}
      leftSection={<IconArrowLeft size={22} />}
      onClick={() => navigate(homeWorktreeHref(home))}
    >
      {`Back to current worktree ${worktreeName(home)}`}
    </Button>
  )
}
