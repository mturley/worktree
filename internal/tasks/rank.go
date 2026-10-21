// Package tasks holds the Tasks feature: to-do items and their ordering.
package tasks

import (
	"errors"
	"strings"
)

// alphabet is base-62 in ASCII order, so string comparison of keys is numeric
// comparison of the fraction 0.<digits>.
const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

const base = len(alphabet)

func idx(c byte) int { return strings.IndexByte(alphabet, c) }

// digitAt returns a's digit at position n, or '0' past the end.
func digitAt(a string, n int) byte {
	if n < len(a) {
		return a[n]
	}
	return alphabet[0]
}

// tail returns a[n:], or "" when n is past the end.
func tail(a string, n int) string {
	if n >= len(a) {
		return ""
	}
	return a[n:]
}

// midpoint returns a digit string strictly between a and b (b == "" means 1.0).
func midpoint(a, b string) string {
	if b != "" {
		n := 0 // shared prefix, treating a's missing digits as '0'
		for n < len(b) && digitAt(a, n) == b[n] {
			n++
		}
		if n > 0 {
			return b[:n] + midpoint(tail(a, n), b[n:])
		}
	}
	da := 0
	if a != "" {
		da = idx(a[0])
	}
	db := base
	if b != "" {
		db = idx(b[0])
	}
	if db-da > 1 {
		return string(alphabet[(da+db)/2])
	}
	if b != "" && len(b) > 1 {
		return b[:1]
	}
	return string(alphabet[da]) + midpoint(tail(a, 1), "")
}

// KeyBetween returns a key strictly between a and b under plain string
// comparison. "" for a means before everything; "" for b means after
// everything. It errors when both are set and a >= b.
//
// Repeated appends at the bottom (KeyBetween(last, "")) grow keys linearly,
// by about one character per six appends, since each halves the gap to the
// end. That is fine at to-do-list scale. Keys are opaque to everything
// outside this package, so a rebalance (rewriting every rank evenly spaced)
// can be added later without a schema migration.
func KeyBetween(a, b string) (string, error) {
	if a != "" && b != "" && a >= b {
		return "", errors.New("tasks: KeyBetween requires a < b")
	}
	return midpoint(a, b), nil
}
