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

/** Whether a modal, menu or listbox is open: it owns the keyboard, not the page. */
export function overlayOpen(): boolean {
  const open = document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"]')
  for (const el of open) if (!isHidden(el)) return true
  return false
}
