package webui

import (
	"path/filepath"
	"testing"

	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/linkmeta"
)

func TestEnrichLinkDTO(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	srv := &Server{DB: conn}

	if err := srv.saveLinkMeta("https://ex.com/a", linkmeta.Meta{
		Title: "A page", Description: "d", SiteName: "ex.com",
		Favicon: "https://ex.com/favicon.ico", Embeddable: true,
		ResolvedAt: "2026-09-11T00:00:00Z",
	}); err != nil {
		t.Fatal(err)
	}

	dto := resourceDTO{Type: "link", ID: "https://ex.com/a", URL: "https://ex.com/a"}
	srv.enrichResourceDTO(&dto)
	if dto.Title != "A page" || dto.SiteName != "ex.com" || !dto.Embeddable {
		t.Fatalf("%+v", dto)
	}
}

func TestEnrichLinkDTOSurvivesMalformedState(t *testing.T) {
	conn, _ := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	defer conn.Close()
	watcherdb.UpsertResourceState(conn, "link", "x", "{not json", "", "")
	srv := &Server{DB: conn}
	dto := resourceDTO{Type: "link", ID: "x"}
	srv.enrichResourceDTO(&dto) // must not panic
	if dto.Title != "" {
		t.Fatalf("expected empty enrichment, got %+v", dto)
	}
}
