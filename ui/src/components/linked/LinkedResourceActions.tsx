import { Button, Tooltip } from "@mantine/core"
import { useResourceCmuxTab } from "../../api/cmux"
import type { LinkedItem } from "../../api/types"
import { CopyLinkIcon } from "../CopyLinkIcon"
import { ExistingTabButtons, openLabel as openTooltip, serviceName } from "../ResourceActions"
import { useCopyLink } from "../resourceActionHooks"
import { useLinkedActions } from "./LinkedActionsContext"

const btn = { root: { flexShrink: 0 }, label: { whiteSpace: "nowrap" as const } }

/**
 * Follow / open / Copy link for one linked resource. Follow becomes
 * "Details" (selects it in this worktree) when this worktree already
 * follows it. The open button is named for its platform (GitHub, Jira,
 * Slack; "Open" for a plain link) and gains " (switch)" when cmux already
 * has it open (PRs and Jira only — the only types cmux tab matching knows). Those two are tinted,
 * the rest secondary, so activating something that already exists is the
 * primary action.
 */
export function LinkedResourceActions({ item, path, hideFollow }: { item: LinkedItem; path?: string; hideFollow?: boolean }) {
  const actions = useLinkedActions()
  const existing = useResourceCmuxTab(path, item.type, item.url)
  const { copied, copy } = useCopyLink(item.url)
  const tracked = actions.trackedResource?.(item.type, item.id) ?? null
  // Named for where it opens; a plain link has no platform to name.
  const openLabel = serviceName(item.type) || "Open"

  return (
    <Button.Group className="compound-group" style={{ flexShrink: 0 }}>
      {!hideFollow && tracked && actions.selectResource && (
        <Tooltip label="View in this worktree">
          <Button size="xs" variant="light" styles={btn} onClick={() => actions.selectResource!(tracked)}>
            Details
          </Button>
        </Tooltip>
      )}
      {!hideFollow && !tracked && actions.requestFollow && (
        <Tooltip label="Follow in this worktree">
          <Button size="xs" variant="subtle" styles={btn} onClick={() => actions.requestFollow!(item.url)}>
            Follow
          </Button>
        </Tooltip>
      )}
      {existing ? (
        <ExistingTabButtons url={item.url} label={openLabel} switchLabel={`${openLabel} (switch)`} existing={existing} />
      ) : (
        // The button names only the platform; the tooltip says what it does
        // ("Open on Jira", "Open in Slack", "Open in new tab").
        <Tooltip label={openTooltip(item.type)}>
          <Button size="xs" variant="subtle" component="a" href={item.url} target="_blank" rel="noreferrer" styles={btn}>
            {openLabel}
          </Button>
        </Tooltip>
      )}
      <Tooltip label={copied ? "Copied!" : "Copy link"}>
        <Button size="xs" variant="subtle" px="xs" aria-label="Copy link" onClick={() => void copy()} styles={{ root: { flexShrink: 0 } }}>
          <CopyLinkIcon />
        </Button>
      </Tooltip>
    </Button.Group>
  )
}
