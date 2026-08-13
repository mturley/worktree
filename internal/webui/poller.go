package webui

import "time"

// StartPolling is fully implemented in Task 4; this no-op keeps cmd/ui.go
// compiling until then. Returns a stop func.
func (s *Server) StartPolling(interval time.Duration) (stop func()) {
	return func() {}
}
