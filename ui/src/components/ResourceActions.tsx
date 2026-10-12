import { Button, Menu, Tooltip } from "@mantine/core"
import { IconChevronDown } from "@tabler/icons-react"
import { useResourceCmuxTab } from "../api/cmux"
import type { CmuxBrowserTab, ResourceDTO } from "../api/types"
import { CopyLinkIcon } from "./CopyLinkIcon"
import { useCopyLink, useSwitchToTab } from "./resourceActionHooks"
import { PaneMiniMap } from "./PaneMiniMap"

/**
 * The service a resource lives on, for user-facing copy. Shared so every
 * label naming a destination ("Open on GitHub", "More activity on GitHub")
 * uses the same word for the same service.
 */
export function serviceName(type: string): string {
  switch (type) {
    case "pr":
      return "GitHub"
    case "jira":
      return "Jira"
    case "slack":
      return "Slack"
    default:
      return ""
  }
}

/**
 * Names the destination for a resource type. The preposition varies on
 * purpose: you open a page *on* a site, but a conversation *in* an app.
 */
export function openLabel(type: string): string {
  // A link goes to an arbitrary page, so there is no service to name — and
  // "Open" alone did not say that it leaves the app.
  if (type === "link") return "Open in new tab"
  const name = serviceName(type)
  if (!name) return "Open"
  return type === "slack" ? `Open in ${name}` : `Open on ${name}`
}

/**
 * "Open in <service>" paired with a copy-link button, mirroring the compound
 * control in the Slack thread's ActionBar so the two read the same.
 *
 * Lives on the detail card rather than the list cards: a list card is a
 * single click target for selection, and an inner link there is easy to hit
 * by accident when you meant to select.
 *
 * A PR or Jira issue already open in a cmux browser tab — in any workspace,
 * preferring the one(s) matching the worktree `path` — gets "Switch to open
 * <service> tab" instead, which switches cmux to that tab; a dropdown keeps
 * the new-tab link. Its tooltip sketches the target workspace's splits with
 * the tab's pane highlighted.
 */
export function ResourceActions({ r, path }: { r: ResourceDTO; path?: string }) {
  const { copied, copy } = useCopyLink(r.url)
  const existing = useResourceCmuxTab(path, r.type, r.url)
  if (!r.url) return null

  const label = openLabel(r.type)

  return (
    <Button.Group className="compound-group" style={{ flexShrink: 0 }}>
      {existing ? (
        <ExistingTabButtons url={r.url} label={label} switchLabel={`Switch to open ${serviceName(r.type)} tab`} existing={existing} />
      ) : (
        <Button
          size="xs"
          variant="light"
          component="a"
          href={r.url}
          target="_blank"
          rel="noreferrer"
          // The detail card is not itself a click target, but keep this from
          // bubbling in case the card is ever made selectable.
          onClick={(e) => e.stopPropagation()}
          styles={{ root: { flexShrink: 0 }, label: { whiteSpace: "nowrap" } }}
        >
          {label}
        </Button>
      )}
      <Tooltip label={copied ? "Copied!" : "Copy link"}>
        <Button
          size="xs"
          variant="light"
          px="xs"
          aria-label="Copy link"
          onClick={(e) => {
            e.stopPropagation()
            void copy()
          }}
          styles={{ root: { flexShrink: 0 } }}
        >
          <CopyLinkIcon />
        </Button>
      </Tooltip>
    </Button.Group>
  )
}

/**
 * The open segment when cmux already has the resource in a tab: switch to it,
 * or (from the chevron's menu) open another. Both are direct children of the
 * Button.Group — Menu.Target renders no wrapper and the dropdown is portalled
 * — so the compound-group dividers still apply.
 */
export function ExistingTabButtons({ url, label, switchLabel, existing }: {
  url: string
  label: string
  switchLabel: string
  existing: CmuxBrowserTab
}) {
  const handleSwitch = useSwitchToTab(url, existing)

  return (
    <>
      <Tooltip
        label={
          <>
            <div>Switch to the cmux tab already showing this</div>
            <div>(in workspace: {existing.workspaceTitle})</div>
            {existing.layout && (
              <div style={{ marginTop: 6 }}>
                <PaneMiniMap layout={existing.layout} highlight={existing.pane} />
              </div>
            )}
          </>
        }
      >
        <Button
          size="xs"
          variant="light"
          onClick={(e) => {
            e.stopPropagation()
            void handleSwitch()
          }}
          styles={{ root: { flexShrink: 0 }, label: { whiteSpace: "nowrap" } }}
        >
          {switchLabel}
        </Button>
      </Tooltip>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <Button
            size="xs"
            variant="light"
            px={6}
            aria-label="More open options"
            onClick={(e) => e.stopPropagation()}
            styles={{ root: { flexShrink: 0 } }}
          >
            <IconChevronDown size={14} />
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item component="a" href={url} target="_blank" rel="noreferrer">
            {label} (new tab)
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </>
  )
}
