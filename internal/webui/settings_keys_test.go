package webui

import (
	"encoding"
	"reflect"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	wconfig "github.com/mturley/watcher/config"
	"github.com/mturley/worktree/internal/config"
	"gopkg.in/yaml.v3"
)

var (
	yamlUnmarshalerType = reflect.TypeOf((*yaml.Unmarshaler)(nil)).Elem()
	textUnmarshalerType = reflect.TypeOf((*encoding.TextUnmarshaler)(nil)).Elem()
	timeType            = reflect.TypeOf(time.Time{})
)

// isLeafStruct reports whether a struct type is decoded as a single value
// rather than as a mapping of keys: time.Time, and any type with its own
// YAML or text unmarshaling (checked on T and *T).
func isLeafStruct(t reflect.Type) bool {
	if t == timeType {
		return true
	}
	ptr := reflect.PointerTo(t)
	return t.Implements(yamlUnmarshalerType) || ptr.Implements(yamlUnmarshalerType) ||
		t.Implements(textUnmarshalerType) || ptr.Implements(textUnmarshalerType)
}

// yamlPaths lists every leaf key path of t's YAML fields, following yaml.v3's
// naming: unexported fields and `yaml:"-"` are skipped, an empty tag name is
// the lowercased field name, and `,inline` structs merge into the parent.
// Structs (and pointers to them) recurse unless they are leaf structs (see
// isLeafStruct); anything else — scalars, slices, maps — is a leaf the modal
// edits as a whole.
func yamlPaths(t reflect.Type, prefix string) []string {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	var out []string
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if !f.IsExported() {
			continue
		}
		tag := f.Tag.Get("yaml")
		if tag == "-" {
			continue
		}
		parts := strings.Split(tag, ",")
		name := parts[0]
		if name == "" {
			name = strings.ToLower(f.Name)
		}
		ft := f.Type
		for ft.Kind() == reflect.Pointer {
			ft = ft.Elem()
		}
		isStruct := ft.Kind() == reflect.Struct && !isLeafStruct(ft)
		if isStruct && slices.Contains(parts[1:], "inline") {
			out = append(out, yamlPaths(ft, prefix)...)
			continue
		}
		path := name
		if prefix != "" {
			path = prefix + "." + name
		}
		if isStruct {
			out = append(out, yamlPaths(ft, path)...)
		} else {
			out = append(out, path)
		}
	}
	return out
}

type leafUnmarshaler struct {
	A string `yaml:"a"`
}

func (*leafUnmarshaler) UnmarshalYAML(*yaml.Node) error { return nil }

type Base struct {
	Y string `yaml:"y"`
}

type Embedded struct {
	Z string `yaml:"z"`
}

func TestYamlPathsFollowsYamlV3Rules(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		typ  reflect.Type
		want []string
	}{
		{
			name: "untagged, omitempty-only and skipped and unexported fields",
			typ: reflect.TypeOf(struct {
				Foo    string
				Bar    string `yaml:",omitempty"`
				Skip   string `yaml:"-"`
				hidden string
			}{}),
			want: []string{"foo", "bar"},
		},
		{
			name: "pointer to struct recurses",
			typ: reflect.TypeOf(struct {
				Child *struct {
					X string `yaml:"x"`
				} `yaml:"child"`
			}{}),
			want: []string{"child.x"},
		},
		{
			name: "inline struct merges into parent",
			typ: reflect.TypeOf(struct {
				Base `yaml:",inline"`
				Q    string `yaml:"q"`
			}{}),
			want: []string{"y", "q"},
		},
		{
			name: "map and slice are leaves",
			typ: reflect.TypeOf(struct {
				M map[string]string `yaml:"m"`
				S []string          `yaml:"s"`
			}{}),
			want: []string{"m", "s"},
		},
		{
			name: "time.Time and unmarshaler structs are leaves",
			typ: reflect.TypeOf(struct {
				T time.Time        `yaml:"t"`
				U leafUnmarshaler  `yaml:"u"`
				P *leafUnmarshaler `yaml:"p"`
			}{}),
			want: []string{"t", "u", "p"},
		},
		{
			name: "untagged struct field is lowercased and recurses",
			typ: reflect.TypeOf(struct {
				Embedded
			}{}),
			want: []string{"embedded.z"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := yamlPaths(tc.typ, "")
			sort.Strings(got)
			want := append([]string{}, tc.want...)
			sort.Strings(want)
			if !reflect.DeepEqual(got, want) {
				t.Errorf("yamlPaths = %v, want %v", got, want)
			}
		})
	}
}

func TestSettingsModalCoversEveryConfigKey(t *testing.T) {
	t.Parallel()
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
