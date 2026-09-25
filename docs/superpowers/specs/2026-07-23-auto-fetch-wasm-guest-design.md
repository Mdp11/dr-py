# Auto-fetch the CPython-WASI guest via a pixi activation script

**Date:** 2026-07-23
**Status:** approved, ready to implement

## Problem

On a fresh clone, `pixi run dr-start` brings up a stack whose code execution is
dead: `spikes/code_exec/vendor/python.wasm` (~29 MB) and its stdlib (~13 MB) are
gitignored, so `main._boot_script_runner` logs a warning, leaves the runner
`None`, and every snippet route answers 503. The only fix today is remembering
to run `bash spikes/code_exec/fetch_python_wasi.sh` by hand.

Make pixi do it.

## Approach

A **pixi activation script on `feature.api`**, so the guest is fetched as a
side effect of entering the environment the backend runs in. Every entry point
already funnels through `pixi run -e api`:

- `dr-start` (itself an `api`-env task) → `docker compose` + `scripts/pc.sh up`
- process-compose's `db-upgrade` and `backend` processes (`pixi run -e api ...`)
- `frontend/playwright.config.ts`'s backend `webServer`
- `pixi run -e core-dev pytest` (the `core-dev` env includes `feature.api`)

## Verified pixi 0.69 activation semantics

Established empirically in a throwaway pixi project, not from docs. These are
the constraints the script is written against:

| Observation | Consequence for the design |
| --- | --- |
| Activation runs on **every** `pixi run -e <env>` (3 runs → 3 executions). The activation cache is an opt-in experimental setting (`use-environment-activation-cache`) and is not enabled in `.pixi/config.toml`. | The script needs a cheap fast-path guard rather than a run-once marker; it must cost ~two `stat`s in the steady state. |
| The script is **sourced** into pixi's env-capture shell: pixi emits `echo ____RATTLER_ENV_START____`, its own `export`s, `. <script>`, then the marker again and `/usr/bin/env`, and parses the tail as the environment. | An `exit N` inside kills that shell → `pixi run` aborts with a ~100-line env dump instead of running the task. A merely *failing last command* is harmless (verified: a script containing only `false` still yielded `rc=0`), because the outer script keeps going. **Never call `exit`; never `set -e` at top level.** |
| Both stdout and stderr of the script are swallowed (they only resurface embedded in pixi's error blob on failure). | A silent 40 MB first-run download would look like a hang. Progress must be written to `/dev/tty` when one is attached. |
| `PIXI_PROJECT_ROOT` is exported *before* the script is sourced. | Anchor every path to it; never trust CWD. |

## Components

### 1. `scripts/ensure_guest.sh` (new)

The sourced-safe activation entry point. Sits beside the existing `scripts/pc.sh`.

- Fast path: if `$PIXI_PROJECT_ROOT/spikes/code_exec/vendor/python.wasm` is a
  file **and** `.../vendor/lib/python3.14` is a directory, do nothing.
- Otherwise announce the one-time download, then run the real fetcher as a
  **child `bash`** — not sourced — so its `set -euo pipefail` and `exit 1`
  cannot terminate the activation shell.
- Route all output to `/dev/tty` when writable, `/dev/null` otherwise (CI,
  process-compose daemons, playwright's spawned servers).
- On failure: warn, and return normally. Do not propagate the error.
- Use `__dr_`-prefixed locals and `unset` them at the end — the script shares
  the shell that pixi is about to snapshot, so any stray variable would leak
  into every task's environment.

### 2. `spikes/code_exec/fetch_python_wasi.sh` (modified)

Remains the single source of truth for the pinned URL and SHA256. Two changes:

- **Early exit when already unpacked**, so a direct manual run is also a no-op.
- **Unpack to a PID-unique temp dir, then move the entries into `vendor/`**,
  with `lib` moved *before* `python.wasm`. Today it re-unzips over `vendor/` on
  every invocation (`unzip -oq`), which means an interrupted run can leave a
  `python.wasm` next to a half-written stdlib — exactly the state
  `ensure_guest.sh`'s guard would read as "done". Moving `python.wasm` last
  makes its presence imply the stdlib is complete. The archive itself keeps
  being cached at `vendor/<basename>` (downloaded to a temp name and renamed
  into place) so a re-run after a successful download never re-fetches.

The zip's top-level entries are `LICENSE`, `lib/`, and `python.wasm`.

### 3. `pixi.toml` (modified)

```toml
[feature.api.activation]
scripts = ["scripts/ensure_guest.sh"]
```

Attached to `feature.api`, which is a member of both the `api` and `core-dev`
environments. The `core-dev` reach is deliberate: the `integration`-marked wasm
tests (`tests/api/test_snippets_wasm.py`, `test_script_sweep_wasm.py`,
`test_script_sweep_perf.py`) currently skip silently on a fresh clone, and this
makes them runnable. The accepted cost is that the first `pixi run core-test`
on a fresh clone pays the one-time download before running a suite that does
not otherwise need the guest.

### 4. Documentation (modified)

Four places say "fetch it yourself" and become "fetched automatically on
`pixi run -e api`; run the script by hand only if you bypassed that":

- `CLAUDE.md` — the "Guest binary" bullet under *Code execution (snippets)*
- `spikes/code_exec/README.md:13`
- `src/data_rover/api/settings.py:98` — the `snippet_guest_wasm_path` comment
- `src/data_rover/api/main.py:168` — `_boot_script_runner`'s docstring

## Error handling

The stance is **degraded, never blocking** — the same posture the runtime
already takes.

- No network / GitHub down / SHA mismatch → warning on the tty, activation
  succeeds, backend boots, snippet routes 503, wasm tests skip. Working offline
  on a clone that never fetched stays possible.
- Interrupted mid-fetch → the temp-dir + ordered-move scheme leaves the guard
  false, so the next `pixi run -e api` retries.
- Concurrent activations (e.g. playwright's backend `webServer` racing a manual
  `pixi run`) → PID-unique temp paths mean they cannot clobber each other; the
  loser's `mv` lands on an already-correct tree. No lock file.

## Testing

Manual, because the unit under test is pixi's activation behaviour rather than
Python code:

1. `mv spikes/code_exec/vendor /tmp/vendor-backup && pixi run -e api db-upgrade`
   → tty shows the fetch, `vendor/` is repopulated, SHA verified.
2. Immediately re-run → no output, no measurable delay (fast path).
3. `bash spikes/code_exec/fetch_python_wasi.sh` directly → prints
   already-vendored, exits 0.
4. Break the network (or temporarily point `URL` at a 404) with `vendor/`
   removed → `pixi run -e api db-upgrade` still runs the task, printing the
   warning; backend then boots with snippet routes 503.
5. `pixi run dr-start` end to end from a guest-less tree → snippet console runs.
6. `pixi run -e core-dev pytest tests/api/test_snippets_wasm.py -m integration`
   → no longer skips.

## Non-goals

- Moving the vendor directory out of `spikes/` (it is the `settings.py` default
  and is referenced from ~8 files).
- Committing the binary, or vendoring it into the conda environment as a
  package.
- Any change to the `snippet_runner` selection, the 503 degradation path, or
  `_boot_script_runner`'s logic.
