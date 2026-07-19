#!/usr/bin/env bash
# process-compose wrapper for the dr-* local-dev tasks (see pixi.toml).
#
# Filters two harmless stderr lines process-compose emits — a per-run
# config-discovery debug line ("could not locate ... config home"), and the
# "failed to stop project ... connection refused" that `down` prints when no
# daemon is running — while letting every other line, and the real exit code,
# through, so genuine errors (bad process-compose.yaml, port in use, ...) still
# surface on the terminal.
#
# stderr is captured to a temp file and filtered AFTER process-compose returns,
# rather than through a live `2> >(grep …)` pipe: `up --detached` forks a
# background daemon that would inherit the filter pipe's write end and hold it
# open, hanging any caller that reads this command's output and leaking a grep
# process until the daemon exits. A plain file has no such reader to block.
err="$(mktemp)"
trap 'rm -f "$err"' EXIT
process-compose "$@" 2>"$err"
rc=$?
grep -vE 'Path not found for process compose config home|failed to stop project' "$err" >&2 || true
exit "$rc"
