import { useEffect, useState } from 'react'
import { defaultTabName, type Tab } from '../../state/tabs'
import { TabDetailsModal } from './TabDetailsModal'

interface EditTabModalProps {
  opened: boolean
  tab: Tab | null
  onClose: () => void
  onSave: (id: string, name: string, description: string) => void
}

/** Edits an existing tab's title/description, pre-filled from `tab`. */
export function EditTabModal({ opened, tab, onClose, onSave }: EditTabModalProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  // Re-sync the form fields from the tab each time the modal is opened, so
  // reopening always reflects the tab's current (possibly stale-in-state)
  // values rather than whatever was left over from a prior edit session.
  useEffect(() => {
    if (opened && tab) {
      // When the tab has no custom title, tab.name holds the auto-generated
      // "channel @ ts" placeholder — show the field blank so the user types a
      // fresh title rather than editing the placeholder.
      const hasCustomTitle = tab.name !== defaultTabName(tab.channel, tab.threadTs)
      setName(hasCustomTitle ? tab.name : '')
      setDescription(tab.description)
    }
  }, [opened, tab])

  function handleSubmit() {
    if (!tab) {
      return
    }
    // If the user leaves the title blank, save an empty string to clear the
    // custom name from the database. Display layers fall back to the auto-generated
    // placeholder (defaultTabName) and first-message preview via their own
    // `custom_name || ...` logic.
    const trimmed = name.trim()
    onSave(tab.id, trimmed, description)
    onClose()
  }

  return (
    <TabDetailsModal
      opened={opened}
      onClose={onClose}
      title="Edit thread details"
      name={name}
      onNameChange={setName}
      description={description}
      onDescriptionChange={setDescription}
      onSubmit={handleSubmit}
      submitLabel="Save"
    />
  )
}
