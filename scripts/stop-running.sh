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
busy() { "$built" jobs --running 2>/dev/null || true; }

# ask prints the busy jobs and returns 0 to look again, 2 to force.
ask() {
	echo "worktree ui is busy:"
	echo "$1" | sed 's/^/  /'
	if [ -n "${NONINTERACTIVE:-}" ] || [ ! -r /dev/tty ]; then
		echo "Aborting: a job is running." >&2; exit 1
	fi
	while :; do
		printf '[A]bort, [R]etry, [F]orce? '
		read -r answer </dev/tty || exit 1
		case "$answer" in
			[Aa]*) echo "Aborted."; exit 1 ;;
			[Rr]*) return 0 ;;
			[Ff]*) return 2 ;;
		esac
	done
}

force=0
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
		ask "$jobs"; [ $? = 2 ] && force=1
		continue
	fi
	echo "Stopping running $(basename "$target") server(s) [$target]:$pids"
	kill -TERM $pids 2>/dev/null || true
	sleep 2
	pids=$(running_pids)
	[ -z "$pids" ] && exit 0
	jobs=$(busy)
	if [ -n "$jobs" ]; then          # a job started in the gap; the server refused
		ask "$jobs"; [ $? = 2 ] && force=1
		continue
	fi
	echo "Force-killing remaining $(basename "$target") server(s):$pids"
	kill -KILL $pids 2>/dev/null || true
	exit 0
done
