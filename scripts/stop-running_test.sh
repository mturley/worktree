#!/bin/sh
# Tests scripts/stop-running.sh without any real process involved.
#
# SAFETY: `kill` is a shell builtin, so a fake `kill` on PATH would never be
# reached. Instead each scenario runs the script SOURCED by a harness that
# first defines shell functions for pgrep, lsof, kill and sleep; functions
# beat builtins and PATH lookups. The fake `kill` only appends its arguments
# to a log. Fakes are also placed first on PATH as a second layer. Nothing
# here lists or signals a real process.
#
# The interactive branches (reading /dev/tty) are checked by hand.
set -u

here=$(cd "$(dirname "$0")" && pwd)
script="$here/stop-running.sh"
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
failures=0

fail() { echo "FAIL: $*"; failures=$((failures + 1)); }

# new_case <name>: sets $T to a fresh dir with fakes and state files.
#   $T/pids          pids pgrep reports (one per line)
#   $T/jobs          what the fake built binary prints for `jobs --running`
#   $T/dies_on_term  if present, a -TERM empties $T/pids
#   $T/jobs_after_term  if present, a -TERM writes its content to $T/jobs
#   $T/kill.log      every kill invocation's arguments
new_case() {
	T="$root/$1"
	mkdir -p "$T/bin"
	: >"$T/pids"; : >"$T/jobs"; : >"$T/kill.log"
	TARGET="$T/installed/worktree"
	mkdir -p "$T/installed"
	: >"$TARGET"
	cat >"$T/built" <<EOF
#!/bin/sh
[ "\$1 \$2" = "jobs --running" ] || exit 2
cat "$T/jobs"
EOF
	chmod 755 "$T/built"
	# Layer 2: fakes on PATH.
	cat >"$T/bin/pgrep" <<EOF
#!/bin/sh
cat "$T/pids"
EOF
	cat >"$T/bin/lsof" <<EOF
#!/bin/sh
echo "n$TARGET"
EOF
	printf '#!/bin/sh\nexit 0\n' >"$T/bin/sleep"
	printf '#!/bin/sh\necho "\$@" >>"%s/kill.log"\n' "$T" >"$T/bin/kill"
	chmod 755 "$T/bin/pgrep" "$T/bin/lsof" "$T/bin/sleep" "$T/bin/kill"
	# Layer 1: functions that beat builtins.
	cat >"$T/harness.sh" <<EOF
pgrep() { cat "$T/pids"; }
lsof() { echo "n$TARGET"; }
sleep() { return 0; }
kill() {
	echo "\$*" >>"$T/kill.log"
	case "\$1" in
	-TERM)
		[ -e "$T/dies_on_term" ] && : >"$T/pids"
		[ -e "$T/jobs_after_term" ] && cp "$T/jobs_after_term" "$T/jobs"
		;;
	esac
	return 0
}
set -- "$TARGET" "$T/built" ui watcher
. "$script"
EOF
}

# run_case: runs the harness, sets $code and $out.
run_case() {
	out=$(PATH="$T/bin:/usr/bin:/bin" NONINTERACTIVE=1 sh "$T/harness.sh" 2>&1 </dev/null)
	code=$?
}

# --- no server running
new_case none
run_case
[ "$code" = 0 ] || fail "none: exit $code, want 0"
[ ! -s "$T/kill.log" ] || fail "none: kill was called: $(cat "$T/kill.log")"

# --- idle server: one TERM, exit 0
new_case idle
echo 4242 >"$T/pids"
: >"$T/dies_on_term"
run_case
[ "$code" = 0 ] || fail "idle: exit $code, want 0 ($out)"
[ "$(cat "$T/kill.log")" = "-TERM 4242" ] || fail "idle: kill log = '$(cat "$T/kill.log")'"

# --- busy server, non-interactive: refuse, never kill
new_case busy
echo 4242 >"$T/pids"
echo "Delete worktree foo — Remove worktree directory" >"$T/jobs"
run_case
[ "$code" = 1 ] || fail "busy: exit $code, want 1"
[ ! -s "$T/kill.log" ] || fail "busy: kill was called: $(cat "$T/kill.log")"
case "$out" in *"worktree ui is busy:"*) ;; *) fail "busy: no busy header in: $out" ;; esac
case "$out" in *"Delete worktree foo — Remove worktree directory"*) ;; *) fail "busy: job line missing in: $out" ;; esac

# --- idle at the check, alive after TERM with a job now reported: no KILL
new_case gap
echo 4242 >"$T/pids"
echo "New worktree x — Create" >"$T/jobs_after_term"
run_case
[ "$code" = 1 ] || fail "gap: exit $code, want 1"
[ "$(cat "$T/kill.log")" = "-TERM 4242" ] || fail "gap: kill log = '$(cat "$T/kill.log")'"
case "$out" in *"worktree ui is busy:"*) ;; *) fail "gap: no busy header in: $out" ;; esac

# --- alive after TERM and no job: KILL
new_case stuck
echo 4242 >"$T/pids"
run_case
[ "$code" = 0 ] || fail "stuck: exit $code, want 0"
[ "$(cat "$T/kill.log")" = "-TERM 4242
-KILL 4242" ] || fail "stuck: kill log = '$(cat "$T/kill.log")'"

if [ "$failures" = 0 ]; then echo "stop-running_test: ok"; else exit 1; fi
