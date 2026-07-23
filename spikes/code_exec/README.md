# Code-execution M0 spike

Go/no-go probes for the WASM snippet sandbox
(spec: docs/superpowers/specs/2026-07-17-code-execution-design.md §12).

Run any probe from the repo root:

    pixi run -e core-dev python spikes/code_exec/s01_boot.py

Scripts are numbered by spec-§12 checklist item. Results live in FINDINGS.md.
`vendor/` (guest binary + stdlib) is gitignored. It is populated automatically
by the `scripts/ensure_guest.sh` pixi activation hook the first time anything
runs in the `api` or `core-dev` environments (`pixi run dr-start`,
`pixi run core-test`, ...). To populate it by hand — or to re-fetch after
changing the pin — run:

    bash spikes/code_exec/fetch_python_wasi.sh [--force]
