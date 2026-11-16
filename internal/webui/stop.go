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
// No job running: die(sig). A job running: log and stay, unless a signal was
// already refused within stopForceWindow: then log and die(sig).
//
// Jobs have no time limit and cannot be cancelled, so the second signal is
// the deliberate way to stop a server that is refusing, one that needs no pid.
//
// die ends the process the way the signal itself would have, rather than with
// a status of this server's own choosing: whatever stopped it — a shell, an
// installer, a supervisor — reads that status to tell a stop from a crash.
func (s *Server) GuardStop(sigs <-chan os.Signal, die func(sig os.Signal), now func() time.Time) {
	var refusedAt time.Time
	refused := false
	for sig := range sigs {
		running := s.jobs().Running()
		if len(running) == 0 {
			die(sig)
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
			die(sig)
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
