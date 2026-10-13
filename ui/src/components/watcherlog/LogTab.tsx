import { useEffect } from "react"
import { api } from "../../api/client"
import type { WatcherLogScope } from "../../api/types"

export function LogTab({ scope }: { scope: WatcherLogScope }) {
  useEffect(() => {
    void api.watcherLog(scope, { limit: 200 })
    const t = setInterval(() => void api.watcherLog(scope, { limit: 200 }), 3000)
    return () => clearInterval(t)
  }, [scope])
  return null
}
