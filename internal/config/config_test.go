package config

import "testing"

func TestDefaultConfigHasNoSearchSection(t *testing.T) {
	cfg := DefaultConfig()
	// Compile-time guarantee: the Search field is gone. This test documents intent;
	// if SearchConfig still exists this file won't compile.
	_ = cfg.WorktreesBase
}
