package webui

// Headless read API. The CLI builds a Server holding only a DB
// (&webui.Server{DB: conn}) and calls these methods instead of going through
// HTTP, so a command prints exactly what the matching endpoint serves.
// Everything reachable from them is read-only.
//
//	WorktreeSummaries  GET /api/worktrees
//	AllResources       GET /api/all-resources
//	ArchivedResources  GET /api/all-resources?archived=true (appended to AllResources)
//	WorktreeResources  GET /api/resources
//	WatcherStatuses    GET /api/watchers
//	ScanListeners      the listeners stream's scan
//	SlackThread, SlackThreadMessages, ResolveSlackThread  the cached Slack thread read
//	Search             the search bar grouped answer (the dropdown rows)

// ResourceDTO is one resource as the web UI's cards show it.
type ResourceDTO = resourceDTO

// WorktreeSummary is one worktree as the home page lists it.
type WorktreeSummary = worktreeSummary

// AllResource is one resource on the home page's Resources tab.
type AllResource = allResourceDTO

// WatcherStatus is one poller's health.
type WatcherStatus = watcherStatusDTO

// SearchMatch is why a search hit matched.
type SearchMatch = searchMatch
