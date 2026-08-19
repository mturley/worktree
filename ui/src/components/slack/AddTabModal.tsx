import { useState } from 'react'
import { parseTabFromUrl, type Tab } from '../../state/tabs'
import { TabDetailsModal } from './TabDetailsModal'

interface AddTabModalProps {
  opened: boolean
  onClose: () => void
  onAdd: (tab: Tab, name: string, description: string) => void
}

export function AddTabModal({ opened, onClose, onAdd }: AddTabModalProps) {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setUrl('')
    setName('')
    setDescription('')
    setError(null)
  }

  function handleClose() {
    reset()
    onClose()
  }

  function handleSubmit() {
    const tab = parseTabFromUrl(url)
    if (!tab) {
      setError('That does not look like a valid Slack thread URL.')
      return
    }
    onAdd(tab, name, description)
    reset()
    onClose()
  }

  return (
    <TabDetailsModal
      opened={opened}
      onClose={handleClose}
      title="Open thread"
      name={name}
      onNameChange={setName}
      description={description}
      onDescriptionChange={setDescription}
      onSubmit={handleSubmit}
      submitLabel="Add tab"
      urlField={{
        value: url,
        error,
        onChange: (value) => {
          setUrl(value)
          setError(null)
        },
      }}
    />
  )
}
