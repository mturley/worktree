package webui

import (
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/uisession"
	"github.com/mturley/worktree/internal/uitls"
)

func TestStartRefusesWithoutAuthentication(t *testing.T) {
	for name, sec := range map[string]*Security{
		"nil":         nil,
		"no password": {Sessions: &uisession.Store{}},
		"no sessions": {Password: "pw"},
	} {
		err := (&Server{Port: 0, Security: sec}).Start()
		if err == nil || !strings.Contains(err.Error(), "authentication") {
			t.Errorf("%s: Start() = %v, want a refusal naming authentication", name, err)
		}
	}
}

// securedForListen builds a Server with a working session store and, when
// withTLS is set, a freshly issued certificate.
func securedForListen(t *testing.T, withTLS bool) (*Server, []byte) {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	sec := &Security{Password: "pw", Sessions: &uisession.Store{DB: conn}}
	var caPEM []byte
	if withTLS {
		b, err := uitls.Generate(nil, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		p := uitls.DefaultPaths(t.TempDir())
		if err := uitls.Write(p, b); err != nil {
			t.Fatal(err)
		}
		sec.CertFile, sec.KeyFile = p.Cert, p.Key
		caPEM = b.CACertPEM
	}
	srv := &Server{
		DB:       conn,
		WebFS:    fstest.MapFS{"index.html": {Data: []byte("<!doctype html>ok")}},
		Security: sec,
	}
	return srv, caPEM
}

func listenLoopback(t *testing.T) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	return ln
}

func TestServeSpeaksHTTPOnLoopbackAndTLSOnTheRemotePort(t *testing.T) {
	srv, caPEM := securedForListen(t, true)
	httpLn, httpsLn := listenLoopback(t), listenLoopback(t)
	done := make(chan error, 1)
	go func() { done <- srv.Serve(httpLn, httpsLn) }()
	t.Cleanup(func() {
		httpLn.Close()
		httpsLn.Close()
		<-done
	})

	plain := &http.Client{Timeout: 5 * time.Second}

	// Loopback listener: plain HTTP.
	resp, err := plain.Get("http://" + httpLn.Addr().String() + "/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("HTTP listener: status %d, want 200", resp.StatusCode)
	}

	// Remote listener: plain HTTP is answered with Go's TLS-server refusal.
	resp, err = plain.Get("http://" + httpsLn.Addr().String() + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(body), "HTTPS server") {
		t.Fatalf("plain HTTP to the TLS port: %d %q, want Go's 400 HTTP-to-HTTPS refusal", resp.StatusCode, body)
	}

	// Remote listener: TLS, verified against the generated CA.
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(caPEM)
	secure := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{
		TLSClientConfig: &tls.Config{RootCAs: pool},
	}}
	resp, err = secure.Get("https://" + httpsLn.Addr().String() + "/")
	if err != nil {
		t.Fatalf("HTTPS listener: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("HTTPS listener: status %d, want 200", resp.StatusCode)
	}
}

func TestServeWithoutRemoteServesOnlyHTTP(t *testing.T) {
	srv, _ := securedForListen(t, false)
	if srv.Security.Remote() {
		t.Fatal("Remote() = true with no certificate")
	}
	httpLn := listenLoopback(t)
	done := make(chan error, 1)
	go func() { done <- srv.Serve(httpLn, nil) }()
	t.Cleanup(func() { httpLn.Close(); <-done })
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Get("http://" + httpLn.Addr().String() + "/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d, want 200", resp.StatusCode)
	}
}

func TestServeFailsOnAMissingCertificate(t *testing.T) {
	srv, _ := securedForListen(t, false)
	srv.Security.CertFile = filepath.Join(t.TempDir(), "missing-cert.pem")
	srv.Security.KeyFile = filepath.Join(t.TempDir(), "missing-key.pem")
	httpLn, httpsLn := listenLoopback(t), listenLoopback(t)
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(httpLn, httpsLn) }()
	select {
	case err := <-errc:
		if err == nil {
			t.Fatal("Serve returned nil with a missing certificate")
		}
	case <-time.After(5 * time.Second):
		httpLn.Close()
		httpsLn.Close()
		t.Fatal("Serve kept running with a missing certificate")
	}
}
