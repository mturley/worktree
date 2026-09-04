import { Route, Router, Switch } from "wouter"
import { useSSE } from "./hooks/useSSE"
import { HomeWorktreeBanner } from "./components/HomeWorktreeBanner"
import { useHomeLocation } from "./lib/useHomeLocation"
import { HomePage } from "./pages/HomePage"
import { WorktreeDetailPage } from "./pages/WorktreeDetailPage"

export function App() {
  useSSE()
  return (
    // The custom hook keeps this tab's home worktree in the URL across every
    // navigation — the only carrier that survives a cmux pane restore.
    <Router hook={useHomeLocation}>
      {/*
        Outside the Switch, not inside a page: it belongs on every route but
        one, and putting it in each page would mean remembering to add it to
        the next page someone writes. Inside the Router because it reads the
        current location to decide.
      */}
      <HomeWorktreeBanner />
      <Switch>
        <Route path="/" component={HomePage} />
        <Route path="/worktree/:path*" component={WorktreeDetailPage} />
        <Route>Not found</Route>
      </Switch>
    </Router>
  )
}
