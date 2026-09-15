package uitls

import (
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/pem"
	"net"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"
)

var now = time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)

func parseCert(t *testing.T, pemBytes []byte) *x509.Certificate {
	t.Helper()
	block, _ := pem.Decode(pemBytes)
	if block == nil || block.Type != "CERTIFICATE" {
		t.Fatalf("not a certificate PEM: %q", pemBytes)
	}
	c, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestGenerateLeafNamesAndUsage(t *testing.T) {
	b, err := Generate([]string{"mturley-mac.local", "192.168.86.21"}, now)
	if err != nil {
		t.Fatal(err)
	}
	leaf := parseCert(t, b.CertPEM)
	for _, name := range []string{"localhost", "mturley-mac.local"} {
		if !slices.Contains(leaf.DNSNames, name) {
			t.Errorf("DNSNames %v missing %q", leaf.DNSNames, name)
		}
	}
	for _, ip := range []string{"127.0.0.1", "::1", "192.168.86.21"} {
		if !slices.ContainsFunc(leaf.IPAddresses, func(got net.IP) bool { return got.Equal(net.ParseIP(ip)) }) {
			t.Errorf("IPAddresses %v missing %s", leaf.IPAddresses, ip)
		}
	}
	if slices.Contains(leaf.DNSNames, "192.168.86.21") {
		t.Error("an IP was written as a DNS SAN; browsers only match IPs against IP SANs")
	}
	if len(leaf.ExtKeyUsage) != 1 || leaf.ExtKeyUsage[0] != x509.ExtKeyUsageServerAuth {
		t.Errorf("ExtKeyUsage = %v, want [serverAuth]", leaf.ExtKeyUsage)
	}
	if leaf.IsCA {
		t.Error("leaf is a CA")
	}
}

func TestGenerateDeduplicatesNames(t *testing.T) {
	b, err := Generate([]string{"localhost", "127.0.0.1", "mturley-mac.local", "MTURLEY-MAC.local"}, now)
	if err != nil {
		t.Fatal(err)
	}
	leaf := parseCert(t, b.CertPEM)
	if len(leaf.DNSNames) != 2 || len(leaf.IPAddresses) != 2 {
		t.Fatalf("DNSNames %v, IPAddresses %v; want no duplicates", leaf.DNSNames, leaf.IPAddresses)
	}
}

func TestGenerateValidity(t *testing.T) {
	b, err := Generate(nil, now)
	if err != nil {
		t.Fatal(err)
	}
	leaf, ca := parseCert(t, b.CertPEM), parseCert(t, b.CACertPEM)
	if got := leaf.NotAfter.Sub(now); got != LeafValidity {
		t.Errorf("leaf lifetime from now = %v, want %v", got, LeafValidity)
	}
	if span := leaf.NotAfter.Sub(leaf.NotBefore); span >= 398*24*time.Hour {
		t.Errorf("leaf validity span %v reaches the 398-day browser ceiling", span)
	}
	if got := ca.NotAfter.Sub(now); got != CAValidity {
		t.Errorf("CA lifetime from now = %v, want %v", got, CAValidity)
	}
	if !b.NotAfter.Equal(leaf.NotAfter) {
		t.Errorf("Bundle.NotAfter = %v, want the leaf's %v", b.NotAfter, leaf.NotAfter)
	}
}

func TestCAIsASingleLevelCA(t *testing.T) {
	b, err := Generate(nil, now)
	if err != nil {
		t.Fatal(err)
	}
	ca := parseCert(t, b.CACertPEM)
	if !ca.IsCA || !ca.BasicConstraintsValid {
		t.Fatal("CA certificate lacks basicConstraints CA:TRUE, which Android's user store requires")
	}
	if ca.MaxPathLen != 0 || !ca.MaxPathLenZero {
		t.Errorf("MaxPathLen = %d (zero=%v), want 0: the CA may sign leaves only", ca.MaxPathLen, ca.MaxPathLenZero)
	}
	if ca.Subject.CommonName != CACommonName {
		t.Errorf("CA CN = %q, want %q", ca.Subject.CommonName, CACommonName)
	}
}

func TestLeafVerifiesAgainstItsOwnCAOnly(t *testing.T) {
	b, err := Generate([]string{"mturley-mac.local"}, now)
	if err != nil {
		t.Fatal(err)
	}
	other, err := Generate([]string{"mturley-mac.local"}, now)
	if err != nil {
		t.Fatal(err)
	}
	leaf := parseCert(t, b.CertPEM)
	verify := func(caPEM []byte) error {
		pool := x509.NewCertPool()
		pool.AppendCertsFromPEM(caPEM)
		_, err := leaf.Verify(x509.VerifyOptions{Roots: pool, DNSName: "mturley-mac.local", CurrentTime: now})
		return err
	}
	if err := verify(b.CACertPEM); err != nil {
		t.Fatalf("leaf does not verify against its own CA: %v", err)
	}
	if err := verify(other.CACertPEM); err == nil {
		t.Fatal("leaf verified against an unrelated CA")
	}
}

func TestWriteLeavesNoCAPrivateKeyOnDisk(t *testing.T) {
	dir := t.TempDir()
	b, err := Generate([]string{"mturley-mac.local"}, now)
	if err != nil {
		t.Fatal(err)
	}
	p := DefaultPaths(dir)
	if err := Write(p, b); err != nil {
		t.Fatal(err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	if strings.Join(names, ",") != "ui-ca.pem,ui-cert.pem,ui-key.pem" {
		t.Fatalf("directory holds %v, want exactly the three files", names)
	}

	// Every private key on disk, across every file, must belong to the leaf.
	// This is the property the design rests on: the CA can never sign again.
	leaf := parseCert(t, b.CertPEM)
	var keys int
	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		for rest := data; ; {
			var block *pem.Block
			block, rest = pem.Decode(rest)
			if block == nil {
				break
			}
			if !strings.Contains(block.Type, "PRIVATE KEY") {
				continue
			}
			keys++
			key, err := x509.ParseECPrivateKey(block.Bytes)
			if err != nil {
				t.Fatalf("%s: unparseable private key: %v", name, err)
			}
			if !key.PublicKey.Equal(leaf.PublicKey.(*ecdsa.PublicKey)) {
				t.Fatalf("%s holds a private key that is not the leaf's", name)
			}
		}
	}
	if keys != 1 {
		t.Fatalf("found %d private keys on disk, want exactly 1 (the leaf's)", keys)
	}

	for name, want := range map[string]os.FileMode{"ui-key.pem": 0o600, "ui-cert.pem": 0o644, "ui-ca.pem": 0o644} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != want {
			t.Errorf("%s mode = %v, want %v", name, got, want)
		}
	}
}

func TestWriteTightensAnExistingLooseKeyFile(t *testing.T) {
	dir := t.TempDir()
	p := DefaultPaths(dir)
	if err := os.WriteFile(p.Key, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	b, _ := Generate(nil, now)
	if err := Write(p, b); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(p.Key)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("key mode = %v, want 0600", info.Mode().Perm())
	}
}

func TestRemove(t *testing.T) {
	dir := t.TempDir()
	p := DefaultPaths(dir)
	b, _ := Generate(nil, now)
	if err := Write(p, b); err != nil {
		t.Fatal(err)
	}
	removed, err := Remove(p)
	if err != nil || len(removed) != 3 {
		t.Fatalf("Remove = %v, %v; want three files", removed, err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("directory still holds %v", entries)
	}
	removed, err = Remove(p)
	if err != nil || len(removed) != 0 {
		t.Fatalf("second Remove = %v, %v; want nothing and no error", removed, err)
	}
}

func TestReadCertAndUncovered(t *testing.T) {
	dir := t.TempDir()
	p := DefaultPaths(dir)
	b, _ := Generate([]string{"mturley-mac.local", "192.168.86.21"}, now)
	if err := Write(p, b); err != nil {
		t.Fatal(err)
	}
	cert, err := ReadCert(p.Cert)
	if err != nil {
		t.Fatal(err)
	}
	got := Uncovered(cert, []string{"mturley-mac.local", "192.168.86.21", "192.168.1.50", "other.local"})
	if strings.Join(got, ",") != "192.168.1.50,other.local" {
		t.Fatalf("Uncovered = %v", got)
	}
}
