package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// SchemaVersion is the version of the JSON envelope every --json output
// carries as "schema_version". Bump it when an existing field changes
// meaning or goes away; adding a field does not.
const SchemaVersion = 1

// ErrNothingFound is returned by a RunE that looked and found nothing, after
// printing its own (empty) output. Execute turns it into exit code 1 without
// printing anything.
var ErrNothingFound = errors.New("nothing found")

// printJSON writes {"schema_version": 1, ...fields} and a newline. A
// schema_version key in fields is overwritten.
func printJSON(w io.Writer, fields map[string]any) error {
	out := make(map[string]any, len(fields)+1)
	for k, v := range fields {
		out[k] = v
	}
	out["schema_version"] = SchemaVersion
	b, err := json.Marshal(out)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(w, string(b))
	return err
}
