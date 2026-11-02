package cmd

import (
	"database/sql"
	"encoding/json"
	"os"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/webui"
)

// headlessServer builds the Server the read commands call into: the DB and
// the per-service watcher toggles, nothing else. It never listens.
func headlessServer(conn *sql.DB) (*webui.Server, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	srv := &webui.Server{DB: conn}
	off := map[string]bool{}
	for _, svc := range config.Services {
		off[svc] = !cfg.Watchers.Enabled(svc)
	}
	srv.SetWatchersDisabled(off)
	return srv, nil
}

// gitState is a worktree's git summary as the CLI prints it.
type gitState struct {
	Branch   string `json:"branch"`
	Upstream string `json:"upstream,omitempty"`
	Ahead    int    `json:"ahead"`
	Behind   int    `json:"behind"`
	Dirty    bool   `json:"dirty"`
}

func onDisk(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// readGitState summarises the worktree at dir. ok is false when dir is not
// on disk or git cannot read it; no git command runs for a missing path.
func readGitState(dir string) (gitState, bool) {
	if !onDisk(dir) {
		return gitState{}, false
	}
	st, ok := gitutil.ShortStatus(dir)
	if !ok {
		return gitState{}, false
	}
	return gitState{
		Branch: st.Branch, Upstream: st.Upstream,
		Ahead: st.Ahead, Behind: st.Behind, Dirty: !st.Clean(),
	}, true
}

// metaTimes maps each of the worktree's resources to the time its custom
// name/description was last written (watcher_resource_meta.updated_at).
func metaTimes(conn *sql.DB, path string) map[[2]string]string {
	rs, err := resources.Load(conn, path)
	if err != nil {
		return nil
	}
	out := make(map[[2]string]string, len(rs))
	for _, r := range rs {
		if r.UpdatedAt != "" {
			out[[2]string{r.Type, r.ID}] = r.UpdatedAt
		}
	}
	return out
}

// resourceItem renders a resource DTO (ResourceDTO or AllResource) for
// --json.
//
// The DTO's own "updated_at" is the resource's time (resource_updated_at in
// the state cache). agent-handler reads "updated_at" from
// `resources list --json` as the custom-name timestamp for newest-wins
// mirroring, so that key keeps that meaning: the resource's own time moves to
// "resource_updated_at", and "updated_at" is the custom-name write time, or
// absent when there is none.
func resourceItem(dto any, customNameUpdatedAt string) (map[string]any, error) {
	b, err := json.Marshal(dto)
	if err != nil {
		return nil, err
	}
	m := map[string]any{}
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	if v, ok := m["updated_at"]; ok {
		m["resource_updated_at"] = v
		delete(m, "updated_at")
	}
	if customNameUpdatedAt != "" {
		m["updated_at"] = customNameUpdatedAt
	}
	return m, nil
}
