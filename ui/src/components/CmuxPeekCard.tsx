import { Box, Image, Loader, Stack, Text } from "@mantine/core"
import { useLayoutEffect, useRef } from "react"
import { useCmuxPeek } from "../api/cmuxPeek"
import type { CmuxTab } from "../api/types"
import { NotesMarkdown } from "./NotesMarkdown"

/**
 * One cmux tab's hover card: what the old tooltip said (title, URL), then
 * the tab's content. Mounted only while the card is open, so mounting is
 * what starts the fetch (see useCmuxPeek).
 */
export function CmuxPeekCard({ workspaceId, tab }: { workspaceId: string; tab: CmuxTab }) {
  const { data, error } = useCmuxPeek(workspaceId, tab)
  return (
    <Stack gap={6}>
      <Box>
        <Text size="xs" fw={600}>{tab.title}</Text>
        {tab.url && <Text size="xs" c="dimmed" style={{ wordBreak: "break-all" }}>{tab.url}</Text>}
        {data?.path && <Text size="xs" c="dimmed" style={{ wordBreak: "break-all" }}>{data.path}</Text>}
      </Box>
      {error ? (
        <Text size="xs" c="red">{error.message}</Text>
      ) : !data ? (
        <Loader size="xs" />
      ) : data.type === "terminal" && !data.unsupported ? (
        // The server omits an empty screen's text (omitempty): still a terminal.
        <TerminalPeek text={data.text ?? ""} />
      ) : data.image ? (
        <Image src={data.image} alt={tab.title} radius="sm" />
      ) : data.markdown !== undefined && !data.unsupported ? (
        <Box className="cmux-peek-markdown">
          <NotesMarkdown text={data.markdown} />
        </Box>
      ) : (
        <Text size="xs" c="dimmed" fs="italic">No preview for this tab</Text>
      )}
    </Stack>
  )
}

/** Pinned to the bottom on every capture, like a terminal. */
function TerminalPeek({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null)
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [text])
  return (
    <pre ref={ref} className="cmux-peek-terminal" data-testid="cmux-peek-terminal">
      {text || " "}
    </pre>
  )
}
