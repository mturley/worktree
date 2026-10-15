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
  if (r.kind === "unsaved") return <Badge size="xs" variant="light" color="yellow" tt="none" title={r.detail}>Save host first</Badge>
  return <Badge size="xs" variant="light" color="yellow" tt="none" title={r.detail}>⚠ Couldn't reach</Badge>
}

/**
 * A write-only secret. The stored value never reaches the browser: the
 * field shows only whether one is set. Focusing it offers Replace, which
 * hands the typed value to onReplace (validate-then-write on the server)
 * and forgets it on success. Never part of the modal's Save/Discard draft.
 */
export function SecretField({ label, description, isSet, placeholder = "Paste a new token", onReplace, onTest, test, testable }: {
  label: string
  description: ReactNode
  isSet: boolean
  placeholder?: string
  /** Validate-then-write. Resolve with the CredResult; ok:false keeps the field open with the error. */
  onReplace: (value: string) => Promise<CredResult | void>
  /** Absent: no Test button and no chip (the UI password). */
  onTest?: () => void
  test?: TestState
  /** Whether Test can run; defaults to isSet (Slack needs token and cookie). */
  testable?: boolean
}) {
  const canTest = testable ?? isSet
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)

  // A passing test shows "✓ Valid" on the button for a few seconds. Keyed on
  // the result's timestamp, so each new pass restarts the flash.
  const validAt = test?.status === "done" && test.result.ok ? test.at : null
  const [flashValid, setFlashValid] = useState(false)
  useEffect(() => {
    if (validAt === null) { setFlashValid(false); return }
    setFlashValid(true)
    const t = setTimeout(() => setFlashValid(false), VALID_FLASH_MS)
    return () => clearTimeout(t)
  }, [validAt])

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
        setError(`${r.detail || r.kind}. Nothing was saved, and the old value is still in place.`)
        return
      }
      setValue("")
      inputRef.current?.blur()
      setEditing(false)
      setSaved(true)
    } catch (e) {
      setError(`${e instanceof Error ? e.message : String(e)}. Nothing was saved.`)
    } finally {
      setBusy(false)
    }
  }

  const idlePlaceholder = isSet ? "•••••••••••••••• set" : "Not set — click to add"
  const buttons = editing ? (
    <>
      {/* Secrets skip the Save/Discard draft, so say so before the click. */}
      <Tooltip label="Saves immediately">
        <Button size="sm" disabled={!value} loading={busy} onClick={replace}>Replace</Button>
      </Tooltip>
      <Button size="sm" variant="subtle" onClick={cancel}>Cancel</Button>
    </>
  ) : (
    onTest && (
      <Button
        size="sm"
        variant={flashValid ? "light" : "default"}
        color={flashValid ? "green" : undefined}
        miw={88}
        disabled={!canTest || test?.status === "testing"}
        onClick={onTest}
      >
        {flashValid ? "✓ Valid" : "Test"}
      </Button>
    )
  )
  return (
    <Stack gap={4}>
      <PasswordInput
        label={<Group gap="xs" component="span">{label}{onTest && <TestChip test={test} />}{saved && !editing && <Badge size="xs" color="green" variant="light" tt="none">✓ Saved</Badge>}</Group>}
        description={description}
        placeholder={editing ? placeholder : idlePlaceholder}
        ref={inputRef}
        value={value}
        data-mantine-stop-propagation={editing ? "true" : undefined}
        visibilityToggleButtonProps={{ style: { display: editing ? undefined : "none" } }}
        onFocus={() => { setEditing(true); setSaved(false) }}
        onChange={(e) => { setEditing(true); setSaved(false); setValue(e.currentTarget.value) }}
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
      {test?.status === "done" && !test.result.ok && test.result.detail && !editing && (
        <Text size="xs" c="dimmed">{test.result.detail}</Text>
      )}
    </Stack>
  )
}
