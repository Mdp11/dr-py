## Global Constraints

- Everything runs through pixi. There is no global `node` or `python`: use `pixi run <task>`, `pixi run -e core-dev …`, `pixi run -e frontend …`.
- **Branch and commits.** Work on `feat/eval-rules`, cut from `engine-migration`. Task 1 cuts it, and Task 7 fast-forwards `engine-migration` to it, with the owner's go-ahead. Never touch `main`, never push. Commit per the owner's answer at plan approval (recorded in the build handoff). One commit per task.
- **Freeze (MR-3).**
  - `core/model`, `core/metamodel` and the model-op applier stay frozen. So do plan 1's and plan 2's areas.
  - From Task 1 on, `core/validation/rules/` and `api/rules.py` are frozen too (spec §8's plan-3 row): no behaviour change; a bug lands on both sides with a fixture (D18).
  - `src/data_rover/` changes only in Task 1, and only in `api/routes/rules.py`, `api/routes/artifacts.py` (the payloads route) and `api/schemas.py`, plus their tests and `api/README.md`.
  - The Python core is the oracle: fix the engine, never a fixture. Fixtures change only through `pixi run golden-fixtures`.
- **Engine `src/` rules:**
  - No DOM, no Node built-in, no timer or clock, no `Math.random`, no `Intl`, and no locale comparison (RC-4, RC-5).
  - Erasable syntax only, `.ts` import specifiers, and no `any` in an exported signature.
  - Strings compare by `cmpCodePoint`. A substring test is `pyContains`.
  - `repr` is `pyRepr` / `pyFloatRepr` / `pyReprValue`.
- Tests import the engine through `engine/src/index.ts` only. Engine and frontend tests run the real engine, never a mock, without fake timers. Every in-process link is `dispose()`d.
- A steps generator publishes nothing before its last step, EXCEPT the sweep. Each sweep or rescan step is a complete splice. The sweep may hold an iterator across a yield only under M9's order-epoch guard.
- A transition runs to completion. Its incremental revalidation, reach included, is part of it (AD-23). Nothing live leaves the service: results go through `toWire` / the `wire*` functions.
- **Lint and checks.**
  - `pixi run engine-tidy` for `engine/`, and `pixi run dr-tidy` for the rest.
  - On every file under `tests/` and `scripts/`, run `pixi run -e core-dev ruff check <files>` and `ruff format <files>` by hand.
  - `pixi run engine-check` and `pixi run frontend-check` must pass.
- A "see it fail" step lists the tests it expects red. Any OTHER red test is a finding to report, not to silence.
- Comments and docstrings: concise, present-tense, only for what the code cannot say. No references to specs, plans or `architecture/` ids in code (RC-6).
- `architecture/`, the READMEs, `BACKLOG.md` and `BACKLOG-ENGINE.md` change in the commit of the code they describe (RC-10). `docs/` and `benchmarks/` are git-ignored: never `git add -f`.
- Commit subjects: one imperative sentence, capitalized, with no prefix and no trailing period. The message ends with the session's `Co-Authored-By` line.
- Ids: the next free are `AD-33`, `K-65`, `C-24`, `T-11` and `U-11` (grep before use; K ids are unique across both backlogs).
- **Baseline** at `2cca78a` (2026-09-25):
  - core: 2,575 passed / 34 deselected;
  - frontend: 3,008 tests in 283 files;
  - engine: 1,214 tests in 78 files;
  - sandbox: 14 tests;
  - e2e: 63 passed and 2 failed; the two failures are the pre-existing T-8 and T-9, with no `[shadow]` lines;
  - `pixi run engine-parity-large`: equal over 7,708 injected issues.

## Build-time additions (owner, 2026-09-25)
- Commits are pre-approved: one commit per task on feat/eval-rules, the plan's subject, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push; never touch main or engine-migration.
- `docs/` and `benchmarks/` are git-ignored: never `git add -f`.
- Reviewer findings already folded into the plan (do not undo): K-60's `rekey` refreshes the cached text before its early return; K-61 fills `committedOf` from the store in `revalidate` for transitions only; M2's reader follows pydantic's null handling (only property tests use key presence); a waiting read re-checks `settled` in its answering transition; the compile memo includes the metamodel identity; a rules artifact arriving with no parse means `unreadable`, answered 501; the FALLBACKS change happens in Task 4, not Task 6.
