import { useState } from 'react'
import { Anchor, Group, Modal, Paper, Text } from '@mantine/core'
import { fileProxy } from '../../api/slackApi'
import type { File } from '../../api/slackApi'

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const kb = n / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
}

interface FileAttachmentsProps {
  files: File[]
}

export function FileAttachments({ files }: FileAttachmentsProps) {
  const [erroredIds, setErroredIds] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<File | null>(null)

  function markErrored(id: string) {
    setErroredIds((prev) => {
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }

  return (
    <>
      <Group gap="xs" mt={4} wrap="wrap">
        {files.map((file) => {
          if (file.IsImage && !erroredIds.has(file.ID)) {
            return (
              <img
                key={file.ID}
                src={fileProxy(file.Thumb360 || file.URLPrivate)}
                alt={file.Name}
                loading="lazy"
                width={file.Thumb360W || undefined}
                height={file.Thumb360H || undefined}
                style={{
                  maxWidth: 360,
                  maxHeight: 300,
                  objectFit: 'contain',
                  cursor: 'pointer',
                  borderRadius: 4,
                }}
                onClick={() => setSelected(file)}
                onError={() => markErrored(file.ID)}
              />
            )
          }
          return <FileCard key={file.ID} file={file} />
        })}
      </Group>
      <Modal opened={selected !== null} onClose={() => setSelected(null)} size="auto" title={selected?.Name}>
        {selected && (
          <img
            src={fileProxy(selected.URLPrivate)}
            alt={selected.Name}
            style={{ maxWidth: '80vw', maxHeight: '80vh', objectFit: 'contain' }}
          />
        )}
      </Modal>
    </>
  )
}

function FileCard({ file }: { file: File }) {
  const label = file.PrettyType || file.Filetype || 'file'
  const content = (
    <Paper withBorder p="xs" radius="sm" style={{ minWidth: 200 }}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" fw={500}>
        {file.Name}
      </Text>
      <Text size="xs" c="dimmed">
        {formatBytes(file.Size)}
      </Text>
    </Paper>
  )

  if (file.Permalink) {
    return (
      <Anchor href={file.Permalink} target="_blank" rel="noreferrer" underline="never">
        {content}
      </Anchor>
    )
  }
  return content
}
