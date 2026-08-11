package ports

import (
	"database/sql"
	"fmt"
	"strings"
)

const (
	BasePort  = 4020
	RangeSize = 10
)

type Allocation struct {
	Slot int
	Name string
}

func (a Allocation) Start() int    { return BasePort + a.Slot*RangeSize }
func (a Allocation) End() int      { return a.Start() + RangeSize - 1 }
func (a Allocation) Range() string { return fmt.Sprintf("%d-%d", a.Start(), a.End()) }

// LoadAllocations returns all allocations ordered by slot.
func LoadAllocations(conn *sql.DB) ([]Allocation, error) {
	rows, err := conn.Query(`SELECT slot, name FROM port_allocations ORDER BY slot`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Allocation
	for rows.Next() {
		var a Allocation
		if err := rows.Scan(&a.Slot, &a.Name); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// Allocate returns name's existing allocation, or assigns the lowest free slot
// and inserts it. The UNIQUE(slot) constraint makes concurrent allocations of
// the same slot fail rather than silently collide; we retry on that.
func Allocate(conn *sql.DB, name string) (Allocation, error) {
	// Existing?
	var slot int
	err := conn.QueryRow(`SELECT slot FROM port_allocations WHERE name = ?`, name).Scan(&slot)
	if err == nil {
		return Allocation{Slot: slot, Name: name}, nil
	}
	if err != sql.ErrNoRows {
		return Allocation{}, err
	}

	for attempt := 0; attempt < 1000; attempt++ {
		free, err := lowestFreeSlot(conn)
		if err != nil {
			return Allocation{}, err
		}
		_, err = conn.Exec(`INSERT INTO port_allocations (name, slot) VALUES (?, ?)`, name, free)
		if err == nil {
			return Allocation{Slot: free, Name: name}, nil
		}
		// UNIQUE violation (name or slot taken concurrently) -> re-read and retry.
		if isConstraintErr(err) {
			// Maybe the name got inserted concurrently; return that row if so.
			if e2 := conn.QueryRow(`SELECT slot FROM port_allocations WHERE name = ?`, name).Scan(&slot); e2 == nil {
				return Allocation{Slot: slot, Name: name}, nil
			}
			continue
		}
		return Allocation{}, err
	}
	return Allocation{}, fmt.Errorf("could not allocate a free port slot for %q", name)
}

func lowestFreeSlot(conn *sql.DB) (int, error) {
	rows, err := conn.Query(`SELECT slot FROM port_allocations ORDER BY slot`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	used := map[int]bool{}
	for rows.Next() {
		var s int
		if err := rows.Scan(&s); err != nil {
			return 0, err
		}
		used[s] = true
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	slot := 0
	for used[slot] {
		slot++
	}
	return slot, nil
}

func Release(conn *sql.DB, name string) error {
	_, err := conn.Exec(`DELETE FROM port_allocations WHERE name = ?`, name)
	return err
}

// isConstraintErr reports whether err is a SQLite UNIQUE/PRIMARY KEY violation.
func isConstraintErr(err error) bool {
	return err != nil && strings.Contains(err.Error(), "constraint failed")
}
