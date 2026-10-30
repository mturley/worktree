// Inputs you type into. A switch or checkbox is an <input> too, and keeps
// focus after a click, but Esc and / mean nothing to it.
const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number"])

export function isEditable(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  if (tag === "INPUT") return TEXT_INPUT_TYPES.has((el as HTMLInputElement).type)
  return tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable
}

/** Hidden (or inside something hidden): a closed or exiting overlay owns no Esc. */
export function isHidden(el: Element): boolean {
  if (el.closest('[aria-hidden="true"], [hidden]')) return true
  for (let n: Element | null = el; n; n = n.parentElement) {
    const st = getComputedStyle(n)
    if (st.display === "none" || st.visibility === "hidden") return true
  }
  return false
}

const OVERLAYS = '[role="dialog"], [role="menu"], [role="listbox"]'

/** The modals, menus and listboxes on screen now. */
function openOverlays(): Element[] {
  return [...document.querySelectorAll(OVERLAYS)].filter((el) => !isHidden(el))
}

/** Whether a modal, menu or listbox is open: it owns the keyboard, not the page. */
export function overlayOpen(): boolean {
  return openOverlays().length > 0
}

/*
 * The overlays that were open as the last Esc went down, before any handler
 * ran. Mantine closes a modal from a window keydown listener, and a browser
 * runs React's resulting render before the next listener: a modal with no
 * exit transition is gone from the DOM by the time a page-level listener
 * asks whether Esc was the modal's. This one listener answers from before:
 * window, capture phase, added when this module loads, so ahead of every
 * listener a component adds.
 */
let atEscape: Element[] = []
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") atEscape = openOverlays()
  }, true)
}

/** The modals, menus and listboxes open as the current Esc went down (see above). */
export function overlaysAtEscape(): readonly Element[] {
  return atEscape
}
