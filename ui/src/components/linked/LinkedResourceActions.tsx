import { Button, Tooltip } from "@mantine/core"
import { useResourceCmuxTab } from "../../api/cmux"
import type { LinkedItem } from "../../api/types"
import { CopyLinkIcon } from "../CopyLinkIcon"
import { ExistingTabButtons } from "../ResourceActions"
import { useCopyLink } from "../resourceActionHooks"
import { useLinkedActions } from "./LinkedActionsContext"

const btn = { root: { flexShrink: 0 }, label: { whiteSpace: "nowrap" as const } }

/**
 * Follow / Open / Copy link for one linked resource. Follow becomes
 * "Details" (selects it in this worktree) when this worktree already
 * follows it; Open becomes "Open (switch)" when cmux already has it open
 * (PRs and Jira only — the only types cmux tab matching knows). Those two are tinted,
 * the rest secondary, so activating something that already exists is the
 * primary action.
 */
export function LinkedResourceActions({ item, path, hideFollow }: { item: LinkedItem; path?: string; hideFollow?: boolean }) {
  const actions = useLinkedActions()
  const existing = useResourceCmuxTab(path, item.type, item.url)
  const { copied, copy } = useCopyLink(item.url)
  const tracked = actions.trackedResource?.(item.type, item.id) ?? null
  const openLabel = item.type === "slack" ? "Open in Slack" : "Open"

  return (
    <Button.Group className="compound-group" style={{ flexShrink: 0 }}>
      {!hideFollow && tracked && actions.selectResource && (
        <Button size="xs" variant="light" styles={btn} onClick={() => actions.selectResource!(tracked)}>
          Details
        </Button>
      )}
      {!hideFollow && !tracked && actions.requestFollow && (
        <Button size="xs" variant="subtle" styles={btn} onClick={() => actions.requestFollow!(item.url)}>
          Follow
        </Button>
      )}
      {existing ? (
        <ExistingTabButtons url={item.url} label={openLabel} switchLabel="Open (switch)" existing={existing} />
      ) : (
        <Button size="xs" variant="subtle" component="a" href={item.url} target="_blank" rel="noreferrer" styles={btn}>
          {openLabel}
        </Button>
      )}
      <Tooltip label={copied ? "Copied!" : "Copy link"}>
        <Button size="xs" variant="subtle" px="xs" aria-label="Copy link" onClick={() => void copy()} styles={{ root: { flexShrink: 0 } }}>
          <CopyLinkIcon />
        </Button>
      </Tooltip>
    </Button.Group>
  )
}
