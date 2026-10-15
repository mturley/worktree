package webui

// settingsKeyPaths lists, per file, every YAML key path the Settings modal
// reads and writes. settings_keys_test.go compares it with the config
// structs' yaml tags, so adding a key to any of the three files fails the
// build's tests until the modal handles it (see CLAUDE.md "Settings modal").
var settingsKeyPaths = map[string][]string{
	"worktree": {
		"worktrees_base",
		"editor",
		"jira.projects",
		"jira.alias_hosts",
		"ui.password", // write-only: PUT /api/settings/password
		"ui.https_port",
		"ui.allowed_hosts",
		"ui.tls.cert_file",
		"ui.tls.key_file",
		"ui.cmux_features_disabled",
		"ui.remote_access_disabled", // UI Access tab toggle, inverted
		"watchers.github",           // Connected Services sub-tab toggles
		"watchers.jira",
		"watchers.slack",
	},
	"watcher_auth": {
		"services.github.token", // write-only: credentials endpoints
		"services.jira.host",
		"services.jira.email",
		"services.jira.token",   // write-only
		"services.slack.token",  // write-only
		"services.slack.cookie", // write-only
		"services.slack.workspace_domain",
	},
	"watcher_config": {
		"jira.bot_usernames",
		"jira.custom_fields",
	},
}

// settingsKeyExclusions are keys the modal deliberately never shows.
var settingsKeyExclusions = map[string]map[string]bool{
	"watcher_auth": {
		"consumers":          true, // owned by `worktree setup`; a DB path is not a user setting
		"jira_custom_fields": true, // legacy; custom fields belong in watcher config.yaml
	},
}
