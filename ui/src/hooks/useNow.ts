import { useEffect, useState } from 'react'

/**
 * Returns the current time, re-rendering every `intervalMs` so any relative
 * ("3d ago") labels derived from it stay live without the caller managing
 * its own timer.
 */
export function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])

  return now
}
