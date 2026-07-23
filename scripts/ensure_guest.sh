# Pixi activation hook: make sure the CPython-WASI guest binary is vendored
# before anything in the `api` feature's environments runs.
#
# This file is SOURCED by pixi (see `[feature.api.activation]` in pixi.toml),
# not executed, and that dictates everything odd-looking below:
#
#   * NO `exit`, and NO top-level `set -e`. Pixi sources this into the shell it
#     snapshots the environment from ("echo <marker>; export ...; . this;
#     echo <marker>; env"). An `exit` there kills that shell, and `pixi run`
#     aborts with a hundred-line environment dump instead of running the task.
#     A command merely *failing* is harmless -- the surrounding script keeps
#     going -- so the real fetcher is invoked as a child `bash` whose
#     `set -euo pipefail` and `exit 1` cannot reach us.
#   * Output goes to /dev/tty, not stdout/stderr. Pixi swallows both (they only
#     resurface embedded in its error blob), and a silent 40 MB first-run
#     download is indistinguishable from a hang.
#   * Paths are anchored to PIXI_PROJECT_ROOT, which pixi exports *before*
#     sourcing this. CWD is wherever the developer invoked pixi from.
#   * Variables are `__dr_`-prefixed and unset at the end: this shell is about
#     to be snapshotted, so a stray name would leak into every task's env.
#
# It runs on *every* `pixi run -e api ...` (pixi's activation cache is opt-in
# and off here), so the steady-state cost has to be nil -- hence the two-stat
# fast path before anything else happens.

__dr_root="${PIXI_PROJECT_ROOT:-$PWD}"
__dr_vendor="$__dr_root/spikes/code_exec/vendor"

# `python.wasm` is the sentinel: fetch_python_wasi.sh moves it into place last,
# after the stdlib, so its presence implies a complete unpack. Both halves are
# checked anyway because the two settings that consume them are independent
# (`snippet_guest_wasm_path` / `snippet_guest_lib_path`).
if [ ! -f "$__dr_vendor/python.wasm" ] || [ ! -d "$__dr_vendor/lib/python3.14" ]; then
    # `test -w /dev/tty` is not enough: the device node is world-writable, so it
    # passes even with no controlling terminal, and the write then fails with
    # ENXIO. Actually opening it is the only reliable probe.
    __dr_out=/dev/null
    if { : > /dev/tty; } 2>/dev/null; then
        __dr_out=/dev/tty
    fi

    {
        echo "data-rover: fetching the CPython-WASI guest (~40 MB, one time)..."
        if bash "$__dr_root/spikes/code_exec/fetch_python_wasi.sh"; then
            echo "data-rover: guest ready."
        else
            # Deliberately not fatal. Booting offline, or behind a proxy that
            # cannot reach GitHub, stays possible: the backend starts with
            # `_boot_script_runner` leaving the runner None and the snippet
            # routes reporting 503 -- the same degraded path a checkout that
            # never fetched has always taken.
            echo "data-rover: guest fetch FAILED -- code execution will be" \
                 "unavailable (snippet routes 503). Re-run any pixi api-env" \
                 "task to retry, or fetch by hand:"
            echo "  bash spikes/code_exec/fetch_python_wasi.sh"
        fi
    } > "$__dr_out" 2>&1

    unset __dr_out
fi

unset __dr_root __dr_vendor
