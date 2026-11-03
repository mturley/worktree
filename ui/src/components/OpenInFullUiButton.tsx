import { Button } from "@mantine/core"
import { isMiniRoute, openExternal } from "../lib/miniMode"

/** Takes a modal's details from the mini view to the full UI; nothing elsewhere. */
export function OpenInFullUiButton({ href }: { href: string }) {
  if (!isMiniRoute()) return null
  return (
    <Button size="compact-xs" variant="default" style={{ flex: "none" }} onClick={() => openExternal(href)}>
      Open in full UI ↗
    </Button>
  )
}
