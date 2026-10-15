package config

import (
	"slices"

	"gopkg.in/yaml.v3"
)

// Editable is every non-secret key of config.yaml as written in the file:
// no ~ expansion and no environment overrides, so saving it back never
// rewrites a value the user didn't touch. The UI's settings modal edits it.
//
// When a key is added to Config, add it here (or to ui.password-style
// secret handling) and to the settings modal: internal/webui/settings_keys_test.go
// fails until you add it to settingsKeyPaths in internal/webui/settings_keys.go.
type Editable struct {
	WorktreesBase        string
	Editor               string
	JiraProjects         []string
	JiraAliasHosts       []string
	HTTPSPort            int
	AllowedHosts         []string
	TLSCertFile          string
	TLSKeyFile           string
	CmuxFeaturesDisabled bool
	// WatchersDisabled holds the services (config.Services) whose watcher
	// is off; absent from the map means on.
	WatchersDisabled map[string]bool
}

// WatcherEnabled reports whether svc's watcher is on.
func (e Editable) WatcherEnabled(svc string) bool { return !e.WatchersDisabled[svc] }

// ReadEditable reads path's editable values, and whether ui.password is set.
// A missing file yields defaults. HTTPSPort is DefaultHTTPSPort when unset.
func ReadEditable(path string) (Editable, bool, error) {
	doc, err := readDoc(path)
	if err != nil {
		return Editable{}, false, err
	}
	return editableFromDoc(doc)
}

// editableFromDoc extracts the editable values from an already-parsed doc.
func editableFromDoc(doc *yaml.Node) (Editable, bool, error) {
	var raw Config
	if err := doc.Decode(&raw); err != nil {
		return Editable{}, false, err
	}
	e := Editable{
		WorktreesBase:        raw.WorktreesBase,
		Editor:               raw.Editor,
		JiraProjects:         raw.Jira.Projects,
		JiraAliasHosts:       raw.Jira.AliasHosts,
		HTTPSPort:            raw.UI.HTTPSPort,
		AllowedHosts:         raw.UI.AllowedHosts,
		TLSCertFile:          raw.UI.TLS.CertFile,
		TLSKeyFile:           raw.UI.TLS.KeyFile,
		CmuxFeaturesDisabled: raw.UI.CmuxFeaturesDisabled,
		WatchersDisabled:     map[string]bool{},
	}
	for _, svc := range Services {
		if !raw.Watchers.Enabled(svc) {
			e.WatchersDisabled[svc] = true
		}
	}
	if e.HTTPSPort == 0 {
		e.HTTPSPort = DefaultHTTPSPort
	}
	return e, raw.UI.Password != "", nil
}

// WriteEditable writes the fields of next that differ from the file, and
// nothing else. Zero/default values delete their key (and any mapping left
// empty). changed is false, and the file untouched, when nothing differs.
func WriteEditable(path string, next Editable) (bool, error) {
	doc, err := readDoc(path)
	if err != nil {
		return false, err
	}
	cur, _, err := editableFromDoc(doc)
	if err != nil {
		return false, err
	}
	root := doc.Content[0]
	changed := false
	str := func(old, val string, keys ...string) error {
		if old == val {
			return nil
		}
		changed = true
		if val == "" {
			deletePath(root, keys...)
			return nil
		}
		return setPath(root, scalar(val), keys...)
	}
	list := func(old, val []string, keys ...string) error {
		if slices.Equal(old, val) {
			return nil
		}
		changed = true
		if len(val) == 0 {
			deletePath(root, keys...)
			return nil
		}
		return setPath(root, seqNode(val), keys...)
	}
	steps := []func() error{
		func() error { return str(cur.WorktreesBase, next.WorktreesBase, "worktrees_base") },
		func() error { return str(cur.Editor, next.Editor, "editor") },
		func() error { return list(cur.JiraProjects, next.JiraProjects, "jira", "projects") },
		func() error { return list(cur.JiraAliasHosts, next.JiraAliasHosts, "jira", "alias_hosts") },
		func() error { return list(cur.AllowedHosts, next.AllowedHosts, "ui", "allowed_hosts") },
		func() error { return str(cur.TLSCertFile, next.TLSCertFile, "ui", "tls", "cert_file") },
		func() error { return str(cur.TLSKeyFile, next.TLSKeyFile, "ui", "tls", "key_file") },
		func() error {
			if cur.HTTPSPort == next.HTTPSPort {
				return nil
			}
			changed = true
			if next.HTTPSPort == 0 || next.HTTPSPort == DefaultHTTPSPort {
				deletePath(root, "ui", "https_port")
				return nil
			}
			return setPath(root, intNode(next.HTTPSPort), "ui", "https_port")
		},
		func() error {
			if cur.CmuxFeaturesDisabled == next.CmuxFeaturesDisabled {
				return nil
			}
			changed = true
			if !next.CmuxFeaturesDisabled {
				deletePath(root, "ui", "cmux_features_disabled")
				return nil
			}
			return setPath(root, boolNode(true), "ui", "cmux_features_disabled")
		},
	}
	for _, svc := range Services {
		svc := svc
		steps = append(steps, func() error {
			if cur.WatcherEnabled(svc) == next.WatcherEnabled(svc) {
				return nil
			}
			changed = true
			if next.WatcherEnabled(svc) {
				deletePath(root, "watchers", svc)
				return nil
			}
			return setPath(root, boolNode(false), "watchers", svc)
		})
	}
	for _, step := range steps {
		if err := step(); err != nil {
			return false, err
		}
	}
	if !changed {
		return false, nil
	}
	return true, writeDoc(path, doc)
}

// SetPassword writes ui.password. The password is never readable through
// Editable.
func SetPassword(path, password string) error {
	doc, err := readDoc(path)
	if err != nil {
		return err
	}
	if err := setPath(doc.Content[0], scalar(password), "ui", "password"); err != nil {
		return err
	}
	return writeDoc(path, doc)
}
