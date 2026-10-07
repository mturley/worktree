package cmux

import "testing"

func TestParseFocusEvent(t *testing.T) {
	cases := []struct {
		name   string
		line   string
		wantID string
		wantOK bool
	}{
		{
			name:   "workspace selected",
			line:   `{"type":"event","name":"workspace.selected","workspace_id":null,"payload":{"selected":true,"workspace_id":"W1","previous_workspace_id":"W0"}}`,
			wantID: "W1", wantOK: true,
		},
		{
			name:   "window focused carries its selected workspace",
			line:   `{"type":"event","name":"window.focused","workspace_id":"W2","payload":{"is_key_window":true,"workspace_id":"W2"}}`,
			wantID: "W2", wantOK: true,
		},
		{
			name:   "top-level id when the payload has none",
			line:   `{"type":"event","name":"window.focused","workspace_id":"W3","payload":{}}`,
			wantID: "W3", wantOK: true,
		},
		{
			name: "deselection is not focus",
			line: `{"type":"event","name":"workspace.selected","payload":{"selected":false,"workspace_id":"W1"}}`,
		},
		{
			name: "unrelated event",
			line: `{"type":"event","name":"surface.focused","workspace_id":"W1","payload":{"surface_id":"S1"}}`,
		},
		{name: "ack", line: `{"type":"ack","protocol":"cmux-events"}`},
		{name: "heartbeat", line: `{"type":"heartbeat"}`},
		{name: "no workspace", line: `{"type":"event","name":"workspace.selected","payload":{"selected":true}}`},
		{name: "not json", line: `cmux: socket not found`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			id, ok := ParseFocusEvent([]byte(c.line))
			if id != c.wantID || ok != c.wantOK {
				t.Errorf("ParseFocusEvent = (%q, %v), want (%q, %v)", id, ok, c.wantID, c.wantOK)
			}
		})
	}
}
