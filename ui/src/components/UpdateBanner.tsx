import { useState } from "react"
import { Alert, Anchor, Code, Text } from "@mantine/core"
import { IconDownload } from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { api } from "../api/client"

/**
 * Tells the user the worktree repo's main branch has moved past the commit
 * this server was built from (see internal/webui/update_check.go).
 *
 * The server checks GitHub on its own schedule; this only asks the server,
 * so the interval here just bounds how stale the banner can be.
 *
 * Dismissing hides it until the page reloads, not for good: an update you
 * have not installed is still worth hearing about next time.
 */
export function UpdateBanner() {
  const [dismissed, setDismissed] = useState(false)
  const { data } = useQuery({
    queryKey: ["update-status"],
    queryFn: () => api.updateStatus(),
    refetchInterval: 5 * 60_000,
  })
  if (dismissed || !data?.available) return null
  return (
    <Alert
      mt="sm"
      variant="light"
      color="blue"
      icon={<IconDownload size={18} />}
      withCloseButton
      closeButtonLabel="Dismiss"
      onClose={() => setDismissed(true)}
    >
      <Text size="sm">
        New updates are available. Clone or pull the worktree repo and run <Code>make install</Code>.{" "}
        <Anchor href={data.details_url} target="_blank" rel="noreferrer" size="sm">
          See details on GitHub
        </Anchor>
      </Text>
    </Alert>
  )
}
