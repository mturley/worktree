import { useState } from "react"
import { Button, Group } from "@mantine/core"
import { IconArrowLeft } from "@tabler/icons-react"
import { useLocation } from "wouter"
import { useCmux } from "../api/cmux"
import { dismissBanner, isBannerDismissed, type BannerVariant } from "../lib/bannerDismiss"
import {
  getHomeWorktree,
  homeWorktreeHref,
  shouldShowAllWorktreesBanner,
  shouldShowHomeBanner,
  worktreeName,
} from "../lib/homeWorktree"

/**
 * The way back to wherever this tab came from.
 *
 * Two variants, never both at once:
 *
 *   home — a cmux workspace pins this UI as a pane belonging to one worktree,
 *     and `worktree ui` run from inside a worktree opens the same thing. Both
 *     mark the tab with `?home=`, and both are easy to navigate away from,
 *     with nothing on the far page remembering where you started.
 *
 *   all — no `?home=`, but the UI is running under cmux and the selected
 *     workspace belongs to no worktree: an overview workspace. "Where I came
 *     from" is then the listing, not any one worktree.
 *
 * Renders nothing in a tab opened by hand in a plain browser, which is most of
 * them, and nothing on the page it points at.
 *
 * It IS dismissible, per tab. An earlier version was not, on the reasoning
 * that a navigation aid which can be hidden is missing exactly when it is
 * wanted — but that traded one person's whole session of screen space for a
 * button one click away. Per-tab is the compromise: sessionStorage forgets,
 * so a new tab and a restored cmux pane both get it back.
 */
export function HomeWorktreeBanner() {
  const [location, navigate] = useLocation()
  const cmux = useCmux()
  // Read once per mount rather than per render: the value only ever changes
  // through the dismiss button below, which sets both at the same time.
  const [dismissed, setDismissed] = useState(
    () => ({ home: isBannerDismissed("home"), all: isBannerDismissed("all") }),
  )

  const dismiss = (variant: BannerVariant) => () => {
    dismissBanner(variant)
    setDismissed((d) => ({ ...d, [variant]: true }))
  }

  const home = getHomeWorktree()
  if (home && shouldShowHomeBanner(home, location)) {
    if (dismissed.home) return null
    return (
      <NavBanner
        label={`Back to current worktree: ${worktreeName(home)}`}
        onBack={() => navigate(homeWorktreeHref(home))}
        onDismiss={dismiss("home")}
      />
    )
  }

  if (shouldShowAllWorktreesBanner(home, location, cmux.data)) {
    if (dismissed.all) return null
    return (
      <NavBanner
        label="Back to all worktrees"
        onBack={() => navigate("/")}
        onDismiss={dismiss("all")}
      />
    )
  }

  return null
}

interface NavBannerProps {
  label: string
  onBack: () => void
  onDismiss: () => void
}

/** The bar itself: a wide way back, and a quiet way to be rid of it. */
function NavBanner({ label, onBack, onDismiss }: NavBannerProps) {
  return (
    // Full width and left-aligned so it reads as a bar belonging to the page
    // rather than a floating control, and lands where the eye starts. The
    // dismiss sits at the far right, outside the main button — nesting one
    // button inside another is invalid markup and unreachable by keyboard.
    <Group gap="xs" wrap="nowrap" mt="sm" mb="sm">
      <Button
        flex={1}
        justify="flex-start"
        size="xl"
        variant="light"
        // Still above the page's own worktree title (18px, order={4} on the
        // detail page), so the way back reads as louder than where you are —
        // but only just. It is a signpost, not a headline.
        styles={{ label: { fontSize: "var(--mantine-font-size-xl)" } }}
        leftSection={<IconArrowLeft size={22} />}
        onClick={onBack}
      >
        {label}
      </Button>
      <Button variant="subtle" color="gray" size="compact-sm" onClick={onDismiss}>
        Don't show this
      </Button>
    </Group>
  )
}
