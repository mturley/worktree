import { useState, type ReactNode } from "react"
import { Badge, Button, Group, PasswordInput, Stack, Text } from "@mantine/core"
import type { CredResult } from "../../api/types"

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
export function SecretField({ label, description, isSet, placeholder = "Paste a new token", onReplace, onTest, test }: {
  label: string
  description: ReactNode
  isSet: boolean
  placeholder?: string
  /** Validate-then-write. Resolve with the CredResult; ok:false keeps the field open with the error. */
  onReplace: (value: string) => Promise<CredResult | void>
  /** Absent: no Test button and no chip (the UI password). */
  onTest?: () => void
  test?: TestState
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const cancel = () => {
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
      setEditing(false)
      setSaved(true)
    } catch (e) {
      setError(`${e instanceof Error ? e.message : String(e)}. Nothing was saved.`)
    } finally {
      setBusy(false)
    }
  }

  const idlePlaceholder = isSet ? "•••••••••••••••• set" : "Not set — click to add"
  return (
    <Stack gap={4}>
      <PasswordInput
        label={<Group gap="xs" component="span">{label}{onTest && <TestChip test={test} />}{saved && !editing && <Badge size="xs" color="green" variant="light" tt="none">✓ Saved</Badge>}</Group>}
        description={description}
        placeholder={editing ? placeholder : idlePlaceholder}
        value={value}
        visibilityToggleButtonProps={{ style: { display: editing ? undefined : "none" } }}
        onFocus={() => { setEditing(true); setSaved(false) }}
        onChange={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value) void replace()
          if (e.key === "Escape") { e.stopPropagation(); cancel() }
        }}
        error={error}
        aria-label={label}
        autoComplete="off"
        ff="monospace"
        rightSectionWidth={editing ? 0 : undefined}
      />
      <Group gap="xs">
        {editing ? (
          <>
            <Button size="xs" disabled={!value} loading={busy} onClick={replace}>Replace</Button>
            <Button size="xs" variant="subtle" onClick={cancel}>Cancel</Button>
          </>
        ) : (
          onTest && <Button size="xs" variant="default" disabled={!isSet || test?.status === "testing"} onClick={onTest}>Test</Button>
        )}
      </Group>
      {test?.status === "done" && !test.result.ok && test.result.detail && !editing && (
        <Text size="xs" c="dimmed">{test.result.detail}</Text>
      )}
    </Stack>
  )
}
