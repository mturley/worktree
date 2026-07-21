package ports

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
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

func (a Allocation) Start() int { return BasePort + a.Slot*RangeSize }
func (a Allocation) End() int   { return a.Start() + RangeSize - 1 }
func (a Allocation) Range() string {
	return fmt.Sprintf("%d-%d", a.Start(), a.End())
}

func portRangesFile(worktreesBase string) string {
	return filepath.Join(worktreesBase, ".port-ranges")
}

func LoadAllocations(worktreesBase string) ([]Allocation, error) {
	f, err := os.Open(portRangesFile(worktreesBase))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var allocs []Allocation
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		parts := strings.Fields(scanner.Text())
		if len(parts) != 2 {
			continue
		}
		slot, err := strconv.Atoi(parts[0])
		if err != nil {
			continue
		}
		allocs = append(allocs, Allocation{Slot: slot, Name: parts[1]})
	}
	return allocs, scanner.Err()
}

func Allocate(worktreesBase, name string) (Allocation, error) {
	allocs, err := LoadAllocations(worktreesBase)
	if err != nil {
		return Allocation{}, err
	}

	used := make(map[int]bool)
	for _, a := range allocs {
		used[a.Slot] = true
		if a.Name == name {
			return a, nil
		}
	}

	slot := 0
	for used[slot] {
		slot++
	}

	alloc := Allocation{Slot: slot, Name: name}
	allocs = append(allocs, alloc)
	return alloc, saveAllocations(worktreesBase, allocs)
}

func Release(worktreesBase, name string) error {
	allocs, err := LoadAllocations(worktreesBase)
	if err != nil {
		return err
	}

	var filtered []Allocation
	for _, a := range allocs {
		if a.Name != name {
			filtered = append(filtered, a)
		}
	}
	return saveAllocations(worktreesBase, filtered)
}

func saveAllocations(worktreesBase string, allocs []Allocation) error {
	sort.Slice(allocs, func(i, j int) bool { return allocs[i].Slot < allocs[j].Slot })

	if err := os.MkdirAll(worktreesBase, 0755); err != nil {
		return err
	}

	var lines []string
	for _, a := range allocs {
		lines = append(lines, fmt.Sprintf("%d %s", a.Slot, a.Name))
	}
	return os.WriteFile(portRangesFile(worktreesBase), []byte(strings.Join(lines, "\n")+"\n"), 0644)
}
