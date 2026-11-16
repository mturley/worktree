package webui

import (
	"os"
	"sort"
	"strings"
	"time"
)

// stopForceWindow is how long after a refused signal a second one forces.
const stopForceWindow = 5 * time.Second

// GuardStop decides what each stop signal does, until sigs closes.
// No job running: exit(0). A job running: log and stay, unless a signal was
// already refused within stopForceWindow: then log and exit(1).
//
// Jobs have no time limit and cannot be cancelled, so the second signal is
// the deliberate way to stop a server that is refusing, one that needs no pid.
func (s *Server) GuardStop(sigs <-chan os.Signal, exit func(code int), now func() time.Time) {
	var refusedAt time.Time
	refused := false
	for range sigs {
		running := s.jobs().Running()
		if len(running) == 0 {
			exit(0)
			continue
		}
		titles := make([]string, 0, len(running))
		for _, j := range running {
			titles = append(titles, j.Title)
		}
		sort.Strings(titles)
		list := strings.Join(titles, ", ")

		at := now()
		if refused && at.Sub(refusedAt) <= stopForceWindow {
			s.stopLogf("forced stop: %s will be marked interrupted", list)
			exit(1)
			continue
		}
		refused, refusedAt = true, at
		s.stopLogf("refusing to stop: %s is running; signal again within %s to force",
			list, stopForceWindow)
	}
}

func (s *Server) stopLogf(format string, args ...any) {
	if s.Logger != nil {
		s.Logger.Printf(format, args...)
	}
}
