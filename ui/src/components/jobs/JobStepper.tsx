import { Group, Loader, Stack, Text } from "@mantine/core"
import { IconCheck, IconX } from "@tabler/icons-react"
import type { JobStep } from "../../api/types"

/** One stage of a job: icon, label, and git's words when there are any. */
function StepRow({ step }: { step: JobStep }) {
  const failed = step.status === "failed" || step.status === "needs_force"
  const icon = step.status === "running" ? <Loader size={14} aria-label="In progress" />
    : failed
      ? <IconX size={14} color="var(--mantine-color-red-5)" />
      : step.status === "pending"
        ? <Text size="xs" c="dimmed">○</Text>
        : <IconCheck size={14} color="var(--mantine-color-green-5)" />
  return (
    <Stack gap={2}>
      <Group gap={8} wrap="nowrap">
        {icon}
        <Text size="sm" c={step.status === "pending" ? "dimmed" : undefined}>{step.label}</Text>
        {step.status === "skipped" && step.detail && (
          <Text size="xs" c="dimmed">({step.detail})</Text>
        )}
      </Group>
      {failed && step.detail && (
        <Text size="xs" c="red" pl={22} style={{ whiteSpace: "pre-wrap" }}>{step.detail}</Text>
      )}
    </Stack>
  )
}

/** A job's steps, top to bottom. */
export function JobStepper({ steps }: { steps: JobStep[] }) {
  return (
    <Stack gap={6}>
      {steps.map((s) => <StepRow key={s.key} step={s} />)}
    </Stack>
  )
}
