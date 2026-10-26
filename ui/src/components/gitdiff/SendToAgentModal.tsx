import { Button, CopyButton, Group, Modal, Stack, Textarea } from "@mantine/core"
import { IconCheck, IconCopy } from "@tabler/icons-react"

/** The review comments as one prompt, to copy into an agent's session. */
export function SendToAgentModal({ opened, onClose, prompt }: { opened: boolean; onClose: () => void; prompt: string }) {
  return (
    <Modal opened={opened} onClose={onClose} title="Copy comments for agent" centered size="xl">
      <Stack gap="sm">
        <Textarea
          aria-label="Prompt"
          readOnly
          autosize
          minRows={10}
          maxRows={24}
          value={prompt}
          styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)", fontSize: "var(--mantine-font-size-xs)" } }}
        />
        <Group justify="flex-end">
          <CopyButton value={prompt}>
            {({ copied, copy }) => (
              <Button
                color={copied ? "teal" : "blue"}
                leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                onClick={copy}
                data-autofocus
              >
                {copied ? "Copied" : "Copy to clipboard"}
              </Button>
            )}
          </CopyButton>
        </Group>
      </Stack>
    </Modal>
  )
}
