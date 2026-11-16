#!/bin/sh
# Tests scripts/stop-running.sh without any real process involved.
#
# SAFETY: `kill` is a shell builtin, so a fake `kill` on PATH would never be
# reached. Instead each scenario runs the script SOURCED by a harness that
# first defines shell functions for pgrep, lsof, kill and sleep; functions
# beat builtins and PATH lookups. The fake `kill` only appends its arguments
# to logs. Fakes are also placed first on PATH as a second layer. Nothing
# here lists or signals a real process.
#
# The script's terminal is overridden through STOP_RUNNING_TTY (a file of
# answers), so the Abort/Retry/Force prompt is tested too.
set -u

here=$(cd "$(dirname "$0")" && pwd)
script="$here/stop-running.sh"
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
failures=0

fail() { echo "FAIL: $*"; failures=$((failures + 1)); }

# new_case <name>: sets $T to a fresh dir with fakes and state files.
#   $T/pids            pids pgrep reports (one per line)
#   $T/jobs            what the fake built binary prints for `jobs --running`
#   $T/jobs.N          same, but for the Nth call only (wins over $T/jobs)
#   $T/rc              the fake built binary's exit status (default 0)
#   $T/exe.PID         the executable lsof reports for PID (default $TARGET)
#   $T/dies_on_term    if present, a -TERM empties $T/pids
#   $T/jobs_after_term if present, a -TERM writes its content to $T/jobs
#   $T/kill.log        every kill invocation's arguments
#   $T/order.log       every kill and sleep, in order
new_case() {
	T="$root/$1"
	mkdir -p "$T/bin"
	: >"$T/pids"; : >"$T/jobs"; : >"$T/kill.log"; : >"$T/order.log"
	TARGET="$T/installed/worktree"
	mkdir -p "$T/installed"
	: >"$TARGET"
	cat >"$T/built" <<EOF
#!/bin/sh
[ "\$1 \$2" = "jobs --running" ] || exit 2
n=\$(cat "$T/n" 2>/dev/null || echo 0); n=\$((n + 1)); echo \$n >"$T/n"
if [ -e "$T/jobs.\$n" ]; then cat "$T/jobs.\$n"; else cat "$T/jobs"; fi
[ -e "$T/rc" ] && exit "\$(cat "$T/rc")"
exit 0
EOF
	chmod 755 "$T/built"
	# Layer 2: fakes on PATH.
	cat >"$T/bin/pgrep" <<EOF
#!/bin/sh
cat "$T/pids"
EOF
	cat >"$T/bin/lsof" <<EOF
#!/bin/sh
if [ -e "$T/exe.\$3" ]; then echo "n\$(cat "$T/exe.\$3")"; else echo "n$TARGET"; fi
EOF
	printf '#!/bin/sh\necho "sleep $*" >>"%s/order.log"\n' "$T" >"$T/bin/sleep"
	printf '#!/bin/sh\necho "$@" >>"%s/kill.log"\n' "$T" >"$T/bin/kill"
	chmod 755 "$T/bin/pgrep" "$T/bin/lsof" "$T/bin/sleep" "$T/bin/kill"
	# Layer 1: functions that beat builtins.
	cat >"$T/harness.sh" <<EOF
pgrep() { cat "$T/pids"; }
lsof() {
	if [ -e "$T/exe.\$3" ]; then echo "n\$(cat "$T/exe.\$3")"; else echo "n$TARGET"; fi
}
sleep() { echo "sleep \$*" >>"$T/order.log"; return 0; }
kill() {
	echo "\$*" >>"$T/kill.log"
	echo "\$*" >>"$T/order.log"
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

# run_case: runs the harness non-interactively, sets $code and $out.
run_case() {
	out=$(PATH="$T/bin:/usr/bin:/bin" NONINTERACTIVE=1 STOP_RUNNING_TTY="$T/no-tty" sh "$T/harness.sh" 2>&1 </dev/null)
	code=$?
}

# run_tty <answers>: runs the harness interactively, answers fed through
# STOP_RUNNING_TTY (a file standing in for /dev/tty).
run_tty() {
	printf '%s\n' "$1" >"$T/tty"
	out=$(PATH="$T/bin:/usr/bin:/bin" NONINTERACTIVE= STOP_RUNNING_TTY="$T/tty" sh "$T/harness.sh" 2>&1 </dev/null)
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

# --- checker exits non-zero: not idle, never kill
new_case checkfail
echo 4242 >"$T/pids"
echo 1 >"$T/rc"
run_case
[ "$code" = 1 ] || fail "checkfail: exit $code, want 1"
[ ! -s "$T/kill.log" ] || fail "checkfail: kill was called: $(cat "$T/kill.log")"
case "$out" in *"cannot check for running jobs"*) ;; *) fail "checkfail: no marker in: $out" ;; esac

# --- checker missing entirely: same
new_case nochecker
echo 4242 >"$T/pids"
mv "$T/built" "$T/built.gone"
run_case
[ "$code" = 1 ] || fail "nochecker: exit $code, want 1"
[ ! -s "$T/kill.log" ] || fail "nochecker: kill was called: $(cat "$T/kill.log")"
case "$out" in *"cannot check for running jobs"*) ;; *) fail "nochecker: no marker in: $out" ;; esac

# --- pgrep matches a pid whose executable is something else: never signalled
new_case lsofreject
printf '4242\n4243\n' >"$T/pids"
echo /bin/sh >"$T/exe.4243"
: >"$T/dies_on_term"
run_case
[ "$code" = 0 ] || fail "lsofreject: exit $code, want 0 ($out)"
[ "$(cat "$T/kill.log")" = "-TERM 4242" ] || fail "lsofreject: kill log = '$(cat "$T/kill.log")'"

# --- interactive Abort: exit 1, no kill
new_case abort
echo 4242 >"$T/pids"
echo "Delete worktree foo — Remove worktree directory" >"$T/jobs"
run_tty a
[ "$code" = 1 ] || fail "abort: exit $code, want 1"
[ ! -s "$T/kill.log" ] || fail "abort: kill was called: $(cat "$T/kill.log")"

# --- interactive Force: KILL, exit 0
new_case force
echo 4242 >"$T/pids"
echo "Delete worktree foo — Remove worktree directory" >"$T/jobs"
run_tty f
[ "$code" = 0 ] || fail "force: exit $code, want 0 ($out)"
[ "$(cat "$T/kill.log")" = "-KILL 4242" ] || fail "force: kill log = '$(cat "$T/kill.log")'"

# --- Retry after a TERM: the second TERM waits out the 5s window first
new_case retry
echo 4242 >"$T/pids"
: >"$T/jobs.1"
echo "New worktree x — Create" >"$T/jobs.2"
: >"$T/jobs.3"
: >"$T/jobs.4"
run_tty r
[ "$code" = 0 ] || fail "retry: exit $code, want 0 ($out)"
want="-TERM 4242
sleep 2
sleep 5
-TERM 4242
sleep 2
-KILL 4242"
[ "$(cat "$T/order.log")" = "$want" ] || fail "retry: order log = '$(cat "$T/order.log")'"

if [ "$failures" = 0 ]; then echo "stop-running_test: ok"; else exit 1; fi
