import { useCallback, useEffect, useRef, useState } from "react"
import { Box, Button, Code, Group, ScrollArea, Stack, Switch, Text, UnstyledButton } from "@mantine/core"
import { api } from "../../api/client"
import type { PollLogEntry } from "../../api/types"
import { appendOlder, httpSummary, mergeNewer } from "../../lib/watcherLog"
import { SourceFilter } from "../SourceFilter"

const POLL_MS = 3000
const PAGE = 200
const LEVEL_COLOR: Record<PollLogEntry["level"], string> = {
  info: "var(--mantine-color-gray-6)",
  warn: "var(--mantine-color-yellow-6)",
  error: "var(--mantine-color-red-6)",
}
const SOURCE_LABEL: Record<string, string> = { github: "GitHub", jira: "Jira", slack: "Slack" }
// SourceFilter speaks resource types; the log's GitHub source is "github", not "pr".
const TYPE_TO_SOURCE: Record<string, string> = { pr: "github", jira: "jira", slack: "slack" }
const SOURCE_TO_TYPE: Record<string, string> = { github: "pr", jira: "jira", slack: "slack" }

function clock(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleTimeString([], { hour12: false })
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function LogTab() {
  const [source, setSource] = useState<string | undefined>()
  const [warnOnly, setWarnOnly] = useState(false)
  const [entries, setEntries] = useState<PollLogEntry[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [newCount, setNewCount] = useState(0)
  const viewport = useRef<HTMLDivElement>(null)
  const newest = useRef(0)
  const generation = useRef(0)
  const [error, setError] = useState<string | null>(null)

  const query = useCallback(
    (extra: { after_id?: number; before_id?: number }) =>
      api.watcherLog({
        source,
        level: warnOnly ? "warn" : undefined,
        limit: PAGE,
        ...extra,
      }),
    [source, warnOnly],
  )

  useEffect(() => {
    let cancelled = false
    generation.current += 1
    setError(null)
    setEntries([])
    setLoaded(false)
    setNewCount(0)
    newest.current = 0
    void query({}).then((r) => {
      if (cancelled) return
      setEntries(r.entries)
      setHasMore(r.has_more)
      setLoaded(true)
      newest.current = r.entries[0]?.id ?? 0
      setError(null)
    }).catch((err: unknown) => {
      if (cancelled) return
      setLoaded(true)
      setError(errMsg(err))
    })
    const t = setInterval(() => {
      void query({ after_id: newest.current || undefined }).then((r) => {
        if (cancelled) return
        setError(null)
        if (r.entries.length === 0) return
        const fresh = r.entries.filter((e) => e.id > newest.current).length
        newest.current = Math.max(newest.current, r.entries[0].id)
        setEntries((cur) => mergeNewer(cur, r.entries))
        if ((viewport.current?.scrollTop ?? 0) > 0) setNewCount((n) => n + fresh)
      }).catch((err: unknown) => {
        if (!cancelled) setError(errMsg(err))
      })
    }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [query])

  const loadOlder = () => {
    const last = entries[entries.length - 1]
    if (!last) return
    const gen = generation.current
    void query({ before_id: last.id }).then((r) => {
      if (gen !== generation.current) return
      setEntries((cur) => appendOlder(cur, r.entries))
      setHasMore(r.has_more)
    }).catch((err: unknown) => {
      if (gen === generation.current) setError(errMsg(err))
    })
  }

  const toggle = (id: number) =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <SourceFilter
          value={source ? [SOURCE_TO_TYPE[source]] : []}
          onChange={(types) => setSource(types[0] ? TYPE_TO_SOURCE[types[0]] : undefined)}
        />
        <Switch size="xs" label="Errors & warnings only" checked={warnOnly} onChange={(e) => setWarnOnly(e.currentTarget.checked)} />
      </Group>
      {error && (
        <Text size="sm" c="red">
          Couldn't load the watcher log: {error}
        </Text>
      )}
      {newCount > 0 && (
        <Button
          size="compact-xs"
          variant="light"
          style={{ alignSelf: "center" }}
          onClick={() => {
            viewport.current?.scrollTo({ top: 0 })
            setNewCount(0)
          }}
        >
          {newCount} new
        </Button>
      )}
      <ScrollArea h="60vh" viewportRef={viewport} onScrollPositionChange={({ y }) => y === 0 && setNewCount(0)}>
        {loaded && entries.length === 0 && (
          <Text size="sm" c="dimmed" ta="center" py="lg">
            No watcher activity recorded yet.
          </Text>
        )}
        <Stack gap={2}>
          {entries.map((e) => {
            const expandable = !!e.error_body || e.resources.length > 0
            const line = (
              <Group gap="xs" wrap="nowrap" align="baseline">
                <Text size="xs" c="dimmed" ff="monospace" title={e.ts} style={{ flex: "none" }}>
                  {clock(e.ts)}
                </Text>
                <Box w={8} h={8} style={{ borderRadius: 4, background: LEVEL_COLOR[e.level], flex: "none" }} aria-label={e.level} role="img" />
                <Text size="xs" c="dimmed" w={48} style={{ flex: "none" }}>
                  {SOURCE_LABEL[e.source] ?? e.source}
                </Text>
                <Text size="xs" ff={e.kind === "http" ? "monospace" : undefined} style={{ wordBreak: "break-word" }}>
                  {httpSummary(e) ?? e.message}
                </Text>
              </Group>
            )
            return (
              <Box key={e.id}>
                {expandable ? <UnstyledButton onClick={() => toggle(e.id)} w="100%" aria-expanded={expanded.has(e.id)}>{line}</UnstyledButton> : line}
                {expanded.has(e.id) && (
                  <Stack gap={4} pl={96} py={4}>
                    {e.error_body && <Code block>{e.error_body}</Code>}
                    {e.resources.length > 0 && (
                      <Text size="xs" c="dimmed">
                        {e.resources.map((r) => r.name).join(", ")}
                      </Text>
                    )}
                  </Stack>
                )}
              </Box>
            )
          })}
        </Stack>
        {hasMore && (
          <Group justify="center" py="xs">
            <Button size="compact-xs" variant="subtle" onClick={loadOlder}>
              Load older
            </Button>
          </Group>
        )}
      </ScrollArea>
    </Stack>
  )
}
