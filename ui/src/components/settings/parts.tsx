import { Fragment, type ReactNode } from "react"
import { Badge, Code, Group, Stack, Text, Title } from "@mantine/core"

/** "These settings are persisted to <path>": the first line of every config tab. */
export function PersistedTo({ path, paths }: { path?: string; paths?: string[] }) {
  const all = paths ?? (path ? [path] : [])
  return (
    <Text size="xs" c="dimmed" bg="var(--mantine-color-default-hover)" px="sm" py={6} style={{ borderRadius: 4 }}>
      These settings are persisted to{" "}
      {all.map((p, i) => (
        <Fragment key={p}>
          {i > 0 && (i === all.length - 1 ? " and " : ", ")}
          <Code>{p}</Code>
        </Fragment>
      ))}
    </Text>
  )
}

/**
 * A group of fields under an uppercase heading, optionally badged. `file`
 * names the file the section saves to, for tabs that span several.
 */
export function SettingsSection({ title, badge, file, children }: { title: string; badge?: ReactNode; file?: string; children: ReactNode }) {
  return (
    <Stack gap="xs">
      <Group gap="xs">
        <Title order={6} tt="uppercase" c="dimmed" fz="xs" lts="0.06em">{title}</Title>
        {badge && <Badge size="xs" color="orange" variant="light" tt="none">{badge}</Badge>}
        {file && <Text span ff="monospace" fz="xs" c="dimmed" opacity={0.7} ml="auto">{file}</Text>}
      </Group>
      {children}
    </Stack>
  )
}

/** The YAML key a field writes, in dim monospace, for field descriptions. */
export function KeyPath({ path }: { path: string }) {
  return <Text span ff="monospace" fz="xs" c="dimmed" opacity={0.7}>{path}</Text>
}
