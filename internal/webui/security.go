package webui

import (
	"errors"

	"github.com/mturley/worktree/internal/uisession"
)

// Security is the web UI's authentication and remote-access configuration.
// Start and Serve refuse to open a listener without it.
type Security struct {
	// Password is what POST /api/login checks. Required.
	Password string
	// Sessions stores logins. Required.
	Sessions *uisession.Store
	// AllowedHosts are accepted in the Host header, beyond the loopback
	// names that always are. They match the certificate's names.
	AllowedHosts []string
	// CertFile and KeyFile, both set, enable the HTTPS listener.
	CertFile string
	KeyFile  string
	// HTTPSPort is where that listener binds, on every interface.
	HTTPSPort int
}

// Remote reports whether the HTTPS listener for other devices is configured.
func (sec *Security) Remote() bool {
	return sec != nil && sec.CertFile != "" && sec.KeyFile != ""
}

func (sec *Security) validate() error {
	if sec == nil || sec.Password == "" || sec.Sessions == nil {
		return errors.New("webui: refusing to serve without authentication configured")
	}
	return nil
}
