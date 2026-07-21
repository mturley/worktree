package resources

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Resource struct {
	Type    string // "pr", "jira"
	ID      string // "owner/repo#123" or "RHOAIENG-456"
	URL     string
	Related bool // true if prefixed with "~ "
}

const Filename = ".worktree-resources"

func FilePath(worktreePath string) string {
	return filepath.Join(worktreePath, Filename)
}

func Load(worktreePath string) ([]Resource, error) {
	f, err := os.Open(FilePath(worktreePath))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var resources []Resource
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		r, err := parseLine(line)
		if err != nil {
			continue
		}
		resources = append(resources, r)
	}
	return resources, scanner.Err()
}

func Save(worktreePath string, resources []Resource) error {
	var lines []string
	for _, r := range resources {
		line := fmt.Sprintf("%s:%s %s", r.Type, r.ID, r.URL)
		if r.Related {
			line = "~ " + line
		}
		lines = append(lines, line)
	}
	return os.WriteFile(FilePath(worktreePath), []byte(strings.Join(lines, "\n")+"\n"), 0644)
}

func Add(worktreePath string, r Resource) error {
	existing, err := Load(worktreePath)
	if err != nil {
		return err
	}

	for i, e := range existing {
		if e.Type == r.Type && e.ID == r.ID {
			existing[i] = r
			return Save(worktreePath, existing)
		}
	}

	if !r.Related {
		var filtered []Resource
		for _, e := range existing {
			if e.Type != r.Type || e.Related {
				filtered = append(filtered, e)
			} else {
				e.Related = true
				filtered = append(filtered, e)
			}
		}
		existing = filtered
	}

	existing = append(existing, r)
	return Save(worktreePath, existing)
}

func Remove(worktreePath string, resType, id string) error {
	existing, err := Load(worktreePath)
	if err != nil {
		return err
	}

	var filtered []Resource
	for _, r := range existing {
		if !(r.Type == resType && r.ID == id) {
			filtered = append(filtered, r)
		}
	}
	return Save(worktreePath, filtered)
}

func PrimaryOfType(resources []Resource, resType string) *Resource {
	for _, r := range resources {
		if r.Type == resType && !r.Related {
			return &r
		}
	}
	return nil
}

func OfType(resources []Resource, resType string) []Resource {
	var result []Resource
	for _, r := range resources {
		if r.Type == resType {
			result = append(result, r)
		}
	}
	return result
}

func parseLine(line string) (Resource, error) {
	var r Resource
	if strings.HasPrefix(line, "~ ") {
		r.Related = true
		line = line[2:]
	}

	parts := strings.SplitN(line, " ", 2)
	if len(parts) != 2 {
		return r, fmt.Errorf("invalid resource line: %s", line)
	}

	typeID := parts[0]
	r.URL = parts[1]

	colonIdx := strings.Index(typeID, ":")
	if colonIdx < 0 {
		return r, fmt.Errorf("invalid resource type:id: %s", typeID)
	}
	r.Type = typeID[:colonIdx]
	r.ID = typeID[colonIdx+1:]

	return r, nil
}
