package webui

import (
	"reflect"
	"sort"
	"strings"
	"testing"

	wconfig "github.com/mturley/watcher/config"
	"github.com/mturley/worktree/internal/config"
)

// yamlPaths lists every leaf key path of t's yaml tags. Structs (and
// pointers to them) recurse; anything else — scalars, slices, maps — is a
// leaf the modal edits as a whole.
func yamlPaths(t reflect.Type, prefix string) []string {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	var out []string
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		name := strings.Split(f.Tag.Get("yaml"), ",")[0]
		if name == "" || name == "-" || !f.IsExported() {
			continue
		}
		path := name
		if prefix != "" {
			path = prefix + "." + name
		}
		ft := f.Type
		for ft.Kind() == reflect.Pointer {
			ft = ft.Elem()
		}
		if ft.Kind() == reflect.Struct {
			out = append(out, yamlPaths(ft, path)...)
		} else {
			out = append(out, path)
		}
	}
	return out
}

func TestSettingsModalCoversEveryConfigKey(t *testing.T) {
	files := map[string]reflect.Type{
		"worktree":       reflect.TypeOf(config.Config{}),
		"watcher_auth":   reflect.TypeOf(wconfig.Config{}),
		"watcher_config": reflect.TypeOf(wconfig.ConfigFile{}),
	}
	for file, typ := range files {
		var want []string
		for _, p := range yamlPaths(typ, "") {
			if !settingsKeyExclusions[file][p] {
				want = append(want, p)
			}
		}
		got := append([]string{}, settingsKeyPaths[file]...)
		sort.Strings(want)
		sort.Strings(got)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s: the Settings modal handles %v but the config has %v.\n"+
				"A config key was added or removed: update the Settings modal (DTO, PUT handler, panel, tests) "+
				"and settingsKeyPaths — or, if it must never be shown, settingsKeyExclusions with a reason.",
				file, got, want)
		}
	}
}
