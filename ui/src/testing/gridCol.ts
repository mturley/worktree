// Mantine writes a Grid.Col's span into a generated <style> rule keyed by a
// per-instance class, not into the element's inline style, so jsdom only
// sees it there. Returns that rule's --col-flex-basis.
export function colBasis(col: HTMLElement): string | undefined {
  const cls = [...col.classList].find((c) => c.startsWith("__m__-"))
  if (!cls) return undefined
  for (const style of document.querySelectorAll("style")) {
    const text = style.textContent ?? ""
    if (!text.includes(`.${cls}`)) continue
    const m = text.match(/--col-flex-basis:\s*([^;]+);/)
    if (m) return m[1].trim()
  }
  return undefined
}
