import { Button, Group, Modal, Select, Stack, TextInput, Tooltip } from "@mantine/core"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { api } from "../api/client"

interface Props {
  opened: boolean
  onClose: () => void
  path: string
  branch: string
}

/**
 * Full parity with the CLI's workspace prompts: name, group, colour.
 *
 * Groups and colours are fetched only while the modal is open, keeping the
 * polled /api/cmux endpoint to a single exec. Colours come from the server
 * (cmux.NamedColors) rather than a duplicated TS list.
 */
export function CreateWorkspaceModal({ opened, onClose, path, branch }: Props) {
  const qc = useQueryClient()
  const [name, setName] = useState("")
  const [groupRef, setGroupRef] = useState<string | null>(null)
  const [color, setColor] = useState<string | null>(null)

  const meta = useQuery({
    queryKey: ["cmux-groups"],
    queryFn: () => api.cmuxGroups(),
    enabled: opened,
  })

  // Reset on every open so a cancelled attempt never leaks into the next one.
  useEffect(() => {
    if (opened) {
      setName(`wt ${branch}`)
      setGroupRef(null)
      setColor(null)
    }
  }, [opened, branch])

  const create = useMutation({
    mutationFn: () =>
      api.cmuxCreate({
        path,
        name,
        group_ref: groupRef ?? undefined,
        color: color ?? undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cmux"] })
      onClose()
    },
  })

  return (
    <Modal opened={opened} onClose={onClose} title="Create cmux workspace" centered>
      <Stack gap="sm">
        <TextInput
          label="Name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <Select
          label="Group"
          placeholder="(none)"
          clearable
          value={groupRef}
          onChange={setGroupRef}
          data={(meta.data?.groups ?? []).map((g) => ({ value: g.ref, label: g.name }))}
        />
        <Stack gap={4}>
          <Group gap={6} wrap="wrap">
            {(meta.data?.colors ?? []).map((c) => (
              <Tooltip key={c.name} label={c.name}>
                <button
                  type="button"
                  aria-label={c.name}
                  onClick={() => setColor(color === c.name ? null : c.name)}
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    background: c.hex,
                    cursor: "pointer",
                    border: color === c.name
                      ? "2px solid var(--mantine-color-text)"
                      : "2px solid transparent",
                  }}
                />
              </Tooltip>
            ))}
          </Group>
        </Stack>
        <Group justify="flex-end">
          <Button variant="subtle" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => create.mutate()}
            loading={create.isPending}
            disabled={!name.trim()}
          >
            Create
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
