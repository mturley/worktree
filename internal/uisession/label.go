package uisession

import "strings"

const maxLabelLen = 80

// Label names a session after the device and browser that logged in, e.g.
// "Mac — Chrome", so the list of devices is legible. Best-effort: an agent it
// does not recognise is kept verbatim, truncated.
func Label(userAgent string) string {
	ua := userAgent
	// Order matters: Android agents also say "Linux", Chrome and Edge
	// agents also say "Safari", and Edge agents also say "Chrome".
	var device string
	switch {
	case strings.Contains(ua, "iPhone"):
		device = "iPhone"
	case strings.Contains(ua, "iPad"):
		device = "iPad"
	case strings.Contains(ua, "Android"):
		device = "Android"
	case strings.Contains(ua, "Macintosh"):
		device = "Mac"
	case strings.Contains(ua, "Windows"):
		device = "Windows"
	case strings.Contains(ua, "Linux"):
		device = "Linux"
	}
	var browser string
	switch {
	case strings.Contains(ua, "Edg/"):
		browser = "Edge"
	case strings.Contains(ua, "Firefox/"), strings.Contains(ua, "FxiOS/"):
		browser = "Firefox"
	case strings.Contains(ua, "Chrome/"), strings.Contains(ua, "CriOS/"):
		browser = "Chrome"
	case strings.Contains(ua, "Safari/"):
		browser = "Safari"
	}
	if device != "" && browser != "" {
		return device + " — " + browser
	}
	ua = strings.TrimSpace(ua)
	if ua == "" {
		return "Unknown device"
	}
	if r := []rune(ua); len(r) > maxLabelLen {
		return string(r[:maxLabelLen])
	}
	return ua
}
