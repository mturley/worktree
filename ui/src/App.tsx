import { Route, Router, Switch } from "wouter"
import { useEffect, useState } from "react"
import { Alert, Button, Center, Stack, Text } from "@mantine/core"
import { useSSE } from "./hooks/useSSE"
import { useSession } from "./hooks/useSession"
import { useTabPresence } from "./hooks/useTabPresence"
import { useUnreadFavicon } from "./hooks/useUnreadFavicon"
import { useTooltipLayer } from "./hooks/useTooltipLayer"
import { CmuxFollower } from "./components/CmuxFollower"
import { HomeWorktreeBanner } from "./components/HomeWorktreeBanner"
import { UpdateBanner } from "./components/UpdateBanner"
import { useHomeLocation } from "./lib/useHomeLocation"
import { HomePage } from "./pages/HomePage"
import { LoginPage } from "./pages/LoginPage"
import { WorktreeDetailPage } from "./pages/WorktreeDetailPage"
import { SettingsProvider } from "./components/settings/SettingsContext"

export function App() {
  const session = useSession()
  if (session.state === "loading") return null
  if (session.state === "unauthenticated") return <LoginPage />
  if (session.state === "error") {
    return <ServerUnreachable error={session.error} onRetry={session.retry} />
  }
  return <AuthenticatedApp />
}

const RELOAD_AFTER_SECONDS = 10

// A full reload rather than a retry: the usual cause is the server restarting
// after a reinstall, and reloading picks up the new build's assets too.
function ServerUnreachable({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const [secondsLeft, setSecondsLeft] = useState(RELOAD_AFTER_SECONDS)
  useEffect(() => {
    const id = window.setInterval(() => setSecondsLeft((s) => s - 1), 1000)
    return () => window.clearInterval(id)
  }, [])
  useEffect(() => {
    if (secondsLeft <= 0) window.location.reload()
  }, [secondsLeft])
  return (
    <Center mih="100vh" p="md">
      <Stack gap="sm" maw={420}>
        <Alert color="red" title="Couldn't reach the worktree server">
          {error instanceof Error ? error.message : "The request failed."}
        </Alert>
        <Text size="sm" c="dimmed">
          Reloading the page in {Math.max(secondsLeft, 0)}s…
        </Text>
        <Button variant="default" onClick={onRetry}>Retry</Button>
      </Stack>
    </Center>
  )
}

// Mounted only with a session, so the event stream never opens while logged
// out. The login screen leaves the URL untouched, so a deep link from a cmux
// pane lands on its page once logged in.
function AuthenticatedApp() {
  useSSE()
  // Tells the server where this tab is, so a browser notification comes out
  // of the tab that best matches it (see internal/webui/tabs.go).
  useTabPresence()
  // Beside useSSE rather than in a page: the tab says the same thing wherever
  // you are in the app, and the stream is what keeps both of them current.
  useUnreadFavicon()
  // Tooltips in scrolling content open under the pinned headers and cards.
  useTooltipLayer()
  return (
    // The custom hook keeps this tab's home worktree in the URL across every
    // navigation — the only carrier that survives a cmux pane restore.
    <Router hook={useHomeLocation}>
      {/* Above everything else on every page, like the nav banner below. */}
      <UpdateBanner />
      {/*
        Outside the Switch, not inside a page: it belongs on every route but
        one, and putting it in each page would mean remembering to add it to
        the next page someone writes. Inside the Router because it reads the
        current location to decide.
      */}
      <HomeWorktreeBanner />
      {/* Every page, for the same reason; it navigates, so it needs the Router. */}
      <CmuxFollower />
      {/* One Settings modal for every page: the home page's cog and the
          worktree page's "Re-enable it in Settings" links both open it. */}
      <SettingsProvider>
        <Switch>
          <Route path="/" component={HomePage} />
          <Route path="/worktree/:path*" component={WorktreeDetailPage} />
          <Route>Not found</Route>
        </Switch>
      </SettingsProvider>
    </Router>
  )
}
