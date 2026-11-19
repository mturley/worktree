import { useState } from "react"
import { Button, Group } from "@mantine/core"
import { IconArrowLeft } from "@tabler/icons-react"
import { useLocation } from "wouter"
import { KeyHint } from "./search/KeyHint"
import { dismissBanner, useBannerDismissed } from "../lib/bannerDismiss"
import { useEscLeaves, usePublishBannerShown } from "../lib/escapeHint"
import { WorktreeGlyph } from "./WorktreeGlyph"
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
 * `worktree ui` run from inside a worktree opens the same thing. Both mark
 * the tab with `?home=`, and both are easy to navigate away from, with
 * nothing on the far page remembering where you started.
 *
 * Renders nothing in a tab nobody homed, which is most of them, and nothing
 * on the home worktree's own page.
 *
 * It IS dismissible, per tab. An earlier version was not, on the reasoning
 * that a navigation aid which can be hidden is missing exactly when it is
 * wanted — but that traded one person's whole session of screen space for a
 * button one click away. Per-tab is the compromise: sessionStorage forgets,
 * so a new tab and a restored cmux pane both get it back.
 */
export function HomeWorktreeBanner() {
  const [location, navigate] = useLocation()
  // Shared with the pages: a dismissed banner also drops Esc's step home
  // (see useEscHome). The local copy hides it even when sessionStorage is
  // blocked and the shared one cannot remember.
  const [hidden, setHidden] = useState(false)
  const dismissed = useBannerDismissed("home") || hidden

  const home = getHomeWorktree()
  const shown = home !== null && shouldShowHomeBanner(home, location) && !dismissed
  usePublishBannerShown(shown)
  // Esc goes where this banner does whenever the page says Esc leaves.
  const escLeaves = useEscLeaves()

  if (!shown) return null
  return (
    <NavBanner
      label={<>Back to current worktree: <WorktreeGlyph /><span>{worktreeName(home)}</span></>}
      onBack={() => navigate(homeWorktreeHref(home))}
      onDismiss={() => {
        setHidden(true)
        dismissBanner("home")
      }}
      escHint={escLeaves}
    />
  )
}

interface NavBannerProps {
  label: React.ReactNode
  onBack: () => void
  onDismiss: () => void
  /** Show the Esc hint: Esc's next step is this banner's way back. */
  escHint: boolean
}

/** The bar itself: a wide way back, and a quiet way to be rid of it. */
function NavBanner({ label, onBack, onDismiss, escHint }: NavBannerProps) {
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
        rightSection={escHint && <span aria-hidden="true" style={{ display: "inline-flex" }}><KeyHint>Esc</KeyHint></span>}
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
