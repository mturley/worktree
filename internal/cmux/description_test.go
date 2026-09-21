package cmux

import (
	"os/exec"
	"reflect"
	"testing"
)

func stubCmux(t *testing.T, bin string) *[]string {
	t.Helper()
	var got []string
	orig := cmuxCmd
	cmuxCmd = func(args ...string) *exec.Cmd {
		got = args
		return exec.Command(bin)
	}
	t.Cleanup(func() { cmuxCmd = orig })
	return &got
}

func TestSetWorkspaceDescription(t *testing.T) {
	got := stubCmux(t, "true")
	if err := SetWorkspaceDescription("UUID-1", "some notes"); err != nil {
		t.Fatal(err)
	}
	want := []string{"workspace-action", "--workspace", "UUID-1", "--action", "set-description", "--description", "some notes"}
	if !reflect.DeepEqual(*got, want) {
		t.Fatalf("args = %q, want %q", *got, want)
	}
}

func TestSetWorkspaceDescriptionEmptyClears(t *testing.T) {
	got := stubCmux(t, "true")
	if err := SetWorkspaceDescription("UUID-1", ""); err != nil {
		t.Fatal(err)
	}
	want := []string{"workspace-action", "--workspace", "UUID-1", "--action", "clear-description"}
	if !reflect.DeepEqual(*got, want) {
		t.Fatalf("args = %q, want %q", *got, want)
	}
}

func TestSetWorkspaceDescriptionReportsFailure(t *testing.T) {
	stubCmux(t, "false")
	if err := SetWorkspaceDescription("UUID-1", "x"); err == nil {
		t.Fatal("want error when cmux fails")
	}
}
