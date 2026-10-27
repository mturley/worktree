import { useState } from "react"
import { Alert, Badge, Button, Checkbox, Group, Loader, Modal, Radio, Stack, Text, Textarea, Tooltip } from "@mantine/core"
import { notifications } from "@mantine/notifications"
import { useQuery } from "@tanstack/react-query"
import { api } from "../../api/client"
import type { PRLocalComment, PRPendingComment, PRReviewDialog, PRReviewEvent } from "../../api/types"
import { prWriteError, usePRWriteMutations } from "../../hooks/usePRWrite"
import { stalePendingNotice, UNPOSTABLE_REASON } from "./prWriteCopy"
import { Body, Frame } from "./ReviewCommentCard"

/** The review events, with GitHub's wording. */
const EVENTS: { value: PRReviewEvent; label: string; description: string }[] = [
  { value: "COMMENT", label: "Comment", description: "Submit general feedback without explicit approval." },
  { value: "APPROVE", label: "Approve", description: "Give your approval to merge these changes." },
  {
    value: "REQUEST_CHANGES",
    label: "Request changes",
    description: "Submit feedback that must be addressed before merging.",
  },
]

const OWN_PR_REASON = "You can't approve or request changes on your own PR"

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

const localPlace = (c: PRLocalComment) =>
  `${c.file}:${c.start_line === c.end_line ? c.start_line : `${c.start_line}-${c.end_line}`}`
// A pending comment's line is 0 when its thread isn't among the PR's threads.
const pendingPlace = (c: PRPendingComment) => (c.line > 0 ? `${c.file}:${c.line}` : c.file)

export const submittedToast = (n: number | undefined) =>
  n === undefined ? "Review submitted" : `Review submitted to PR #${n}`

/**
 * Submits Mike's PR review: a message, an event, his pending GitHub comments
 * and, if he includes them, his postable local comments. The whole modal
 * scrolls as one; nothing inside it scrolls on its own.
 */
export function SubmitReviewModal({ path, opened, onClose }: {
  path: string
  opened: boolean
  onClose: () => void
}) {
  const dialog = useQuery<PRReviewDialog>({
    queryKey: ["pr-review-dialog", path],
    queryFn: () => api.prReviewDialog(path),
    enabled: opened,
    staleTime: 0,
  })
  const { submit } = usePRWriteMutations(path)
  const [message, setMessage] = useState("")
  const [event, setEvent] = useState<PRReviewEvent>("COMMENT")
  // Undefined until the box is touched: then it follows the data's default.
  const [includeChoice, setIncludeChoice] = useState<boolean | undefined>(undefined)

  const submitting = submit.isPending
  // A failed attempt's error doesn't greet the next opening. Never while a
  // submit is in flight: reset() would detach its success handling.
  const close = () => {
    if (submitting) return
    submit.reset()
    onClose()
  }
  // An edit makes the last attempt's error stale.
  const edited = () => {
    if (!submitting) submit.reset()
  }
  const finish = () => {
    setMessage("")
    setEvent("COMMENT")
    setIncludeChoice(undefined)
    close()
  }

  const d = dialog.data
  const prNumber = d?.pr?.number
  const prTitle = d?.pr?.title
  const title = (
    <Group component="span" gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
      <span style={{ flex: "none" }}>
        {prNumber === undefined ? "Submit review" : `Submit review to PR #${prNumber}`}
      </span>
      {prTitle && (
        <Text component="span" c="dimmed" truncate="end" title={prTitle} style={{ minWidth: 0 }}>
          {prTitle}
        </Text>
      )}
    </Group>
  )

  return (
    <Modal
      opened={opened}
      onClose={close}
      title={title}
      size="lg"
      centered
      // No way out while a submit is in flight: its result must land.
      closeOnEscape={!submitting}
      closeOnClickOutside={!submitting}
      closeButtonProps={{ disabled: submitting, "aria-label": "Close" }}
      styles={{ title: { minWidth: 0 } }}
    >
      {dialog.isPending ? (
        <Group justify="center" p="md"><Loader size="sm" /></Group>
      ) : dialog.isError ? (
        <Stack gap="sm">
          <Text size="sm" c="red">{prWriteError(dialog.error)}</Text>
          <Group justify="flex-end"><Button variant="default" onClick={close}>Cancel</Button></Group>
        </Stack>
      ) : (
        <DialogBody
          d={dialog.data}
          prNumber={prNumber}
          message={message}
          setMessage={(m) => {
            edited()
            setMessage(m)
          }}
          event={event}
          setEvent={(e) => {
            edited()
            setEvent(e)
          }}
          includeChoice={includeChoice}
          setIncludeChoice={(b) => {
            edited()
            setIncludeChoice(b)
          }}
          error={submit.isError ? prWriteError(submit.error) : undefined}
          submitting={submitting}
          onCancel={close}
          onSubmit={(include) =>
            submit.mutate(
              { head: dialog.data.head, event, body: message, include_local: include },
              {
                onSuccess: (res) => {
                  if (res.error) {
                    // Some of it may have gone: show what is now pending.
                    void dialog.refetch()
                    return
                  }
                  notifications.show({ color: "green", message: submittedToast(prNumber) })
                  finish()
                },
                // A moved head, or a partial failure: show the review as it now is.
                onError: () => void dialog.refetch(),
              },
            )
          }
          resultError={submit.data?.error}
        />
      )}
    </Modal>
  )
}

