// Package selfid records the user's own account ID per source, so events
// the user caused can be left out of notifications and unread. IDs come from
// the watcher library (watcher_events.author_id): GitHub databaseId, Jira
// accountId, Slack user ID. Stored in the DB so the CLI applies the same rule
// without network calls.
package selfid

import (
	"database/sql"
	"time"
)

// NotMineSQL is the condition "this event was not caused by the user", over
// a watcher_events row aliased e. Matched on source AND id: IDs are only
// unique within a source. A NULL author_id never matches, so authorless and
// pre-v5 events always count as someone else's.
const NotMineSQL = `NOT EXISTS (SELECT 1 FROM self_identity si
	WHERE si.source = e.source AND si.author_id = e.author_id)`

// Set stores the user's ID for source, replacing any previous one.
func Set(conn *sql.DB, source, id string) error {
	_, err := conn.Exec(
		`INSERT INTO self_identity (source, author_id, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT (source) DO UPDATE SET author_id = excluded.author_id, updated_at = excluded.updated_at`,
		source, id, time.Now().UTC().Format(time.RFC3339))
	return err
}

// Load returns the stored IDs keyed by source.
func Load(conn *sql.DB) (map[string]string, error) {
	rows, err := conn.Query(`SELECT source, author_id FROM self_identity`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var src, id string
		if err := rows.Scan(&src, &id); err != nil {
			return nil, err
		}
		out[src] = id
	}
	return out, rows.Err()
}

// IsMine is NotMineSQL's Go twin, for code that already holds an event.
func IsMine(ids map[string]string, source, authorID string) bool {
	return authorID != "" && ids[source] == authorID
}
