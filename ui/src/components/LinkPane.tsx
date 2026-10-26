import { Alert, Box, Button, Group, Stack, Tabs, Text } from "@mantine/core"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { ResourceDTO } from "../api/types"
import { api } from "../api/client"
import { ResourceCard } from "./ResourceCard"
import { canEmbed } from "../lib/linkEmbed"
import { shortResourceRef } from "../lib/resourceRef"
import { useResourceTab } from "../hooks/useSelectedResource"
import { useTasksPanel } from "./tasks/TasksSection"

export const EMBED_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups"

/** The link pane's tabs, default first (see useResourceTab). */
const LINK_TABS = ["details"] as const

/**
 * The body of a selected link resource: its card, the link's task panel,
 * then the page itself under Details.
 *
 * Where a PR or Jira issue shows a filtered activity feed, a link shows the
 * page — it has no events, is never polled, and has no unread state, so there
 * is nothing for a feed to contain.
 */
export function LinkPane({ resource, path, onRemoved, onResourceChanged }: {
  resource: ResourceDTO
  path: string
  onRemoved?: () => void
  onResourceChanged?: () => void
}) {
  const qc = useQueryClient()
  const refresh = useMutation({
    mutationFn: () => api.resolveResource({ type: resource.type, id: resource.id }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["resources", path] })
      void qc.invalidateQueries({ queryKey: ["worktrees"] })
    },
  })
  const embed = canEmbed(resource.url, resource.embeddable, window.location.origin)
  const [tab, setTab] = useResourceTab(LINK_TABS)
  const { type, id } = resource
  const tasks = useTasksPanel({ kind: "resource", type, id }, { ownResource: { type, id } })

  return (
    <>
      <ResourceCard r={resource} path={path} onRemoved={onRemoved}
        onMetaChanged={onResourceChanged} variant="detail" />
      {/* The task panel sits between the card and the tab bar. */}
      {tasks.panel}
      <Tabs value={tab} onChange={(v) => v && setTab(v)}>
        <Tabs.List>
          <Tabs.Tab value="details">Details</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="details" pt="sm">
          <Stack gap="sm">
            {resource.resolve_error && (
              <Alert color="red" variant="light">
                Couldn't load page details
              </Alert>
            )}
            <Group gap={6} justify="flex-end">
              {/* A link is never polled, so this button is the ONLY way its
                  metadata becomes current again. */}
              <Button size="compact-sm" variant="subtle" loading={refresh.isPending}
                onClick={() => refresh.mutate()}>
                Refresh page details
              </Button>
            </Group>
            {embed ? (
              <Box style={{ flex: 1, minHeight: 480, display: "flex" }}>
                <iframe
                  src={resource.url}
                  title={resource.custom_name || resource.title || resource.url}
                  sandbox={EMBED_SANDBOX}
                  referrerPolicy="no-referrer"
                  style={{ flex: 1, border: "1px solid var(--mantine-color-default-border)",
                           borderRadius: "var(--mantine-radius-sm)", background: "var(--mantine-color-body)" }}
                />
              </Box>
            ) : (
              <Alert color="gray" variant="light" title="Can't embed page">
                <Stack gap="sm" align="flex-start">
                  <Text size="sm">
                    {shortResourceRef("link", resource.id) || "This site"} does not allow its pages to be
                    displayed inside another site.
                  </Text>
                  <Button component="a" href={resource.url} target="_blank" rel="noreferrer" size="xs">
                    Open in new tab
                  </Button>
                </Stack>
              </Alert>
            )}
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </>
  )
}
