import { useEffect } from "react"
import { Alert, Button, Group, Text } from "@mantine/core"
import { IconAlertTriangle, IconArrowsExchange } from "@tabler/icons-react"
import { useLocation } from "wouter"
import { api } from "../api/client"
import { useFollowCmux } from "../hooks/useFollowCmux"
import { useCmuxTwoWaySync } from "../hooks/useCmuxTwoWaySync"
import { lastCmuxFocus, recordCmuxFocus, useLastCmuxFocus } from "../lib/cmuxFocusBus"
import { worktreeName } from "../lib/homeWorktree"
import { worktreeAt } from "./CmuxFollower"
import { Toggle } from "./Toggle"
import { WorktreeGlyph } from "./WorktreeGlyph"

/**
 * Tells the page (a worktree's, or the home page, where two-way sync keeps
 * following on) that this tab is following cmux, with the way out, and the
 * "Two-way sync" toggle (see CmuxFollower): with it on, opening a worktree
 * here switches cmux too, and the text says so.
 *
 * Shown whenever following is on, even if cmux has since gone away, so it
 * can always be turned off.
 *
 * Yellow while cmux is on a workspace with no worktree, naming it, so the
 * page not moving reads as intended rather than broken. That comes from the
 * last cmux focus message; a page loaded already following has seen none, so
 * it asks cmux once, recording the answer without moving the tab.
 */
export function FollowingCmuxBanner() {
  const [follow, setFollow] = useFollowCmux()
  const [twoWay, setTwoWay] = useCmuxTwoWaySync()
  const [location] = useLocation()
  const focus = useLastCmuxFocus()

  useEffect(() => {
    if (!follow || lastCmuxFocus() !== null) return
    api.cmuxFocused().then(
      // A live message that arrived meanwhile is newer: keep it.
      (msg) => { if (lastCmuxFocus() === null) recordCmuxFocus(msg) },
      () => {},
    )
  }, [follow])

  if (!follow) return null
  const prefix = twoWay ? "Synced with cmux:" : "Following cmux:"
  const noWorktree = focus !== null && focus.workspace_id !== "" && focus.path === ""
  const here = worktreeAt(location)
  return (
    <Alert
      color={noWorktree ? "yellow" : "blue"}
      variant="light"
      p="xs"
      icon={noWorktree ? <IconAlertTriangle size={16} /> : <IconArrowsExchange size={16} />}
      styles={{ wrapper: { alignItems: "center" }, icon: { marginTop: 0 } }}
      data-following-cmux-banner
      data-no-worktree={noWorktree || undefined}
    >
      {/* Wraps on a narrow screen: the controls drop under the text. */}
      <Group justify="space-between" gap="xs" wrap="wrap">
        <Text size="sm" style={{ flex: "1 1 240px" }} data-banner-text>
          {noWorktree ? (
            <>
              {prefix} <WorkspaceName title={focus.title || focus.workspace_id} color={focus.color} /> has no
              worktree, staying {here !== null ? <>on <b><WorktreeGlyph />{worktreeName(here)}</b>.</> : "here."}
            </>
          ) : twoWay
            ? "Synced with cmux: switching workspaces there opens their worktrees here, and opening a worktree here switches cmux to it."
            : "Following cmux: switching workspaces there opens their worktrees here."}
        </Text>
        <Group gap="sm" wrap="nowrap" style={{ flex: "none", marginLeft: "auto" }}>
          <Toggle
            checked={twoWay}
            onChange={(e) => setTwoWay(e.currentTarget.checked)}
            label="Two-way sync"
            tooltip="Opening a worktree here also switches cmux to its workspace"
            style={{ flex: "none" }}
          />
          <Button size="compact-xs" variant="default" style={{ flex: "none" }} onClick={() => setFollow(false)}>
            Stop following
          </Button>
        </Group>
      </Group>
    </Alert>
  )
}

/** The workspace's name, after its cmux colour bar as the worktree page heads it. */
function WorkspaceName({ title, color }: { title: string; color?: string }) {
  return (
    <b style={{ whiteSpace: "nowrap" }}>
      {color && (
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: 3,
            height: "0.9em",
            borderRadius: 2,
            background: color,
            marginRight: "0.35em",
            verticalAlign: "-0.1em",
          }}
        />
      )}
      {title}
    </b>
  )
}
