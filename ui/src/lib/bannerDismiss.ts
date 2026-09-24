/**
 * Per-tab suppression of the navigation banners.
 *
 * sessionStorage, deliberately, and it is the one place in this UI where that
 * choice is the RIGHT one rather than a trap: the banner is a nudge, not
 * state, so forgetting it is the desired behaviour. A new tab gets the banner
 * back, and so does a cmux pane that slept and was restored — the pane returns
 * with a fresh JS context, which is exactly the moment a way back is worth
 * offering again.
 *
 * Contrast homeWorktree.ts, where sessionStorage is only a second copy because
 * losing the home across a restore would be a bug.
 */

/** Which banner. They are mutually exclusive on any given route. */
export type BannerVariant = "home" | "all"

function key(variant: BannerVariant): string {
  return `worktree.banner.dismissed.${variant}`
}

/** Whether this tab has been told to stop showing `variant`. */
export function isBannerDismissed(variant: BannerVariant): boolean {
  try {
    return window.sessionStorage.getItem(key(variant)) === "1"
  } catch {
    // Private windows with site data blocked throw outright. A banner that
    // will not go away beats a blank page.
    return false
  }
}

/** Stops showing `variant` for the rest of this tab's life. */
export function dismissBanner(variant: BannerVariant): void {
  try {
    window.sessionStorage.setItem(key(variant), "1")
  } catch {
    // The component's own state still hides it for this render; only the
    // memory across navigations is lost.
  }
}
