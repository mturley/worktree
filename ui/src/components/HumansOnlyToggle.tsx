import { Toggle } from "./Toggle"

/** The activity feeds' "Humans only" switch; the value is useHumansOnly's. */
export function HumansOnlyToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Toggle
      checked={value}
      onChange={(e) => onChange(e.currentTarget.checked)}
      label="Humans only"
      tooltip="Hide events from bots and CI, leaving only what people said and did"
    />
  )
}
