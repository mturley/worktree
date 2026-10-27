const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function parts(local: number, pr: number, unread: number, localWord: string, prWord: string): string {
  const out: string[] = []
  if (local > 0) out.push(plural(local, `pending local ${localWord}`, `pending local ${localWord}s`))
  if (pr > 0) {
    const s = plural(pr, `PR ${prWord}`, `PR ${prWord}s`)
    out.push(unread > 0 ? `${s} (${unread} unread)` : s)
  }
  return out.join(", ")
}

/** The Code tab's "Review changes" button label. */
export function codeTabLabel(local: number, pr: number, unread: number): string {
  const p = parts(local, pr, unread, "comment", "comment")
  return p ? `Review changes (${p})` : "Review changes"
}

/** The diff toolbar's comments button label (without the open-state variant). */
export function toolbarLabel(local: number, pr: number, unread: number): string {
  return parts(local, pr, unread, "review comment", "review comment")
}

/** Whether the counts deserve the unread-blue treatment. */
export function countsAreUnread(local: number, unread: number): boolean {
  return local > 0 || unread > 0
}
