package webui

import "testing"

func TestListenAddrIsAlwaysLoopback(t *testing.T) {
	s := &Server{Port: 8475}
	if got, want := s.listenAddr(), "127.0.0.1:8475"; got != want {
		t.Fatalf("listenAddr() = %q, want %q", got, want)
	}
}
