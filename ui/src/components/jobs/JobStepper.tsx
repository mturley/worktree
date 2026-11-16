import { Group, Loader, Stack, Text } from "@mantine/core"
import { IconCheck, IconX } from "@tabler/icons-react"
import type { JobStep } from "../../api/types"

/**
 * One stage of a job: icon, label, and git's words when there are any.
 *
 * `quiet` drops the spinner from a step that still says it is running: the
 * job itself is over, and a step left mid-flight is a record of where it got
 * to, not something still happening.
 */
function StepRow({ step, quiet }: { step: JobStep; quiet?: boolean }) {
  const failed = step.status === "failed" || step.status === "needs_force"
  const pending = step.status === "pending" || (quiet && step.status === "running")
  const icon = step.status === "running" && !quiet ? <Loader size={14} aria-label="In progress" />
    : failed
      ? <IconX size={14} color="var(--mantine-color-red-5)" />
      : pending
        ? <Text size="xs" c="dimmed">○</Text>
        : <IconCheck size={14} color="var(--mantine-color-green-5)" />
  return (
    <Stack gap={2}>
      <Group gap={8} wrap="nowrap">
        {icon}
        <Text size="sm" c={pending ? "dimmed" : undefined}>{step.label}</Text>
        {step.status === "skipped" && step.detail && (
          <Text size="xs" c="dimmed">({step.detail})</Text>
        )}
      </Group>
      {failed && step.detail && (
        // A failure's detail is git's own output: it wraps where it was
        // written, and anywhere at all rather than pushing a long path out
        // past the edge of a toast.
        <Text size="xs" c="red" pl={22} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {step.detail}
        </Text>
      )}
    </Stack>
  )
}

/** A job's steps, top to bottom. */
export function JobStepper({ steps, quiet }: { steps: JobStep[]; quiet?: boolean }) {
  return (
    <Stack gap={6}>
      {steps.map((s) => <StepRow key={s.key} step={s} quiet={quiet} />)}
    </Stack>
  )
}
