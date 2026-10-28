import { useCallback, useMemo, useSyncExternalStore } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, HttpError } from "../api/client"
import type { NewReviewComment, ReviewComment, ReviewCommentItem } from "../api/types"

const POLL_MS = 5000

/**
 * The path's review comments, positioned for the view (when one is given).
 * `pollMs` slows this observer's poll (default 5s).
 */
export function useReviewComments(
  path: string,
  view: { oldRev: string; newRev: string } | undefined,
  opts: { pollMs?: number } = {},
) {
  return useQuery<ReviewCommentItem[]>({
    queryKey: ["review-comments", path, view?.oldRev, view?.newRev],
    queryFn: async () => (await api.reviewComments(path, view)).comments,
    refetchInterval: opts.pollMs ?? POLL_MS,
    // Keep the list through a view change, but never show another worktree's.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === path ? prev : undefined),
  })
}

export function useReviewCommentMutations(path: string) {
  const qc = useQueryClient()
  const onSettled = () => qc.invalidateQueries({ queryKey: ["review-comments", path] })
  return {
    create: useMutation({
      mutationFn: (req: Omit<NewReviewComment, "path">) => api.createReviewComment({ ...req, path }),
      onSettled,
    }),
    update: useMutation({
      mutationFn: (req: { id: number; version: number; body: string }) =>
        api.updateReviewComment({ path, ...req }),
      onSettled,
    }),
    remove: useMutation({ mutationFn: (id: number) => api.deleteReviewComment(path, id), onSettled }),
    clear: useMutation({ mutationFn: () => api.clearReviewComments(path), onSettled }),
  }
}

/** The current comment a 409 (edited elsewhere) carries, if err is one. */
export function conflictComment(err: unknown): ReviewComment | undefined {
  if (!(err instanceof HttpError) || err.status !== 409) return undefined
  const c = (err.body as { comment?: unknown } | null | undefined)?.comment as Partial<ReviewComment> | undefined
  if (!c || typeof c !== "object") return undefined
  if (typeof c.id !== "number" || typeof c.version !== "number" || typeof c.body !== "string") return undefined
  return c as ReviewComment
}

/** A comment whose save found it deleted elsewhere, and the text that was being typed. */
export interface DeletedDraft {
  comment: ReviewCommentItem
  text: string
  /**
   * The view (`old_rev..new_rev`) whose position `comment.view` holds, when
   * known; only that view shows the tombstone inline, the sidebar always.
   */
  view?: string
}

// In-memory only, per worktree path. The list no longer holds a deleted
// comment, so its card unmounts; this keeps the typed text until dismissed.
const NONE: DeletedDraft[] = []
let deletedDrafts = new Map<string, DeletedDraft[]>()
const deletedListeners = new Set<() => void>()

function setDeleted(path: string, next: DeletedDraft[]): void {
  deletedDrafts = new Map(deletedDrafts)
  if (next.length) deletedDrafts.set(path, next)
  else deletedDrafts.delete(path)
  deletedListeners.forEach((l) => l())
}

function subscribeDeleted(onChange: () => void): () => void {
  deletedListeners.add(onChange)
  return () => { deletedListeners.delete(onChange) }
}

export function useDeletedDrafts(path: string) {
  const drafts = useSyncExternalStore(subscribeDeleted, () => deletedDrafts.get(path) ?? NONE)
  const add = useCallback(
    (d: DeletedDraft) =>
      setDeleted(path, [...(deletedDrafts.get(path) ?? NONE).filter((x) => x.comment.id !== d.comment.id), d]),
    [path],
  )
  const dismiss = useCallback(
    (id: number) => setDeleted(path, (deletedDrafts.get(path) ?? NONE).filter((x) => x.comment.id !== id)),
    [path],
  )
  return { drafts, add, dismiss }
}

/**
 * An open comment editor's state. pierre keys annotation slots by index, so
 * an inline card remounts whenever an earlier annotation in its file comes or
 * goes; kept here, the editor survives that with its text.
 */
export interface EditorDraft {
  text: string
  /** An edit's: the version it started from, which its save names. */
  baseVersion?: number
  /** An edit's: the newer comment a save found, whose version the next save names. */
  conflict?: ReviewComment
  /** A new comment's: which target (see newDraftTarget) the text was typed for. */
  target?: string
  /**
   * The save in flight, by its button's key, and the last one's error: here,
   * not in the card, so a card that remounts mid-save stays busy (and can't
   * send it twice) and still shows how it ended.
   */
  saving?: string
  error?: string
}

/** The store key of an edit, per card variant: inline and sidebar cards edit independently. */
export const editDraftKey = (variant: "inline" | "sidebar", id: number) => `edit:${variant}:${id}`
/** The store key of the new comment; only one is ever being written. */
export const NEW_DRAFT_KEY = "new"
/** Names a new comment's target within its view. */
export const newDraftTarget = (
  view: { oldRev: string; newRev: string },
  t: { file: string; side: string; start: number; end: number },
) => `${view.oldRev}..${view.newRev}:${t.file}:${t.side}:${t.start}-${t.end}`

export type DraftUpdate = EditorDraft | undefined | ((d: EditorDraft | undefined) => EditorDraft | undefined)

// In-memory only, per worktree path, then per key.
const NO_EDITOR_DRAFTS: ReadonlyMap<string, EditorDraft> = new Map()
let editorDrafts = new Map<string, ReadonlyMap<string, EditorDraft>>()
const editorListeners = new Set<() => void>()

function setEditorDraft(path: string, key: string, update: DraftUpdate): void {
  const cur = editorDrafts.get(path) ?? NO_EDITOR_DRAFTS
  const next = typeof update === "function" ? update(cur.get(key)) : update
  if (next === cur.get(key)) return
  const forPath = new Map(cur)
  if (next) forPath.set(key, next)
  else forPath.delete(key)
  editorDrafts = new Map(editorDrafts)
  if (forPath.size) editorDrafts.set(path, forPath)
  else editorDrafts.delete(path)
  editorListeners.forEach((l) => l())
}

function subscribeEditors(onChange: () => void): () => void {
  editorListeners.add(onChange)
  return () => { editorListeners.delete(onChange) }
}

/**
 * Drops the new comment's draft once its editor is gone for good (a view
 * change), so it can't come back on the same lines. One still saving stays:
 * its save clears it.
 */
export function dropAbandonedNewDraft(path: string): void {
  setEditorDraft(path, NEW_DRAFT_KEY, (d) => (d?.saving ? d : undefined))
}

/** One editor's draft, and its setter (undefined clears it). */
export function useEditorDraft(path: string, key: string) {
  const draft = useSyncExternalStore(subscribeEditors, () => editorDrafts.get(path)?.get(key))
  const set = useCallback((update: DraftUpdate) => setEditorDraft(path, key, update), [path, key])
  return [draft, set] as const
}

/** The ids of the comments being edited in path, in the given card variants. */
export function useEditingCommentIds(path: string, variants: readonly ("inline" | "sidebar")[]): number[] {
  const prefixes = variants.map((v) => `edit:${v}:`)
  // A string, so typing (which replaces the drafts) re-renders nothing here.
  const ids = useSyncExternalStore(subscribeEditors, () =>
    [...(editorDrafts.get(path) ?? NO_EDITOR_DRAFTS).keys()]
      .filter((k) => prefixes.some((p) => k.startsWith(p)))
      .map((k) => k.slice(k.lastIndexOf(":") + 1))
      .join(","),
  )
  return useMemo(() => (ids ? ids.split(",").map(Number) : []), [ids])
}
