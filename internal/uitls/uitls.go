// Package uitls issues the web UI's HTTPS certificate.
//
// It creates a CA and, in the same call, uses it to sign exactly one server
// certificate. The CA's private key is a local variable of Generate and is
// never serialised: once Generate returns, nothing can sign another
// certificate under that CA. The phone trusts a CA (Android's user store
// accepts nothing else), but that CA's reach is the one leaf it already
// signed.
package uitls

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"io/fs"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	CAValidity   = 400 * 24 * time.Hour
	LeafValidity = 397 * 24 * time.Hour
	CACommonName = "worktree local UI CA"
)

// loopbackNames are in every leaf, so the HTTPS listener also works from the
// machine itself.
var loopbackNames = []string{"localhost", "127.0.0.1", "::1"}

type Bundle struct {
	CACertPEM []byte
	CertPEM   []byte
	KeyPEM    []byte // the leaf's key; there is no CA key to return
	NotAfter  time.Time
}

type Paths struct {
	CA   string
	Cert string
	Key  string
}

func DefaultPaths(dir string) Paths {
	return Paths{
		CA:   filepath.Join(dir, "ui-ca.pem"),
		Cert: filepath.Join(dir, "ui-cert.pem"),
		Key:  filepath.Join(dir, "ui-key.pem"),
	}
}

// Generate creates a CA and one server certificate for the loopback names
// plus hosts. An IP in hosts becomes an IP SAN and anything else a DNS SAN.
func Generate(hosts []string, now time.Time) (Bundle, error) {
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return Bundle{}, err
	}
	caSerial, err := serialNumber()
	if err != nil {
		return Bundle{}, err
	}
	caTmpl := &x509.Certificate{
		SerialNumber:          caSerial,
		Subject:               pkix.Name{CommonName: CACommonName},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(CAValidity),
		IsCA:                  true,
		BasicConstraintsValid: true,
		MaxPathLen:            0,
		MaxPathLenZero:        true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	if err != nil {
		return Bundle{}, err
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		return Bundle{}, err
	}

	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return Bundle{}, err
	}
	leafSerial, err := serialNumber()
	if err != nil {
		return Bundle{}, err
	}
	leafTmpl := &x509.Certificate{
		SerialNumber: leafSerial,
		Subject:      pkix.Name{CommonName: "worktree UI"},
		// An hour of back-dating tolerates a phone clock slightly behind.
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(LeafValidity),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	seen := map[string]bool{}
	for _, h := range append(append([]string{}, loopbackNames...), hosts...) {
		h = strings.TrimSpace(h)
		if h == "" {
			continue
		}
		if ip := net.ParseIP(h); ip != nil {
			key := ip.String()
			if !seen[key] {
				seen[key] = true
				leafTmpl.IPAddresses = append(leafTmpl.IPAddresses, ip)
			}
			continue
		}
		key := strings.ToLower(h)
		if !seen[key] {
			seen[key] = true
			leafTmpl.DNSNames = append(leafTmpl.DNSNames, h)
		}
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTmpl, caCert, &leafKey.PublicKey, caKey)
	if err != nil {
		return Bundle{}, err
	}
	keyDER, err := x509.MarshalECPrivateKey(leafKey)
	if err != nil {
		return Bundle{}, err
	}
	return Bundle{
		CACertPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}),
		CertPEM:   pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER}),
		KeyPEM:    pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}),
		NotAfter:  leafTmpl.NotAfter,
	}, nil
}

func serialNumber() (*big.Int, error) {
	return rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
}

// Write stores the bundle: the key 0600, the certificates 0644.
func Write(p Paths, b Bundle) error {
	for _, f := range []struct {
		path string
		data []byte
		mode os.FileMode
	}{
		{p.Key, b.KeyPEM, 0o600},
		{p.Cert, b.CertPEM, 0o644},
		{p.CA, b.CACertPEM, 0o644},
	} {
		if err := os.MkdirAll(filepath.Dir(f.path), 0o755); err != nil {
			return err
		}
		if err := writeExclusive(f.path, f.data, f.mode); err != nil {
			return fmt.Errorf("writing %s: %w", f.path, err)
		}
	}
	return nil
}

// writeExclusive replaces path with a file created at mode, so a key is never
// readable, even briefly, under an earlier file's looser mode.
func writeExclusive(path string, data []byte, mode os.FileMode) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	// The umask can narrow the mode OpenFile applied; set it exactly.
	return os.Chmod(path, mode)
}

// Remove deletes whichever of the three files exist and returns their paths.
func Remove(p Paths) ([]string, error) {
	var removed []string
	for _, path := range []string{p.CA, p.Cert, p.Key} {
		err := os.Remove(path)
		switch {
		case err == nil:
			removed = append(removed, path)
		case errors.Is(err, fs.ErrNotExist):
		default:
			return removed, err
		}
	}
	return removed, nil
}

func ReadCert(path string) (*x509.Certificate, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, fmt.Errorf("%s: no certificate found", path)
	}
	return x509.ParseCertificate(block.Bytes)
}

// Uncovered returns the names cert is not valid for, in the order given.
func Uncovered(cert *x509.Certificate, names []string) []string {
	var out []string
	for _, n := range names {
		if cert.VerifyHostname(n) != nil {
			out = append(out, n)
		}
	}
	return out
}
