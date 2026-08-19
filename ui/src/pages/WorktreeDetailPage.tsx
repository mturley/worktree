import { Anchor, Grid, Group, Stack, Tabs, Title } from "@mantine/core"
import { Link, useRoute } from "wouter"
import { useWorktreeDetail } from "../hooks/useWorktreeDetail"
import { ResourceList } from "../components/ResourceList"
import { TimelineFeed } from "../components/TimelineFeed"
import { SlackTab } from "../components/SlackTab"

export function WorktreeDetailPage() {
  const [, params] = useRoute("/worktree/:path*")
  const rawPath = params?.["path*"]
  const path = rawPath ? decodeURIComponent(rawPath) : ""
  const { resources, timeline } = useWorktreeDetail(path)
  const branch = path.split("/").pop() || path
  return (
    <Stack p="md" gap="md">
      <Group>
        <Anchor component={Link} href="/">← all worktrees</Anchor>
        <Title order={4}>{branch}</Title>
      </Group>
      <Tabs defaultValue="overview">
        <Tabs.List>
          <Tabs.Tab value="overview">Overview</Tabs.Tab>
          <Tabs.Tab value="slack">Slack</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="overview" pt="md">
          <Grid gutter="md">
            <Grid.Col span={{ base: 12, sm: 4 }}>
              <ResourceList items={resources.data ?? []} />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 8 }}>
              <Stack gap="sm">
                <Title order={5}>Timeline</Title>
                <TimelineFeed events={timeline.data?.events ?? []} loading={timeline.isLoading} error={timeline.error} />
              </Stack>
            </Grid.Col>
          </Grid>
        </Tabs.Panel>
        <Tabs.Panel value="slack" pt="md">
          <SlackTab path={path} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  )
}
