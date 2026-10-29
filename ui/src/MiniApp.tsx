import { Route, Router, Switch } from "wouter"
import { useSSE } from "./hooks/useSSE"
import { useMacUnreadBridge } from "./hooks/useMacUnreadBridge"
import { useTooltipLayer } from "./hooks/useTooltipLayer"
import { useMiniLocation } from "./lib/miniMode"
import { MiniPage } from "./pages/MiniPage"
import { SettingsProvider } from "./components/settings/SettingsContext"
import { TaskModalProvider } from "./components/tasks/modal/TaskModalProvider"
import { TaskDetailModal } from "./components/tasks/modal/TaskDetailModal"

// The menu bar app's view. Deliberately without useTabPresence (this is not a
// browser tab, so it must never be picked to show a notification),
// useUnreadFavicon, and the banners/followers that act on the full UI.
export function MiniApp() {
  useSSE()
  useMacUnreadBridge()
  useTooltipLayer()
  return (
    <Router hook={useMiniLocation}>
      <SettingsProvider>
        <TaskModalProvider>
          <Switch>
            <Route path="/mini" component={MiniPage} />
          </Switch>
          <TaskDetailModal />
        </TaskModalProvider>
      </SettingsProvider>
    </Router>
  )
}
