package tasks

import (
	"strings"
	"testing"
)

func TestKeyBetweenOrders(t *testing.T) {
	cases := [][2]string{{"", ""}, {"", "V"}, {"V", ""}, {"V", "W"}, {"V", "V1"}, {"Vz", "W"}, {"1", "2"}}
	for _, c := range cases {
		k, err := KeyBetween(c[0], c[1])
		if err != nil {
			t.Fatalf("%q,%q: %v", c[0], c[1], err)
		}
		if (c[0] != "" && !(c[0] < k)) || (c[1] != "" && !(k < c[1])) {
			t.Fatalf("KeyBetween(%q,%q) = %q not strictly between", c[0], c[1], k)
		}
		if strings.HasSuffix(k, "0") {
			t.Fatalf("key %q ends in the zero digit", k)
		}
	}
}

func TestKeyBetweenRepeatedInsertStaysOrdered(t *testing.T) {
	a, b := "", "V"
	for i := 0; i < 200; i++ {
		k, err := KeyBetween(a, b)
		if err != nil || !(k < b) || (a != "" && !(a < k)) {
			t.Fatalf("iter %d: %q (%v)", i, k, err)
		}
		b = k // always insert at the very top
	}
	a, b = "V", "W"
	for i := 0; i < 200; i++ {
		k, _ := KeyBetween(a, b)
		if !(a < k && k < b) {
			t.Fatalf("iter %d: %q", i, k)
		}
		a = k // always insert just above "W"
	}
}

func TestKeyBetweenRejectsInverted(t *testing.T) {
	if _, err := KeyBetween("W", "V"); err == nil {
		t.Fatal("want error")
	}
	if _, err := KeyBetween("V", "V"); err == nil {
		t.Fatal("want error")
	}
}
