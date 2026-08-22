import { useState } from "react"
import { Grid, Group, Stack, Tabs, Title } from "@mantine/core"
import { useWorktrees } from "../hooks/useWorktrees"
import { useGlobalTimeline } from "../hooks/useTimeline"
import { useIsWide } from "../hooks/useIsWide"
import { WorktreeList } from "../components/WorktreeList"
import { TimelineFeed } from "../components/TimelineFeed"
import { ArchivedToggle } from "../components/ArchivedToggle"

export function HomePage() {
  const [archived, setArchived] = useState(false)
  const wide = useIsWide()
  const wts = useWorktrees()
  const tl = useGlobalTimeline(archived)

  const worktrees = <WorktreeList items={wts.data ?? []} />
  const timeline = (
    <Stack gap="sm">
      <Group justify="space-between">
        <Title order={4}>Timeline</Title>
        <ArchivedToggle value={archived} onChange={setArchived} />
      </Group>
      <TimelineFeed events={tl.data?.events ?? []} loading={tl.isLoading} error={tl.error} showWorktrees />
    </Stack>
  )

  // Narrow: the two panes would otherwise stack, pushing the worktree list
  // far off-screen, so offer them as tabs instead.
  if (!wide) {
    return (
      <Stack p="md" gap="sm">
        <Tabs defaultValue="worktrees">
          <Tabs.List>
            <Tabs.Tab value="worktrees">Worktrees</Tabs.Tab>
            <Tabs.Tab value="timeline">Timeline</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="worktrees" pt="md">{worktrees}</Tabs.Panel>
          <Tabs.Panel value="timeline" pt="md">{timeline}</Tabs.Panel>
        </Tabs>
      </Stack>
    )
  }

  return (
    <Grid p="md" gutter="md">
      <Grid.Col span={4}>
        <Stack gap="sm">
          <Title order={4}>Worktrees</Title>
          {worktrees}
        </Stack>
      </Grid.Col>
      <Grid.Col span={8}>{timeline}</Grid.Col>
    </Grid>
  )
}
