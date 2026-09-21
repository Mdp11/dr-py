# Conventions

How to work in this repository. `CLAUDE.md` holds the command reference and the map of the
current code; this file holds the rules.

## Layout

**RC-1.**

| Path | Holds | Tracked |
|---|---|---|
| `architecture/` | Target architecture, decisions, contracts, constraints — this directory | yes |
| `CLAUDE.md`, co-located `README.md`s | How the current code works | yes |
| `BACKLOG.md` | Everything known but not done, with stable one-letter ids | yes |
| `BACKLOG-ENGINE.md` | The same, for the client-engine program; ids unique across both files | yes |
| `src/data_rover/` | Python server (`api/`), Python core (`core/`), legacy `migration/` CLI | yes |
| `frontend/` | SvelteKit UI | yes |
| `engine/` | TypeScript engine package — created by sub-project A | yes |
| `sandbox/` | Sandbox page and engine worker: a static Vite site, the only place with DOM and WebWorker typings — created by sub-project B | yes |
| `headless/` | Node headless service — created by sub-project E | yes |
| `tests/<area>/` | Python tests, mirroring the source packages | yes |
| `examples/` | Small reference artifacts (`smart-city.*`) | yes |
| `spikes/` | Throwaway experiments (MR-5) | yes, minus vendored binaries |
| `docs/`, `.superpowers/` | Working specs, plans, ledgers | **no** |
| `benchmarks/` | Generated large models and benchmark output | **no** |

## Toolchain

**RC-2 · Everything runs through pixi.** There is no global `python` or `node`. New tooling is
added as a pixi environment or task, never as a global install. The `frontend` environment
(Node 22) serves `frontend/`, `engine/`, `sandbox/` and `headless/`.

**RC-3 · Python.** Version 3.14; `ruff`, `mypy` and `pyright` MUST all pass (`pixi run
dr-tidy`). Use modern stdlib freely.

**RC-4 · TypeScript.** `strict`. The engine package has no DOM and no Node built-in
dependencies — only what a worker and Node share. No `any` in an exported signature.

**RC-5 · Determinism in the engine.** No `Date.now`, `Math.random`, `Intl`, locale comparison
or hash-order dependence in an evaluation path (CT-7). Inject clocks and randomness.

## Code

**RC-6 · Comments and docstrings** are concise and present-tense, and exist only for what the
code cannot say: invariants, concurrency rules, non-obvious contracts. No references to specs,
plans, phases or ids from this directory; no history — git owns the past.

**RC-7 · Match the surrounding code**: its naming, idiom and comment density.

**RC-8 · One mutation boundary per store.** Python: `Model` (`core/model/model.py`). Engine:
the op applier. Nothing else writes entity state; indexes are maintained there.

## Process

**RC-9 · Design before code.** Brainstorm → spec → plan → build. Specs and plans live under the
git-ignored `docs/superpowers/`. Anything a later session must not rediscover is promoted: a
decision into `architecture/`, an open item into `BACKLOG.md` (`BACKLOG-ENGINE.md` for this
program), current behaviour into `CLAUDE.md`.

**RC-10 · Docs change with the code**, in the same commit: `CLAUDE.md` for current behaviour,
`program.md` for status, `BACKLOG.md` or `BACKLOG-ENGINE.md` when an item opens or closes.

**RC-11 · Git.** Work on `feat/<topic>`, `perf/<topic>` or `chore/<topic>` and merge into
`main`. Commit subjects are one imperative sentence, capitalized, no prefix, no trailing
period (`Handle infinity parsing for floats`). Reference backlog ids where one applies.

## Tests

**RC-12 · Python.** `tests/<area>/` mirrors the source packages; `pythonpath=src`. API tests
need no database service and use the `client` fixture with the helpers in
`tests/api/conftest.py`.

**RC-13 · Golden fixtures.** The oracle generates them through a pixi task; small ones are
committed, large-model ones are generated under `benchmarks/`. A fixture is inputs plus
expected outputs, never a snapshot of engine output. A Python behaviour change during a port
regenerates its fixtures in the same commit (MR-3).

**RC-14 · Engine tests run the engine.** Test against a small fixture model in-process, not
against mocks of the engine.

**RC-15 · Frontend.** vitest + happy-dom; MSW for routes that still hit the server
(`onUnhandledRequest: 'error'`); Playwright e2e stays separate.

**RC-16 · Benchmarks** follow CN-5 and measure at model M unless they say otherwise.
