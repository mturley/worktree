package config

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"gopkg.in/yaml.v3"
)

// Node-tree editing for worktree's config.yaml. Edits go through the parsed
// yaml.Node tree rather than a round-tripped Config, so comments, key order
// and keys this version doesn't know about all survive a save from the UI.

// readDoc parses path into a document node. A missing or empty file yields
// an empty mapping document.
func readDoc(path string) (*yaml.Node, error) {
	var doc yaml.Node
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		if err := yaml.Unmarshal(data, &doc); err != nil {
			return nil, fmt.Errorf("parsing config: %w", err)
		}
	case os.IsNotExist(err):
	default:
		return nil, err
	}
	if doc.Kind == 0 {
		doc = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode}}}
	}
	if doc.Content[0].Kind != yaml.MappingNode {
		return nil, fmt.Errorf("config: top level is not a mapping")
	}
	return &doc, nil
}

// writeDoc encodes doc with yaml.v3's default 4-space indent (what setup's
// writeConfig produces) and writes it owner-only: the file holds the UI
// password.
func writeDoc(path string, doc *yaml.Node) error {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	if err := enc.Encode(doc); err != nil {
		return err
	}
	if err := enc.Close(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

// lookup returns the value node at keys, or nil.
func lookup(root *yaml.Node, keys ...string) *yaml.Node {
	n := root
	for _, k := range keys {
		if n == nil || n.Kind != yaml.MappingNode {
			return nil
		}
		n = mappingValue(n, k)
	}
	return n
}

// setPath sets the value at keys, creating intermediate mappings. A scalar
// replacing a scalar is updated in place so its comments stay attached.
func setPath(root *yaml.Node, val *yaml.Node, keys ...string) error {
	m := root
	for _, k := range keys[:len(keys)-1] {
		next := mappingValue(m, k)
		if next == nil {
			next = &yaml.Node{Kind: yaml.MappingNode}
			m.Content = append(m.Content, scalar(k), next)
		}
		if next.Kind != yaml.MappingNode {
			return fmt.Errorf("config: %s is not a mapping", k)
		}
		m = next
	}
	last := keys[len(keys)-1]
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value != last {
			continue
		}
		old := m.Content[i+1]
		if old.Kind == yaml.ScalarNode && val.Kind == yaml.ScalarNode {
			old.Value, old.Tag, old.Style = val.Value, val.Tag, val.Style
			return nil
		}
		val.LineComment = old.LineComment
		m.Content[i+1] = val
		return nil
	}
	m.Content = append(m.Content, scalar(last), val)
	return nil
}

// deletePath removes the key at keys, then any mapping left empty by it.
func deletePath(root *yaml.Node, keys ...string) {
	if len(keys) == 0 {
		return
	}
	parent := lookup(root, keys[:len(keys)-1]...)
	if parent == nil || parent.Kind != yaml.MappingNode {
		return
	}
	removeMappingKey(parent, keys[len(keys)-1])
	if len(keys) > 1 && len(parent.Content) == 0 {
		deletePath(root, keys[:len(keys)-1]...)
	}
}

func scalar(s string) *yaml.Node { return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: s} }
func intNode(i int) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.Itoa(i)}
}
func boolNode(b bool) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: strconv.FormatBool(b)}
}
func seqNode(items []string) *yaml.Node {
	n := &yaml.Node{Kind: yaml.SequenceNode}
	for _, s := range items {
		n.Content = append(n.Content, scalar(s))
	}
	return n
}

func mappingValue(m *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

func removeMappingKey(m *yaml.Node, key string) {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			m.Content = append(m.Content[:i], m.Content[i+2:]...)
			return
		}
	}
}
