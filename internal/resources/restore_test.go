package resources

import (
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/notifyprefs"
)

func TestRemoveWithSnapshotRecordsGroupIndexAndNotify(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/snap"
	addAll(t, conn, wt, false, "o/r#1", "o/r#2")
	addAll(t, conn, wt, true, "o/r#7", "o/r#8", "o/r#9")
	if err := notifyprefs.SetResource(conn, wt, "pr", "o/r#8", true); err != nil {
		t.Fatal(err)
	}

	snap, ok, err := RemoveWithSnapshot(conn, wt, "pr", "o/r#8")
	if err != nil || !ok {
		t.Fatalf("RemoveWithSnapshot: ok=%v err=%v", ok, err)
	}
	want := Removed{Type: "pr", ID: "o/r#8", URL: "u", Primary: false, Index: 1, Notify: true}
	if snap != want {
		t.Fatalf("snapshot = %+v, want %+v", snap, want)
	}
	res, _ := Load(conn, wt)
	if got := strings.Join(ids(res), ","); strings.Contains(got, "o/r#8") {
		t.Fatalf("still followed after remove: %s", got)
	}
}

func TestRemoveWithSnapshotOfUnfollowedResource(t *testing.T) {
	conn := testDB(t)
	_, ok, err := RemoveWithSnapshot(conn, "/tmp/wt/none", "pr", "o/r#1")
	if err != nil || ok {
		t.Fatalf("ok=%v err=%v, want ok=false and no error", ok, err)
	}
}

func TestRestorePutsTheResourceBackWhereItWas(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/restore"
	addAll(t, conn, wt, true, "o/r#1", "o/r#2", "o/r#3")
	addAll(t, conn, wt, false, "o/r#8")
	if err := notifyprefs.SetResource(conn, wt, "pr", "o/r#2", true); err != nil {
		t.Fatal(err)
	}
	snap, _, err := RemoveWithSnapshot(conn, wt, "pr", "o/r#2")
	if err != nil {
		t.Fatal(err)
	}

	if err := Restore(conn, wt, snap); err != nil {
		t.Fatal(err)
	}
	res, _ := Load(conn, wt)
	if got, want := strings.Join(ids(res), ","), "pr:o/r#8,pr:o/r#1,pr:o/r#2,pr:o/r#3"; got != want {
		t.Fatalf("order = %s, want %s", got, want)
	}
	if res[2].Related != true {
		t.Fatalf("restored into the wrong group: %+v", res[2])
	}
	prefs, _ := notifyprefs.Get(conn, wt)
	if !prefs.Resources[notifyprefs.Key{Type: "pr", ID: "o/r#2"}] {
		t.Fatal("notify toggle not restored")
	}

	// Repeating it changes nothing.
	if err := Restore(conn, wt, snap); err != nil {
		t.Fatal(err)
	}
	res, _ = Load(conn, wt)
	if got, want := strings.Join(ids(res), ","), "pr:o/r#8,pr:o/r#1,pr:o/r#2,pr:o/r#3"; got != want {
		t.Fatalf("order after repeat = %s, want %s", got, want)
	}
}

func TestRestoreClampsAnIndexPastTheGroupsEnd(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/clamp"
	addAll(t, conn, wt, false, "o/r#1", "o/r#2", "o/r#3")
	snap, _, err := RemoveWithSnapshot(conn, wt, "pr", "o/r#3")
	if err != nil {
		t.Fatal(err)
	}
	// The group shrank while the undo was on offer.
	if err := Remove(conn, wt, "pr", "o/r#2"); err != nil {
		t.Fatal(err)
	}

	if err := Restore(conn, wt, snap); err != nil {
		t.Fatal(err)
	}
	res, _ := Load(conn, wt)
	if got, want := strings.Join(ids(res), ","), "pr:o/r#1,pr:o/r#3"; got != want {
		t.Fatalf("order = %s, want %s", got, want)
	}
	prefs, _ := notifyprefs.Get(conn, wt)
	if prefs.Resources[notifyprefs.Key{Type: "pr", ID: "o/r#3"}] {
		t.Fatal("a resource that did not notify must not come back notifying")
	}
}
