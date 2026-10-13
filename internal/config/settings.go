package config

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// SetCmuxFeaturesDisabled writes ui.cmux_features_disabled to the config file
// at path, removing the key when disabled is false (absent is the default).
//
// It edits the YAML node tree rather than round-tripping a Config, so every
// other key, and the user's comments, survive a toggle from the web UI.
func SetCmuxFeaturesDisabled(path string, disabled bool) error {
	return editUIKey(path, "cmux_features_disabled", disabled)
}

// editUIKey sets ui.<key> to a bool when on, or deletes it when off.
func editUIKey(path, key string, on bool) error {
	var doc yaml.Node
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		if err := yaml.Unmarshal(data, &doc); err != nil {
			return fmt.Errorf("parsing config: %w", err)
		}
	case os.IsNotExist(err):
	default:
		return err
	}
	if doc.Kind == 0 { // missing or empty file
		doc = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode}}}
	}
	root := doc.Content[0]
	if root.Kind != yaml.MappingNode {
		return fmt.Errorf("config: top level is not a mapping")
	}

	ui := mappingValue(root, "ui")
	if ui == nil {
		if !on {
			return nil // nothing to remove
		}
		ui = &yaml.Node{Kind: yaml.MappingNode}
		root.Content = append(root.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: "ui"}, ui)
	}
	if ui.Kind != yaml.MappingNode {
		return fmt.Errorf("config: ui is not a mapping")
	}

	removeMappingKey(ui, key)
	if on {
		ui.Content = append(ui.Content,
			&yaml.Node{Kind: yaml.ScalarNode, Value: key},
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: "true"})
	}

	var buf bytes.Buffer
	// yaml.v3's default 4-space indent, which is what setup's writeConfig
	// produces, so a toggle does not reformat the whole file.
	enc := yaml.NewEncoder(&buf)
	if err := enc.Encode(&doc); err != nil {
		return err
	}
	if err := enc.Close(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	// Owner-only, like setup's writeConfig: the file holds the UI password.
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
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
