package webui

// settingsKeyPaths lists, per file, every YAML key path the Settings modal
// reads and writes. settings_keys_test.go compares it with the config
// structs' yaml tags, so adding a key to either file fails the
// build's tests until the modal handles it (see CLAUDE.md "Settings modal").
var settingsKeyPaths = map[string][]string{
	"worktree": {
		"worktrees_base",
		"editor",
		"jira.projects",
		"jira.alias_hosts",
		"github.bot_usernames", // Connected Services sub-tabs (watcher-config PUT)
		"jira.bot_usernames",
		"jira.custom_fields",
		"ui.password", // write-only: PUT /api/settings/password
		"ui.https_port",
		"ui.allowed_hosts",
		"ui.tls.cert_file",
		"ui.tls.key_file",
		"ui.cmux_features_disabled",
		"ui.port_scan_disabled",     // General tab toggle, inverted
		"ui.remote_access_disabled", // UI Access tab toggle, inverted
		"watchers.github",           // Connected Services sub-tab toggles
		"watchers.jira",
		"watchers.slack",
		"notifications.disabled", // Notifications tab, inverted
		"notifications.command_enabled",
		"notifications.command",
		"git.background_fetch", // General tab
		"git.fetch_interval",
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
}

// settingsKeyExclusions are keys the modal deliberately never shows.
var settingsKeyExclusions = map[string]map[string]bool{}
