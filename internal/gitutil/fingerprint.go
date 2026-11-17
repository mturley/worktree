package gitutil

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
)

// Fingerprint is a cheap digest of "what a diff view would show", polled by
// the web UI to notice changes. Working covers only the working tree (status
// output plus each listed file's size and mtime); Full also folds in HEAD and
// the given refs, so it moves on commits, fetches and branch switches too.
type Fingerprint struct {
	Full    string
	Working string
}

// ComputeFingerprint is WorkingState for callers that need only the
// fingerprint.
func ComputeFingerprint(dir string, refs ...string) (Fingerprint, error) {
	_, fp, err := WorkingState(dir, refs...)
	return fp, err
}

// FullFingerprint is the pure composer behind the Full fingerprint: it hashes
// HEAD, then each of refs (in the given order) with its resolved SHA from
// refSHAs (a ref missing from the map hashes the same as one mapped to ""),
// then the working digest, exactly as WorkingState has always hashed them.
// It starts no process, so a caller holding a BranchStatus/ref-SHA map and a
// working digest already in hand (e.g. from a cache whose ref tier is still
// valid) can rebuild Full without any git call of its own.
func FullFingerprint(headSHA string, refs []string, refSHAs map[string]string, working string) string {
	full := sha256.New()
	fmt.Fprintf(full, "HEAD %s\x00", headSHA)
	for _, ref := range refs {
		fmt.Fprintf(full, "%s %s\x00", ref, refSHAs[ref])
	}
	io.WriteString(full, working)
	return hex.EncodeToString(full.Sum(nil))
}

// WorkingState derives both the Code tab's working-tree counts and the
// fingerprint from ONE `git status` plus one Lstat per changed file — no
// per-file git calls — because it runs every few seconds on large repos.
//
// Status alone is not enough for the fingerprint: re-editing an
// already-modified file leaves its status line unchanged, so each listed
// file's size and mtime are hashed too. Unresolvable refs (and HEAD in a repo
// with no commits) contribute an empty SHA rather than failing.
//
// Unlike ShortStatus it lists every file of an untracked directory, so
// Untracked counts files and Files is the number of distinct changed paths —
// what the Code tab's "N files changed" needs.
func WorkingState(dir string, refs ...string) (WorkingSummary, Fingerprint, error) {
	bs, ws, fp, err := StatusV2(dir)
	if err != nil {
		return WorkingSummary{}, Fingerprint{}, err
	}

	refSHAs := make(map[string]string, len(refs))
	for _, ref := range refs {
		sha, _ := RevSHA(dir, ref)
		refSHAs[ref] = sha
	}
	full := FullFingerprint(bs.HeadSHA, refs, refSHAs, fp.Working)
	return ws, Fingerprint{Full: full, Working: fp.Working}, nil
}
