import { Route, Switch } from "wouter"
import { useSSE } from "./hooks/useSSE"
import { HomePage } from "./pages/HomePage"
import { WorktreeDetailPage } from "./pages/WorktreeDetailPage"

export function App() {
  useSSE()
  return (
    <Switch>
      <Route path="/" component={HomePage} />
      <Route path="/worktree/:path*" component={WorktreeDetailPage} />
      <Route>Not found</Route>
    </Switch>
  )
}
