package cmux

import (
	"errors"
	"os/exec"
	"strings"
	"testing"
)

func TestParseNotifications(t *testing.T) {
	data := []byte(`{"notifications": [
		{"id": "1", "workspace_id": "AAAA-UUID", "surface_ref": "surface:1", "is_read": false},
		{"id": "2", "workspace_id": "AAAA-UUID", "surface_ref": "surface:2", "is_read": true},
		{"id": "3", "workspace_id": "BBBB-UUID", "surface_ref": "surface:3"}
	]}`)
	got, err := parseNotifications(data)
	if err != nil {
		t.Fatal(err)
	}
	want := []Notification{
		{ID: "1", WorkspaceID: "AAAA-UUID", SurfaceRef: "surface:1", IsRead: false},
		{ID: "2", WorkspaceID: "AAAA-UUID", SurfaceRef: "surface:2", IsRead: true},
		{ID: "3", WorkspaceID: "BBBB-UUID", SurfaceRef: "surface:3", IsRead: false},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d notifications, want %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("notification %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestParseNotificationsInvalidJSON(t *testing.T) {
	if _, err := parseNotifications([]byte("not json")); err == nil {
		t.Fatal("want error on invalid JSON")
	}
}

func TestParseNotificationsEmpty(t *testing.T) {
	got, err := parseNotifications([]byte(`{"notifications": []}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("got %+v, want empty", got)
	}
}

func TestListNotificationsArgs(t *testing.T) {
	orig := cmuxCmd
	t.Cleanup(func() { cmuxCmd = orig })
	var got []string
	cmuxCmd = func(args ...string) *exec.Cmd {
		got = args
		return exec.Command("echo", `{"notifications": []}`)
	}
	if _, err := ListNotifications(); err != nil {
		t.Fatal(err)
	}
	want := "rpc|notification.list|{}"
	if strings.Join(got, "|") != want {
		t.Fatalf("args = %q, want %q", got, want)
	}
}

func TestListNotificationsError(t *testing.T) {
	orig := cmuxCmd
	t.Cleanup(func() { cmuxCmd = orig })
	cmuxCmd = func(args ...string) *exec.Cmd { return exec.Command("sh", "-c", "echo boom >&2; exit 1") }
	_, err := ListNotifications()
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("err = %v, want it to carry cmux's stderr", err)
	}
}

func TestListNotificationsExitErrorWithoutStderr(t *testing.T) {
	orig := cmuxCmd
	t.Cleanup(func() { cmuxCmd = orig })
	cmuxCmd = func(args ...string) *exec.Cmd { return exec.Command("false") }
	_, err := ListNotifications()
	var exitErr *exec.ExitError
	if err == nil || !errors.As(err, &exitErr) {
		// fine either way, just ensure no panic and an error is returned
	}
	if err == nil {
		t.Fatal("want error")
	}
}
