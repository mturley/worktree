import { useState } from "react"
import { Grid, Group, Stack, Title } from "@mantine/core"
import { useWorktrees } from "../hooks/useWorktrees"
import { useGlobalTimeline } from "../hooks/useTimeline"
import { WorktreeList } from "../components/WorktreeList"
import { TimelineFeed } from "../components/TimelineFeed"
import { ArchivedToggle } from "../components/ArchivedToggle"

export function HomePage() {
  const [archived, setArchived] = useState(false)
  const wts = useWorktrees()
  const tl = useGlobalTimeline(archived)
  return (
    <Grid p="md" gutter="md">
      <Grid.Col span={4}>
        <Stack gap="sm">
          <Title order={4}>Worktrees</Title>
          <WorktreeList items={wts.data ?? []} />
        </Stack>
      </Grid.Col>
      <Grid.Col span={8}>
        <Stack gap="sm">
          <Group justify="space-between">
            <Title order={4}>Timeline</Title>
            <ArchivedToggle value={archived} onChange={setArchived} />
          </Group>
          <TimelineFeed events={tl.data?.events ?? []} loading={tl.isLoading} error={tl.error} showWorktrees />
        </Stack>
      </Grid.Col>
    </Grid>
  )
}
