/**
 * The blue dot that marks something unread.
 *
 * Purely presentational, and deliberately the only place its dimensions and
 * colour are written down: the resource dot (UnreadDot in ResourceStatusIcon)
 * and the per-event dot (EventRow) are the same visual signal, and two copies
 * of the same 7px circle drift apart the first time either is tweaked.
 *
 * The aria-label is the caller's, not this component's — the two callers label
 * different subjects ("unread" for a resource, "unread event" for one event)
 * and tests assert on those exact strings.
 */
export function UnreadMarkerDot({ label }: { label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: "var(--mantine-color-blue-5)",
        flexShrink: 0,
      }}
    />
  )
}
