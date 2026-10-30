import { Fragment } from "react"
import { Text, Tooltip, type TextProps } from "@mantine/core"
import type { ListenerPort } from "../api/types"

/** Why a port is red: it's outside the worktree's reserved range. */
function outOfRangeLabel(range: string | null): string {
  return range
    ? `Outside this worktree's reserved port range (${range.replace("-", "–")})`
    : "Outside this worktree's reserved port range"
}

/** One port number: inherits its color in range; red, with a tooltip saying why, out of range. */
export function PortNumber({ port, range, ...textProps }: { port: ListenerPort; range: string | null } & TextProps) {
  if (port.in_range) return <Text span inherit {...textProps}>{port.port}</Text>
  return (
    <Tooltip label={outOfRangeLabel(range)}>
      <Text span inherit {...textProps} c="red">{port.port}</Text>
    </Tooltip>
  )
}

/** "4091, 9000": inline, with a port outside the worktree's reserved range in red. */
export function ListeningPorts({ ports, range }: { ports: ListenerPort[]; range: string | null }) {
  return (
    <>
      {ports.map((p, i) => (
        <Fragment key={p.port}>
          {i > 0 && ", "}
          <PortNumber port={p} range={range} />
        </Fragment>
      ))}
    </>
  )
}
