import { useState } from "react"
import { Button, Menu, Tooltip } from "@mantine/core"
import { IconChevronDown } from "@tabler/icons-react"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "../api/client"
import { cmuxTreeKey, useResourceCmuxTab } from "../api/cmuxTree"
import type { ResourceDTO } from "../api/types"
import type { ResourceTab } from "../lib/resourceTab"
import { CopyLinkIcon } from "./CopyLinkIcon"

const COPIED_FEEDBACK_MS = 1500

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
 * Given the worktree `path`, a PR or Jira issue already open in a browser tab
 * of one of that worktree's cmux workspaces gets "(existing tab)": the main
 * button switches cmux to that tab, and a dropdown keeps the new-tab link.
 */
export function ResourceActions({ r, path }: { r: ResourceDTO; path?: string }) {
  const [copied, setCopied] = useState(false)
  const existing = useResourceCmuxTab(path, r.type, r.url)
  if (!r.url) return null

  const label = openLabel(r.type)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(r.url)
      setCopied(true)
      setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
    } catch {
      // Clipboard access can be denied; the open button still works, so
      // failing silently is better than an error state on a convenience.
    }
  }

  return (
    <Button.Group className="compound-group" style={{ flexShrink: 0 }}>
      {existing && path ? (
        <ExistingTabButtons r={r} path={path} label={label} existing={existing} />
      ) : (
        <Tooltip label={label}>
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
        </Tooltip>
      )}
      <Tooltip label={copied ? "Copied!" : "Copy link"}>
        <Button
          size="xs"
          variant="light"
          px="xs"
          aria-label="Copy link"
          onClick={(e) => {
            e.stopPropagation()
            void handleCopy()
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
function ExistingTabButtons({ r, path, label, existing }: {
  r: ResourceDTO
  path: string
  label: string
  existing: ResourceTab
}) {
  const qc = useQueryClient()

  async function handleSwitch() {
    let ok = false
    try {
      ok = (await api.cmuxFocusTab(existing.workspace.id, existing.tab.ref)).ok
    } catch {
      // Treated like a refusal below.
    }
    if (ok) return
    // The tab was most likely closed since the last poll. Still get the user
    // to the resource, and re-read the tree so the label stops claiming a tab.
    window.open(r.url, "_blank", "noreferrer")
    void qc.invalidateQueries({ queryKey: cmuxTreeKey(path) })
  }

  return (
    <>
      <Tooltip label={`Switch to the cmux tab already showing this (${existing.workspace.title})`}>
        <Button
          size="xs"
          variant="light"
          onClick={(e) => {
            e.stopPropagation()
            void handleSwitch()
          }}
          styles={{ root: { flexShrink: 0 }, label: { whiteSpace: "nowrap" } }}
        >
          {label} (existing tab)
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
          <Menu.Item component="a" href={r.url} target="_blank" rel="noreferrer">
            {label} (new tab)
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </>
  )
}
