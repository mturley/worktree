import { Route, Switch } from "wouter"
import { useSSE } from "./hooks/useSSE"
import { HomeWorktreeBanner } from "./components/HomeWorktreeBanner"
import { HomePage } from "./pages/HomePage"
import { WorktreeDetailPage } from "./pages/WorktreeDetailPage"

export function App() {
  useSSE()
  return (
    <>
      {/*
        Above the router, not inside a page: it has to appear on every route
        except one, and putting it in each page would mean remembering to add
        it to the next page someone writes.
      */}
      <HomeWorktreeBanner />
      <Switch>
        <Route path="/" component={HomePage} />
        <Route path="/worktree/:path*" component={WorktreeDetailPage} />
        <Route>Not found</Route>
      </Switch>
    </>
  )
}
