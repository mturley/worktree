package webui

// credValidators is filled in by the credentials task.
type credValidators struct{}

// Temporary stubs; the watcher-settings task replaces them.
type watcherAuthSettings struct{}
type watcherConfigSettings struct{}

func (s *Server) readWatcherAuth() (watcherAuthSettings, settingsSecrets, error) {
	return watcherAuthSettings{}, settingsSecrets{}, nil
}

func (s *Server) readWatcherConfig() (watcherConfigSettings, error) {
	return watcherConfigSettings{}, nil
}