function DialogBody({
  d,
  prNumber,
  message,
  setMessage,
  event,
  setEvent,
  includeChoice,
  setIncludeChoice,
  error,
  resultError,
  submitting,
  onCancel,
  onSubmit,
}: {
  d: PRReviewDialog
  prNumber: number | undefined
  message: string
  setMessage: (s: string) => void
  event: PRReviewEvent
  setEvent: (e: PRReviewEvent) => void
  includeChoice: boolean | undefined
  setIncludeChoice: (b: boolean) => void
  error: string | undefined
  resultError: string | undefined
  submitting: boolean
  onCancel: () => void
  onSubmit: (include: boolean) => void
}) {
  const pending = d.pending?.comments ?? []
  const postable = d.local.filter((c) => c.postable)
  const unpostable = d.local.filter((c) => !c.postable)
  const include = d.local.length > 0 && (includeChoice ?? postable.length > 0)
  const included = include ? postable : []
  const total = pending.length + included.length

  // GitHub refuses a Comment review with no message and no comments.
  const emptyReason =
    event === "COMMENT" && message.trim() === "" && total === 0
      ? "Write a message or add comments to submit a Comment review"
      : undefined
  const blockedReason = include && d.blocked_reason ? d.blocked_reason : undefined
  const disabledReason = blockedReason ?? emptyReason

  return (
    <Stack gap="md">
      <Textarea
        label="Review message"
        description="Markdown"
        autosize
        minRows={4}
        value={message}
        onChange={(e) => setMessage(e.currentTarget.value)}
        data-autofocus
      />

      <Radio.Group value={event} onChange={(v) => setEvent(v as PRReviewEvent)}>
        <Stack gap="xs">
          {EVENTS.map((e) => {
            const disabled = d.viewer_is_author && e.value !== "COMMENT"
            return (
              <Tooltip key={e.value} label={OWN_PR_REASON} disabled={!disabled} position="top-start">
                <div>
                  <Radio value={e.value} label={e.label} description={e.description} disabled={disabled} />
                </div>
              </Tooltip>
            )
          })}
        </Stack>
      </Radio.Group>

      {d.local.length > 0 && (
        <Checkbox
          label={`Include my ${plural(d.local.length, "local comment", "local comments")}`}
          checked={include}
          onChange={(e) => setIncludeChoice(e.currentTarget.checked)}
        />
      )}

      <Stack gap="xs">
        <Text size="sm" fw={600}>{`In this review (${total})`}</Text>
        {pending.map((c) => (
          <PreviewCard key={`p-${c.id}`} source="pr" label="Pending on GitHub" place={pendingPlace(c)} body={c.body} />
        ))}
        {included.map((c) => (
          <PreviewCard key={`l-${c.id}`} source="draft" label="Local" place={localPlace(c)} body={c.body} />
        ))}
      </Stack>

      {d.pending && prNumber !== undefined && (
        <Text size="sm">
          {`Your pending review on PR #${prNumber} (${plural(pending.length, "comment", "comments")}) will be submitted.`}
        </Text>
      )}
      {d.stale_pending_commit && prNumber !== undefined && (
        <Alert color="yellow" variant="light" p="xs">
          <Text size="sm">{stalePendingNotice(prNumber, d.stale_pending_commit)}</Text>
        </Alert>
      )}

      {include && unpostable.length > 0 && (
        <Alert
          color="yellow"
          variant="light"
          p="xs"
          title={`${unpostable.length} of ${d.local.length} local comments can't be posted and will stay here`}
        >
          <Stack gap={2}>
            {unpostable.map((c) => (
              <Text key={c.id} size="xs" style={{ overflowWrap: "anywhere" }}>
                {`${localPlace(c)} — ${c.reason || UNPOSTABLE_REASON}`}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}

      {blockedReason && <Text size="sm" c="red">{blockedReason}</Text>}
      {(error ?? resultError) && <Text size="sm" c="red">{error ?? resultError}</Text>}

      <Group justify="flex-end" gap="xs">
        <Button variant="default" disabled={submitting} onClick={onCancel}>Cancel</Button>
        <Tooltip label={disabledReason} disabled={!disabledReason}>
          <span>
            <Button disabled={!!disabledReason} loading={submitting} onClick={() => onSubmit(include)}>
              {total > 0 ? `Submit review (${total})` : "Submit review"}
            </Button>
          </span>
        </Tooltip>
      </Group>
    </Stack>
  )
}

function PreviewCard({ source, label, place, body }: {
  source: "pr" | "draft"
  label: string
  place: string
  body: string
}) {
  return (
    <Frame source={source}>
      <Stack gap={4}>
        <Group gap={6} wrap="wrap">
          <Badge size="xs" variant="light" color={source === "pr" ? "grape" : "blue"}>
            {label}
          </Badge>
          <Text size="xs" ff="monospace" fw={600} style={{ overflowWrap: "anywhere" }}>{place}</Text>
        </Group>
        {/* Pending comments came from GitHub: images as links, as on PR threads. */}
        <Body text={body} imagesAsLinks={source === "pr"} />
      </Stack>
    </Frame>
  )
}
