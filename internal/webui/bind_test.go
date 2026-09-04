package webui

import "testing"

func TestListenAddr_EmptyBindDefaultsToLoopback(t *testing.T) {
	s := &Server{Port: 8475}
	if got, want := s.listenAddr(), "127.0.0.1:8475"; got != want {
		t.Fatalf("listenAddr() = %q, want %q", got, want)
	}
}

func TestListenAddr_ExplicitBind(t *testing.T) {
	s := &Server{Port: 8475, Bind: "0.0.0.0"}
	if got, want := s.listenAddr(), "0.0.0.0:8475"; got != want {
		t.Fatalf("listenAddr() = %q, want %q", got, want)
	}
}

func TestListenAddr_IPv6BindIsBracketed(t *testing.T) {
	s := &Server{Port: 8475, Bind: "::"}
	if got, want := s.listenAddr(), "[::]:8475"; got != want {
		t.Fatalf("listenAddr() = %q, want %q", got, want)
	}
}
