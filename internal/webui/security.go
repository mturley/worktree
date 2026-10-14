package webui

import (
	"errors"
	"sync"

	"github.com/mturley/worktree/internal/uisession"
)

// Security is the web UI's authentication and remote-access configuration.
// Start and Serve refuse to open a listener without it.
type Security struct {
	// Password is what POST /api/login checks. Required. Set it before
	// serving; afterwards read it with password() and change it with
	// SetPassword, which the Settings modal's password replace uses.
	Password string
	pwMu     sync.RWMutex
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
	if sec == nil || sec.password() == "" || sec.Sessions == nil {
		return errors.New("webui: refusing to serve without authentication configured")
	}
	return nil
}

func (sec *Security) password() string {
	sec.pwMu.RLock()
	defer sec.pwMu.RUnlock()
	return sec.Password
}

// SetPassword changes the login password for the running server. Existing
// sessions stay valid.
func (sec *Security) SetPassword(pw string) {
	sec.pwMu.Lock()
	defer sec.pwMu.Unlock()
	sec.Password = pw
}
