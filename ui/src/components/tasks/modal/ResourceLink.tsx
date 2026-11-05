import { useState } from "react"
import { Anchor, Box, Text, Tooltip } from "@mantine/core"
import { useLocation } from "wouter"
import { useAllResources } from "../../../hooks/useAllResources"
import { worktreeHref } from "../../AllResourceRow"
import { ChooseWorktreeModal } from "../../ChooseWorktreeModal"
import { ResourceHoverCard } from "../LinkHoverCards"

type LinkSize = "xs" | "sm"

// Fits its text, so hovering past the end of a short title previews nothing.
const hoverBox = { minWidth: 0, maxWidth: "100%", width: "fit-content", display: "flex" } as const

/** The page in a new tab; plain text when there is no URL. */
export function ExternalTitle({ title, url, size = "sm" }: { title: string; url?: string; size?: LinkSize }) {
  return url ? (
    <Anchor href={url} target="_blank" rel="noreferrer" size={size} truncate style={{ minWidth: 0 }}>
      {title}
    </Anchor>
  ) : (
    <Text size={size} truncate style={{ minWidth: 0 }}>{title}</Text>
  )
}

/**
 * A resource's title in the task modal, previewing the resource on hover. It
 * opens the resource in the worktree following it, or asks which when several
 * do. A resource no worktree follows has no such page, so it links externally,
 * as it does until the list of followed resources has loaded.
 *
 * The navigation's URL has no ?task=, which closes the modal and leaves it in
 * history: Back returns to it. A modified click is left to the browser, on
 * the first follower's page.
 */
export function ResourceLink({ type, id, title, url, size = "sm" }: {
  type: string
  id: string
  title: string
  url?: string
  size?: LinkSize
}) {
  const all = useAllResources()
  const [, navigate] = useLocation()
  const [choosing, setChoosing] = useState(false)
  const r = all.data?.find((x) => x.type === type && x.id === id)
  const followers = r?.worktrees ?? []

  if (!r || followers.length === 0) {
    return (
      <ResourceHoverCard type={type} id={id}>
        <Box style={hoverBox}><ExternalTitle title={title} url={url} size={size} /></Box>
      </ResourceHoverCard>
    )
  }

  const onClick = (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    if (followers.length > 1) setChoosing(true)
    else navigate(worktreeHref(followers[0], r))
  }

  return (
    <>
      {/* The Box takes the hover card's ref and handlers: a Tooltip would hand them to its label. */}
      <ResourceHoverCard type={type} id={id}>
        <Box style={hoverBox}>
          <Tooltip label="View resource in worktree">
            <Anchor href={worktreeHref(followers[0], r)} onClick={onClick} size={size} truncate style={{ minWidth: 0 }}>
              {title}
            </Anchor>
          </Tooltip>
        </Box>
      </ResourceHoverCard>
      {/*
        Mantine closes every open modal on Escape, from a window listener, so
        the key stops here: it should only dismiss the chooser, not the task
        modal under it. React bubbles it here through the chooser's portal.
      */}
      <div
        style={{ display: "contents" }}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return
          e.stopPropagation()
          setChoosing(false)
        }}
      >
        <ChooseWorktreeModal
          r={choosing ? r : null}
          worktrees={followers}
          onPick={(path) => {
            setChoosing(false)
            navigate(worktreeHref({ path }, r))
          }}
          onClose={() => setChoosing(false)}
        />
      </div>
    </>
  )
}
