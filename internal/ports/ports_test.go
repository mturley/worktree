package ports

import (
	"testing"
)

func TestAllocateAndRelease(t *testing.T) {
	dir := t.TempDir()

	a1, err := Allocate(dir, "test-wt-1")
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	if a1.Slot != 0 {
		t.Errorf("expected slot 0, got %d", a1.Slot)
	}
	if a1.Range() != "4020-4029" {
		t.Errorf("expected 4020-4029, got %s", a1.Range())
	}

	a2, err := Allocate(dir, "test-wt-2")
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	if a2.Slot != 1 {
		t.Errorf("expected slot 1, got %d", a2.Slot)
	}
	if a2.Range() != "4030-4039" {
		t.Errorf("expected 4030-4039, got %s", a2.Range())
	}

	if err := Release(dir, "test-wt-1"); err != nil {
		t.Fatalf("Release: %v", err)
	}

	a3, err := Allocate(dir, "test-wt-3")
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	if a3.Slot != 0 {
		t.Errorf("expected slot 0 (reused), got %d", a3.Slot)
	}
}

func TestAllocateIdempotent(t *testing.T) {
	dir := t.TempDir()

	a1, _ := Allocate(dir, "test-wt")
	a2, _ := Allocate(dir, "test-wt")

	if a1.Slot != a2.Slot {
		t.Errorf("expected same slot, got %d and %d", a1.Slot, a2.Slot)
	}
}

func TestLoadEmpty(t *testing.T) {
	dir := t.TempDir()
	allocs, err := LoadAllocations(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(allocs) != 0 {
		t.Errorf("expected empty, got %d", len(allocs))
	}
}
