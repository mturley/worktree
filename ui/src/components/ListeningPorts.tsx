import { Fragment } from "react"
import { Text } from "@mantine/core"
import type { ListenerPort } from "../api/types"

/** "4091, 9000": inline, with a port outside the worktree's reserved range in red. */
export function ListeningPorts({ ports }: { ports: ListenerPort[] }) {
  return (
    <>
      {ports.map((p, i) => (
        <Fragment key={p.port}>
          {i > 0 && ", "}
          <Text span inherit c={p.in_range ? undefined : "red"}>{p.port}</Text>
        </Fragment>
      ))}
    </>
  )
}
