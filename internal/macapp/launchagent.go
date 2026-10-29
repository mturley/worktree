package macapp

import (
	"path/filepath"
	"strings"
)

var plistEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")

// LaunchAgentPlist is the ~/Library/LaunchAgents plist that starts the app at
// login. Its presence is the only record that the user wants that.
//
// KEEP IN SYNC with LoginItem.swift (app/LoginItem.swift), which writes the
// same bytes when the user ticks "Open at login";
// TestLoginItemSwiftMatchesLaunchAgentPlist compares the two.
func LaunchAgentPlist(appPath string) []byte {
	executable := plistEscaper.Replace(filepath.Join(appPath, "Contents", "MacOS", ExecName))
	return []byte(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>` + BundleID + `</string>
	<key>ProgramArguments</key>
	<array>
		<string>` + executable + `</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
</dict>
</plist>
`)
}
