import { useState } from "react"
import { Button, Group, Stack, Text, Tooltip } from "@mantine/core"
import { Toggle } from "./Toggle"
import type { NotifyMode } from "../api/types"

function permission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission
}

/**
 * A notification toggle. In browser mode, turning it on is the click that
 * lets us ask for permission, so it asks first; and while it is on, it says
 * so when THIS browser can't show notifications. A setting saved from one
 * device does nothing on another until that browser allows it, and hiding
 * that would read as the feature being broken. In cmux mode none of this
 * applies: the server shows them.
 */
export function NotifySwitch({
  label,
  checked,
  onToggle,
  tooltip,
  disabledReason,
  mode,
}: {
  label: string
  checked: boolean
  onToggle: (on: boolean) => Promise<void>
  tooltip?: string
  disabledReason?: string
  mode: NotifyMode | undefined
}) {
  const [perm, setPerm] = useState(permission)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const browser = mode === "browser"

  const ask = async () => {
    if (permission() === "default") setPerm(await Notification.requestPermission())
  }

  const change = async (on: boolean) => {
    setSaving(true)
    setError(null)
    try {
      if (on && browser) await ask()
      await onToggle(on)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const sw = (
    <Toggle
      label={label}
      checked={checked}
      disabled={saving || Boolean(disabledReason)}
      onChange={(e) => void change(e.currentTarget.checked)}
    />
  )
  const reason = disabledReason ?? tooltip

  return (
    <Stack gap={4}>
      {reason ? (
        <Tooltip label={reason} withArrow multiline maw={280}>
          {/* A wrapper, not the input: a disabled input gets no hover events. */}
          <div data-testid="notify-switch-target" style={{ display: "inline-block" }}>{sw}</div>
        </Tooltip>
      ) : (
        sw
      )}
      {checked && browser && !disabledReason && perm === "unsupported" && (
        <Text size="xs" c="orange">This browser can't show notifications.</Text>
      )}
      {checked && browser && !disabledReason && perm === "denied" && (
        <Text size="xs" c="orange">
          This browser is blocking notifications. Allow them in the site settings to receive them here.
        </Text>
      )}
      {checked && browser && !disabledReason && perm === "default" && (
        <Group gap={6}>
          <Text size="xs" c="orange">Notifications aren't enabled in this browser</Text>
          <Button size="compact-xs" variant="light" onClick={() => void ask()}>Allow</Button>
        </Group>
      )}
      {error && <Text size="xs" c="red">{error}</Text>}
    </Stack>
  )
}
