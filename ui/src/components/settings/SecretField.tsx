import { useEffect, useRef, useState, type ReactNode } from "react"
import { Badge, Button, Group, PasswordInput, Stack, Text, Tooltip } from "@mantine/core"
import type { CredResult } from "../../api/types"

export const VALID_FLASH_MS = 3000

export type TestState = { status: "idle" } | { status: "testing" } | { status: "done"; result: CredResult; at: number }

function TestChip({ test }: { test?: TestState }) {
  if (!test || test.status === "idle") return null
  if (test.status === "testing") return <Badge size="xs" variant="light" color="blue" tt="none">◌ Testing…</Badge>
  const r = test.result
  if (r.ok) return <Badge size="xs" variant="light" color="green" tt="none">✓ Valid</Badge>
  if (r.kind === "auth") return <Badge size="xs" variant="light" color="red" tt="none" title={r.detail}>✕ Rejected</Badge>
  if (r.kind === "missing") return <Badge size="xs" variant="light" color="gray" tt="none">Not configured</Badge>
  if (r.kind === "disabled") return <Badge size="xs" variant="light" color="gray" tt="none" title={r.detail}>Watcher off</Badge>
  if (r.kind === "unsaved") return <Badge size="xs" variant="light" color="yellow" tt="none" title={r.detail}>Save host first</Badge>
  return <Badge size="xs" variant="light" color="yellow" tt="none" title={r.detail}>⚠ Couldn't reach</Badge>
}

/**
 * A write-only secret. The stored value never reaches the browser: the
 * field shows only whether one is set. Focusing it offers Replace, which
 * hands the typed value to onReplace — tested there, where testable, and
 * held as the modal's pending value for Save to write — and clears the
 * input. A pending value swaps Test for Revert.
 */
export function SecretField({ label, description, isSet, pending = false, onRevert, placeholder = "Paste a new token", onReplace, onTest, test, testable, disabled = false }: {
  label: string
  description: ReactNode
  isSet: boolean
  /** A replaced value is waiting for Save. */
  pending?: boolean
  /** Drop the pending value. */
  onRevert?: () => void
  placeholder?: string
  /** Test (if testable) and hold for Save. Resolve with the CredResult; ok:false keeps the field open with the error. */
  onReplace: (value: string) => Promise<CredResult | void>
  /** Absent: no Test button and no chip (the UI password). */
  onTest?: () => void
  test?: TestState
  /** Whether Test can run; defaults to isSet (Slack needs token and cookie). */
  testable?: boolean
  /** A reason the field can't be used now (its watcher is off), or false. */
  disabled?: string | false
}) {
  const canTest = testable ?? isSet
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)

  // A pass from a Test click pops a "✓ Valid" tooltip for a few seconds; the
  // automatic test when the tab opens doesn't. Keyed on the result's
  // timestamp, so each finished test is seen once.
  const clickedTest = useRef(false)
  const doneAt = test?.status === "done" ? test.at : null
  const passed = test?.status === "done" && test.result.ok
  const [flashValid, setFlashValid] = useState(false)
  useEffect(() => {
    if (doneAt === null || !clickedTest.current) return
    clickedTest.current = false
    if (!passed) return
    setFlashValid(true)
    const t = setTimeout(() => setFlashValid(false), VALID_FLASH_MS)
    return () => clearTimeout(t)
  }, [doneAt, passed])

  const cancel = () => {
    inputRef.current?.blur()
    setEditing(false)
    setValue("")
    setError(null)
  }

  const replace = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await onReplace(value)
      if (r && !r.ok) {
        setError(`${r.detail || r.kind}. The new value was not kept.`)
        return
      }
      setValue("")
      inputRef.current?.blur()
      setEditing(false)
    } catch (e) {
      setError(`${e instanceof Error ? e.message : String(e)}. The new value was not kept.`)
    } finally {
      setBusy(false)
    }
  }

  const idlePlaceholder = pending
    ? "•••••••••••••••• new value, unsaved"
    : isSet ? "•••••••••••••••• set" : "Not set — click to add"
  const buttons = editing ? (
    <>
      <Tooltip label={onTest ? "Tests it now; Save writes it" : "Save writes it"}>
        <Button size="sm" disabled={!value} loading={busy} onClick={replace}>Replace</Button>
      </Tooltip>
      <Button size="sm" variant="subtle" onClick={cancel}>Cancel</Button>
    </>
  ) : pending ? (
    onRevert && (
      <Tooltip label="Keep the saved value">
        <Button size="sm" variant="default" miw={88} onClick={onRevert}>Revert</Button>
      </Tooltip>
    )
  ) : (
    onTest && (
      <Tooltip label="✓ Valid" color="green" opened={flashValid} withArrow>
        <Button
          size="sm"
          variant="default"
          miw={88}
          disabled={!!disabled || !canTest || test?.status === "testing"}
          onClick={() => { clickedTest.current = true; setFlashValid(false); onTest() }}
        >
          Test
        </Button>
      </Tooltip>
    )
  )
  return (
    <Stack gap={4}>
      <PasswordInput
        disabled={!!disabled}
        label={<Group gap="xs" component="span">{label}{onTest && <TestChip test={test} />}{pending && !editing && <Badge size="xs" color="orange" variant="light" tt="none">Unsaved</Badge>}</Group>}
        description={description}
        placeholder={editing ? placeholder : idlePlaceholder}
        ref={inputRef}
        value={value}
        data-mantine-stop-propagation={editing ? "true" : undefined}
        visibilityToggleButtonProps={{ style: { display: editing ? undefined : "none" } }}
        onFocus={() => setEditing(true)}
        onChange={(e) => { setEditing(true); setValue(e.currentTarget.value) }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value && !busy) void replace()
          if (e.key === "Escape") { e.stopPropagation(); cancel() }
        }}
        error={error}
        aria-label={label}
        autoComplete="off"
        ff="monospace"
        // The visibility toggle only shows while editing; reserve its room then.
        rightSectionWidth={editing ? undefined : 0}
        // The buttons sit beside the input itself, under the label and
        // description rather than level with them.
        // The input's own description/error margins move to the row, so the
        // buttons centre on the input rather than on input + margin.
        styles={{ wrapper: { marginTop: 0, marginBottom: 0 } }}
        inputContainer={(input) => (
          <Group gap="xs" wrap="nowrap" style={{ marginTop: "var(--input-margin-top)", marginBottom: "var(--input-margin-bottom)" }}>
            <div style={{ flex: 1, minWidth: 0 }}>{input}</div>
            {buttons}
          </Group>
        )}
      />
      {disabled && <Text size="xs" c="dimmed">{disabled}</Text>}
      {!disabled && test?.status === "done" && !test.result.ok && test.result.detail && !editing && (
        <Text size="xs" c="dimmed">{test.result.detail}</Text>
      )}
    </Stack>
  )
}
