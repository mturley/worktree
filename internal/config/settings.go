package config

// SetCmuxFeaturesDisabled writes ui.cmux_features_disabled to the config file
// at path, removing the key when disabled is false (absent is the default).
// Every other key, and the user's comments, survive.
func SetCmuxFeaturesDisabled(path string, disabled bool) error {
	cur, _, err := ReadEditable(path)
	if err != nil {
		return err
	}
	cur.CmuxFeaturesDisabled = disabled
	_, err = WriteEditable(path, cur)
	return err
}
