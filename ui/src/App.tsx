import { Route, Router, Switch } from "wouter"
import { Alert, Button, Center, Stack } from "@mantine/core"
import { useSSE } from "./hooks/useSSE"
import { useSession } from "./hooks/useSession"
import { HomeWorktreeBanner } from "./components/HomeWorktreeBanner"
import { useHomeLocation } from "./lib/useHomeLocation"
import { HomePage } from "./pages/HomePage"
import { LoginPage } from "./pages/LoginPage"
import { WorktreeDetailPage } from "./pages/WorktreeDetailPage"

export function App() {
  const session = useSession()
  if (session.state === "loading") return null
  if (session.state === "unauthenticated") return <LoginPage />
  if (session.state === "error") {
    return (
      <Center mih="100vh" p="md">
        <Stack gap="sm" maw={420}>
          <Alert color="red" title="Couldn't reach the worktree server">
            {session.error instanceof Error ? session.error.message : "The request failed."}
          </Alert>
          <Button variant="default" onClick={session.retry}>Retry</Button>
        </Stack>
      </Center>
    )
  }
  return <AuthenticatedApp />
}

// Mounted only with a session, so the event stream never opens while logged
// out. The login screen leaves the URL untouched, so a deep link from a cmux
// pane lands on its page once logged in.
function AuthenticatedApp() {
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
