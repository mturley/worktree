import { Group, Title } from "@mantine/core"
import { Logo } from "./Logo"
import { UnreadOnlyToggle } from "./UnreadOnlyToggle"
import { FollowCmuxToggle } from "./FollowCmuxToggle"
import { SettingsButton } from "./SettingsButton"
import { useIsWide } from "../hooks/useIsWide"

/**
 * The home page's header: what applies to the whole page — the logo, search,
 * the unread-only and follow-cmux toggles, Settings. Home page only; the
 * worktree page keeps its own header. Narrow, the toggles wrap to a second
 * row so the search keeps its width.
 */
export function HomeHeader({
  search, unreadOnly, onUnreadOnlyChange,
}: { search: React.ReactNode; unreadOnly: boolean; onUnreadOnlyChange: (v: boolean) => void }) {
  const wide = useIsWide()
  const toggles = (
    <Group gap="lg" wrap="nowrap">
      <UnreadOnlyToggle value={unreadOnly} onChange={onUnreadOnlyChange} />
      <FollowCmuxToggle />
    </Group>
  )
  return (
    <Group data-testid="home-header" gap="md" wrap={wide ? "nowrap" : "wrap"} align="center">
      {/* The logo stands in for the old "Worktrees" title, and keeps its name
          as the heading's accessible text. */}
      <Title order={4} style={{ flex: "none" }}><Logo alt="Worktrees" /></Title>
      {search}
      {wide && toggles}
      <Group ml="auto" style={{ flex: "none" }}><SettingsButton /></Group>
      {!wide && <Group w="100%">{toggles}</Group>}
    </Group>
  )
}
