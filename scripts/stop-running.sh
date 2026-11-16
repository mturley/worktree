#!/bin/sh
# Stops running worktree servers before the binary is replaced. A server
# with a job in flight is never killed without asking.
set -u
target=$1; built=$2; shift 2
pattern="(^|/)$(basename "$target") ($(echo "$*" | tr ' ' '|'))(\$| )"

running_pids() {   # PIDs whose executable is exactly $target
	out=""
	for pid in $(pgrep -f "$pattern" 2>/dev/null || true); do
		exe=$(lsof -a -p "$pid" -d txt -Fn 2>/dev/null | awk '/^n/{print substr($0,2); exit}')
		[ "$exe" = "$target" ] && out="$out $pid"
	done
	echo $out
}
# busy prints the running jobs, one line each, and nothing when idle. A checker
# that cannot run (missing, stale binary without `jobs`, crash) is NOT idle: we
# cannot know, and a wrong guess kills a job in flight. It reports a marker
# line instead, which routes to ask rather than to a kill.
busy() {
	out=$("$built" jobs --running 2>/dev/null)
	if [ $? != 0 ]; then
		echo "(cannot check for running jobs: $built failed)"
	else
		echo "$out"
	fi
}

# The terminal ask reads from. The Makefile clears STOP_RUNNING_TTY before
# running this script, so only the tests override it.
tty=${STOP_RUNNING_TTY:-/dev/tty}
tty_open=0

# ask explains why a server is in the way and returns 0 to look again, 2 to
# force. $1 heads the explanation, $2 is the detail beneath it, and $3 says in
# one phrase why we stopped, for when there is nobody to ask.
ask() {
	echo "$1"
	echo "$2" | sed 's/^/  /'
	if [ -n "${NONINTERACTIVE:-}" ]; then
		echo "Aborting: $3." >&2; exit 1
	fi
	# Opened once and kept on fd 3: a second ask in the same run must read
	# the next answer, not the first one over again.
	if [ "$tty_open" = 0 ]; then
		if ! (: <"$tty") 2>/dev/null; then
			echo "Aborting: no terminal to ask on." >&2; exit 1
		fi
		exec 3<"$tty"
		tty_open=1
	fi
	while :; do
		printf '[A]bort, [R]etry, [F]orce? '
		read -r answer <&3 || {
			echo "Aborting: no terminal to ask on." >&2; exit 1
		}
		case "$answer" in
			[Aa]*) echo "Aborted."; exit 1 ;;
			[Rr]*) return 0 ;;
			[Ff]*) return 2 ;;
		esac
	done
}

# ask_busy asks about the jobs in $1, or about a server that ignored SIGTERM
# when there are none.
ask_busy() {
	if [ -n "$1" ]; then
		ask "worktree ui is busy:" "$1" "a job is running"
	else
		ask "$(basename "$target") would not stop:" \
			"(the server did not stop after SIGTERM)" \
			"the server did not stop after SIGTERM"
	fi
}

force=0
termed=0
while :; do
	pids=$(running_pids)
	[ -z "$pids" ] && exit 0
	if [ "$force" = 1 ]; then
		echo "Force-killing $(basename "$target") server(s):$pids"
		kill -KILL $pids 2>/dev/null || true
		exit 0
	fi
	jobs=$(busy)
	if [ -n "$jobs" ]; then
		ask_busy "$jobs"; [ $? = 2 ] && force=1
		continue
	fi
	echo "Stopping running $(basename "$target") server(s) [$target]:$pids"
	# The server treats a second signal inside its 5s shutdown window as a
	# request to force exit. After a Retry, wait that window out before
	# sending another TERM.
	[ "$termed" = 1 ] && sleep 5
	termed=1
	kill -TERM $pids 2>/dev/null || true
	sleep 2
	pids=$(running_pids)
	[ -z "$pids" ] && exit 0
	# Still here. An idle server exits on SIGTERM at once, so this one is
	# refusing (a job started in the gap) or hung — and which it is we cannot
	# tell from out here. Either way a human decides: the only -KILL this
	# script sends is one somebody chose.
	ask_busy "$(busy)"; [ $? = 2 ] && force=1
done
