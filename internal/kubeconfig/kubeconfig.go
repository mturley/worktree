// Package kubeconfig reads the current context out of a kubeconfig file:
// which cluster, as which user, in which namespace. It reads the file only;
// it never contacts a cluster, and never returns credentials.
package kubeconfig

import (
	"errors"
	"io/fs"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// State says whether there is a current context to show.
type State string

const (
	StateOK        State = "ok"
	StateMissing   State = "missing"    // no file at the path
	StateNoContext State = "no_context" // unreadable, or current-context names nothing
)

// Info is the current context. Cluster and User are nil when the context
// names a cluster or user the file doesn't define.
type Info struct {
	State     State   `json:"state"`
	Cluster   *string `json:"cluster,omitempty"` // the cluster's API server URL
	User      *string `json:"user,omitempty"`
	Namespace string  `json:"namespace,omitempty"`
}

// The few fields read; everything else, credentials included, is never decoded.
type file struct {
	CurrentContext string `yaml:"current-context"`
	Clusters       []struct {
		Name    string `yaml:"name"`
		Cluster struct {
			Server string `yaml:"server"`
		} `yaml:"cluster"`
	} `yaml:"clusters"`
	Contexts []struct {
		Name    string `yaml:"name"`
		Context struct {
			Cluster   string `yaml:"cluster"`
			User      string `yaml:"user"`
			Namespace string `yaml:"namespace"`
		} `yaml:"context"`
	} `yaml:"contexts"`
	Users []struct {
		Name string `yaml:"name"`
	} `yaml:"users"`
}

// Read returns the current context of the kubeconfig at path. A file that
// doesn't parse, or whose fields have the wrong types, has no usable context.
func Read(path string) Info {
	if path == "" {
		return Info{State: StateMissing}
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Info{State: StateMissing}
	}
	var f file
	if err != nil || yaml.Unmarshal(data, &f) != nil || f.CurrentContext == "" {
		return Info{State: StateNoContext}
	}
	for _, c := range f.Contexts {
		if c.Name != f.CurrentContext {
			continue
		}
		info := Info{State: StateOK, Namespace: c.Context.Namespace}
		for _, cl := range f.Clusters {
			if cl.Name == c.Context.Cluster && cl.Cluster.Server != "" {
				server := cl.Cluster.Server
				info.Cluster = &server
				break
			}
		}
		for _, u := range f.Users {
			if u.Name == c.Context.User {
				// `oc login` names user entries "<user>/<cluster>"; show the user.
				name := strings.TrimSuffix(u.Name, "/"+c.Context.Cluster)
				info.User = &name
				break
			}
		}
		return info
	}
	return Info{State: StateNoContext}
}
