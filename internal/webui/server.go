package webui

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
)

type Server struct {
	DB      *sql.DB
	WebFS   fs.FS // rooted at the dist dir (index.html at top level)
	Port    int
	DevMode bool
	Logger  *log.Logger
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	// API routes are registered by later tasks via registerAPI(mux).
	s.registerAPI(mux)
	if !s.DevMode && s.WebFS != nil {
		mux.HandleFunc("/", s.serveStatic)
	}
	return mux
}

// registerAPI is extended in later tasks. Kept separate so tests can add routes.
func (s *Server) registerAPI(mux *http.ServeMux) {
	// (endpoints added in Tasks 2-6)
}

func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		if _, err := fs.Stat(s.WebFS, r.URL.Path[1:]); err == nil {
			http.FileServer(http.FS(s.WebFS)).ServeHTTP(w, r)
			return
		}
	}
	indexData, err := fs.ReadFile(s.WebFS, "index.html")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(indexData)
}

func (s *Server) Start() error {
	addr := fmt.Sprintf("127.0.0.1:%d", s.Port)
	if s.Logger != nil {
		s.Logger.Printf("worktree UI listening on http://%s", addr)
	}
	return http.ListenAndServe(addr, s.Handler())
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
