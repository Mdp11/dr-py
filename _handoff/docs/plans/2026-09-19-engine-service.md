# Engine Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline, one commit per task (the owner's choice for this program). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine can be driven through one message port: `createService(port, deps)` opens a replica from gzip bytes, follows the server by delta, stages edits and answers the five read surfaces — elements, fuzzy search, incident relationships, containment tree, summary counts — as the server's read routes answer them, while no piece of background or evaluation work holds the host for more than one 16 ms chunk.

**Architecture:** Plan 3 of 6 for sub-project B (`architecture/program.md`). Three layers are added to `engine/src/`, bottom-up. (1) *Steps*: a long operation is a generator that ends a step about every millisecond; the index build, the digest check, the two big sorts and the fuzzy scan are written once in that form and their synchronous entry points drain it, so sub-project A's callers do not change. (2) *Reads* (`src/read/`): pure functions over a `Model`, a port of `routes/read.py` rule for rule, held to golden fixtures that call the real route functions. (3) *The service* (`src/service/`): the CT-4 envelope, a scheduler — one pump, a control lane and a model lane, transitions as barriers, a background digest check — and the method table. The working copy gains coalescing, `adoptStaged` and the own-commit bookkeeping on a duplicate. Nothing in `frontend/`, `sandbox/` or `src/data_rover/` changes; the Python side gains golden scenarios and one table generator only.

**Tech Stack:** TypeScript 6 (`strict`, `erasableSyntaxOnly`, `lib: ["ES2023"]`, no DOM, no Node in `src/`), vitest 3 (Node environment), Python 3.14 for the golden scenarios (pytest, ruff); pixi for every command.

**Spec:** `docs/superpowers/specs/2026-09-19-replica-and-frontend-seam-design.md` — §3 and §4 are this plan's scope; §9 names its tests, §10 the `architecture/` and backlog edits that ride with the code. Read `architecture/contracts.md` (CT-2 to CT-5, CT-7), `architecture/constraints.md` (CN-3), `architecture/system.md` rule 4, `architecture/decisions.md` (AD-13, AD-23), `architecture/conventions.md` and `BACKLOG-ENGINE.md` `K-32` first, then `CLAUDE.md`'s "Engine package" section and plan 2's "After this plan" (`docs/superpowers/plans/2026-09-19-snapshots-and-replica-routes.md`, end of file).

**What kind of plan this is.** Direction with specifics: interfaces, signatures, the test cases and what each asserts, the order, and the mechanisms that are easy to get wrong, spelled out. It holds no full code and nothing in it was built or run — the implementer writes the tests and the code, and the expected results of the "see it fail" steps are reasoned from the code, not observed. If a step's expected result does not appear, trust the run, read the step's intent, and say so in the hand-back. What WAS checked while planning is listed next, each with how.

## What planning found

Facts the plan rests on, each checked against the code at `e5688f9` or by a throwaway probe (Node 22.22.3, Python 3.14.5, model M = `benchmarks/large.snapshot.v2`, 170,340 elements and 126,820 relationships, three runs in one pass).

1. **The roots sort is one 24 ms step inside the index build.** *Probe:* `rebuildIndexes()` at M is 570 ms whole; `RootOrder.reset`'s native sort of 122,230 roots (the bench model is mostly flat) is 24 ms of it, 57 ms when the input arrives in reverse order. Slicing the three loops of `IndexSet.rebuild` alone would leave it over the chunk.
2. **A merge sort cut into steps costs about twice the native sort and gives the same order.** *Probe:* runs of 2,048 sorted natively, then merged: roots 128 ms in 348 steps, the longest 1.2 ms (native: 57 ms, one step); 170,340 search hits 180 ms in 638 steps, the longest 2.0 ms (native: 88–100 ms, one step). Element by element the same array.
3. **A 2,000-line parse batch is too coarse for a 16 ms chunk.** *Probe:* parse + load per batch at M — 2,000 lines: median 6.9 ms, worst 36 ms; 500 lines: 1.7 / 17 ms; 250 lines: 0.8 / 13 ms. Totals 1,776 / 1,918 / 1,910 ms, inside one pass's noise (the 1,000-line run read 2,142).
4. **A generator costs nothing at the right grain, and the collector pauses inside steps.** *Probe:* the digest pass is 218–313 ms as a plain loop and 224–268 ms as a generator yielding every 64 or every 1,024 entities; yielding after every entity adds 20 %. Even at 64 entities a step (0.05 ms of work) the longest single step was 5–8 ms: a collector pause. A slice therefore needs room under its 16 ms, hence M5's 8 ms target.
5. **A fuzzy scan is 130–250 ms at M.** *Probe:* a port of `_search_score` with the native `toLowerCase` — 128 ms for a rare query, 243 ms for `q="a"` (166,090 hits of 170,340); each scan lowercases 1,232,500 string property values. It must run in steps, and its hit sort is fact 2's second row.
6. **A scan cannot continue across a transition.** *Probe:* a `Map` iterator that has read `a`, across `clear()` and a refill, goes on to read `a, b, c` again — and `Model.elements()` does exactly that (`byOrd`) on the first ordered read after a rewind restored an entity at an old `ord`. *Code:* `verifyDigest` hashes an unstaged entity from the model and a staged one from its committed image; an entity staged between two slices would be folded twice. So the digest check must restart after ANY transition that touched an entity, staged ones included — wider than the spec's "when committed state changes under it" — and a sliced read must never see a transition land under it (D2).
7. **An ordered pass is cheap.** *Probe:* iterating 170,340 elements in state order is 3.1 ms. The type-filtered page and the excluded-roots walk stay single steps.
8. **The host's Unicode version is not Python's.** *Probe over every code point:* Python 3.14.5 carries Unicode 16.0.0, Node 22.22.3 carries 17.0, and `toLowerCase()` differs from `str.lower()` at 28 code points (U+A7CE, U+A7D2, U+A7D4, U+16EA0–U+16EB8). 1,460 code points lower to something else; exactly one to more than one code point (U+0130 → U+0069 U+0307). Python's final-sigma rule needs two classes that `unicodedata` does not expose but `str.lower()` reveals by behaviour: *case-ignorable* (skipped by the scan; 2,749 code points in 452 ranges) and *cased and not case-ignorable* (decides it; 4,311 in 152 ranges).
9. **`str.strip()` is not `trim()`.** *Probe:* Python strips U+001C–U+001F and U+0085, JavaScript does not; JavaScript strips U+FEFF, Python does not.
10. **`nameOf` is already exact.** *Probe:* no non-ASCII code point lowers into `n`, `a`, `m` or `e`, so `key.toLowerCase() === 'name'` equals `key.lower() == "name"` under any Unicode version. One non-ASCII code point lowers to an ASCII alphanumeric — U+212A KELVIN SIGN → `k` — so the word-boundary test must run on the LOWERED name, as the route's does.
11. **The server's 404 text has lost its closing quote.** *Probe:* `str(KeyError("No element with id 'x'")).strip("'\"")` is `No element with id 'x` — `errors.py`'s handler strips quote characters off both ends of the `repr`. The engine already ports this as the private `errorDetail` in `src/ops/apply.ts`. The spec's §4 table shows the unstripped text; the route is the oracle.
12. **Page bounds are not in the route functions.** *Code:* `limit` and `offset` are `Query(ge=, le=)` constraints, enforced by FastAPI before the function runs and answered with FastAPI's list-shaped `detail` (`errors.py` handles pydantic's `ValidationError`, not `RequestValidationError`). A direct call skips them, so no fixture can hold them; the engine's texts for them are its own. `too many ids: N (max 500)` IS raised inside the functions, as an `HTTPException`, and a fixture holds it.
13. **A route function called directly keeps its `Query(...)` defaults as objects.** *Code:* `list_elements(q="x", session=s)` would slice with a `Query` instance. The recorder passes every argument (M10). `Session` is a dataclass whose fields all default: `Session(metamodel=…, model=…, views=…)` is enough for every read route.
14. **`getElement` is not in `read.py`.** *Code:* it is `routes/elements.py::get_element`, which 404s through `Model.get_element`'s `KeyError`. The freeze covers it too.
15. **The commit RESPONSE names its revision `model_rev`; the feed event and the tail name it `rev`.** *Code:* `schemas.OpsResponse`, `feed.commit_event`. `prev_rev` and `state_digest` are `null` on a response that applied nothing.
16. **`lib/api` unwraps the two batch reads.** *Code:* `getElementsBatch` and `getTreeItemsBatch` validate `{items}` and return `items`. The zod schema is the contract (CT-4), so the engine answers the HTTP body. `ModelSummarySchema` defaults `issue_counts` to `null` and `undo_depth` to `0`.
17. **Today's `emit` and `structural`.** *Code (`model.svelte.ts:554–578`, `:385–390`):* a property update merges into the FIRST queued op of the same kind and id, later keys win, a `null` survives the merge; a delta is structural when it carries an id map, any changed relationship, any deletion, or a changed element the store has never seen.
18. **An update op bumps `rev` once per patched key and re-places a deleted key.** *Code (`src/ops/apply.ts::applyPatch`):* one `setProperty` / `deleteProperty` per key. Staged `{a: null}` then `{a: 5}` applied in place leaves `a` LAST in the property bag; the merged op `{a: 5}` replayed leaves it where it was. Coalescing in place would therefore leave a state no replay reproduces — key order is state (exports) — hence M8.
19. **Both sides keep `elements_by_type` sparse** (`indexes.py:320–324`; `IndexSet.byType`), and `first_parent` is `containment_parents[0]`, the engine's `parents[0]`.
20. **The engine's prettier ignores `/fixtures/` only** (`engine/.prettierignore`); a generated source file under `src/` needs its own line there.
21. **Part of spec §10 is already true.** *Read:* CN-3 carries the 100 ms transition row, `system.md` rule 4 the atomic-transition sentence, and AD-23 exists; nothing of theirs is left for this plan. CT-2's commit-in-flight order, which §10 also lists, is the shell's and lands with plan 4.

## Decisions

Taken with the owner (2026-09-21):

- **D1. Both big sorts run in steps**, through one mechanism (`sortedInSlices`, M2): the roots sort of the index build and the hit sort of a search. Accepted cost: about +80 ms on open, about +90 ms on a broad search (fact 2).
- **D2. A transition waits.** One queue in arrival order; a transition starts only when every read that arrived before it has finished, and everything behind it waits for it. Between the slices of a long read, reads that arrived later are answered (M3). Accepted cost: a `stage` posted right after a search can wait for one scan, at most about 250 ms at M.
- **D3. A delta crosses into the engine as JSON text.** `applyDelta {text, own?}`, `applyTail {text}`: the shell hands over what it received — the WebSocket frame, the body of `POST /commits`, the body of `/replica/tail` — and the engine reads it with its exact parser. A value parsed by the host's `JSON.parse` has already lost `1.0` and every integer past 2^53, and the digest, which folds `(id, rev)` only, would never notice.

Taken by this plan — each small, each reversible at review; say so if one is wrong:

- **D4. The tail ends opening.** `open` → `chunk`… → `end` (answers the header once the replica is indexed; the state stays `opening`) → `adoptStaged` (a re-bootstrap only) → `applyTail`, which makes the replica `ready`. A tail is always applied, an empty one included. Feed deltas the shell buffered meanwhile are ordinary `applyDelta` calls after `ready`: the older ones drop as duplicates.
- **D5. `adoptStaged` is a service method.** The spec lists it as a working-copy addition only; the shell needs it to carry staged batches across a re-bootstrap. Batch ids are kept.
- **D6. Coalescing is opt-in on `WorkingCopy.stage` and never done in place** (fact 18, M8). The service always asks for it; sub-project A's callers, which stage without the option, behave as before.
- **D7. The digest check restarts after any transition that touched an entity or the staged list** (fact 6).
- **D8. What waits and what does not.** Reads, `stagedDiff`, `stage` and `unstage` wait in the queue for `ready` — the spec says so for reads; an edit made during a re-bootstrap then lands after the adopted ones instead of being refused. `staged`, `conflicts`, `setViewPlacement`, `dropViewPlacement` and the replica methods are answered in any state. `applyDelta` outside `ready` is a 409: the shell buffers.
- **D9. A result is the HTTP response BODY** (fact 16), its fields in pydantic's order, so a fixture is compared as text and key order is held too.
- **D10. `getModelSummary` answers `issue_counts: null` and `undo_depth: 0`** — the schema's defaults; spec §7 fills `issue_counts` from the server.
- **D11. Error texts.** A missing element is the server's text, quote-stripping included (fact 11): `errorDetail` moves to `src/model/errors.ts` and serves both the applier and the service. `SnapshotError` maps to 422 (the spec's list would make a refused snapshot a 500). Page-bound refusals carry the engine's own texts (fact 12).
- **D12. Parse batches shrink to 500 lines, for every caller** (fact 3). Task 11 re-measures open and reports it.
- **D13. The slice target is 8 ms** under CN-3's 16 ms, and steps are sized near 1 ms at M (fact 4): 1,024 entity visits of the index build, 2,048 entities of the digest check, 512 elements of a scan, runs of 2,048 of a sort.
- **D14. The `pyLower` tables are a generated TypeScript module**, written by `pixi run golden-fixtures` beside the fixtures and guarded by the same staleness test.
- **D15. Progress events are sent at most once per slice per task**, plus the final one.
- **D16. No search result is cached between pages.** The server caches none either.

## Global Constraints

- Everything runs through pixi. There is no global `node` or `python`: `pixi run <task>`, `pixi run -e core-dev ...`, `pixi run -e frontend ...`.
- Work on branch `feat/engine-service`, cut from `engine-migration` (Task 1 cuts it) and fast-forwarded back when the plan is done (Task 11). Never touch `main`. **Commit only with the owner's go-ahead for this plan's execution** — earlier approvals do not carry over; ask before Task 1.
- **Freeze rule (MR-3):** `core/model` (with `naming.py`), `core/metamodel`, the model-op applier, and from this plan on `routes/read.py`'s route functions and helpers and `routes/elements.py::get_element` are frozen for behaviour. This plan edits none of them. The Python core is the oracle: fix the engine, never a fixture. Fixtures change only through `pixi run golden-fixtures`.
- **Engine `src/` rules:** no DOM, no Node built-in, no timer, no clock (`Date.now`, `performance.now`), no `Math.random`, no `Intl`, no locale comparison (RC-4, RC-5) — the service receives `now`, `yieldToHost` and `inflate`. Erasable syntax only (no `enum`, no parameter properties, no namespaces). Imports carry `.ts` specifiers. No `any` in an exported signature. Strings compare by code point (`cmpCodePoint`), lengths that Python counts are counted in code points.
- Tests import the engine through `engine/src/index.ts` only, as every existing test does; tests and `bench/` may use Node.
- ESLint's `require-yield` is on: a generator that can finish without yielding still holds a `yield`.
- A steps generator sets no flag and publishes no result before its last step: abandoning one midway must leave nothing behind.
- Nothing live leaves the service: every result and event is built by `toWire` (M7).
- Performance: build what is written and report the numbers. Do not optimize past the plan; the browser benchmark of plan 5 is the judge of the chunk budget.
- Formatting: `pixi run engine-tidy` formats and lints `engine/`. `pixi run dr-tidy` lints neither `tests/` nor `scripts/`: run `pixi run -e core-dev ruff check <files>` and `ruff format <files>` by hand on every Python file a task adds or edits. Pre-existing findings in a touched file are not this plan's to fix.
- The check-only lint is `pixi run dr-tidy true` (the argument is positional).
- A "see it fail" step lists the tests it expects red. A helper that touches a missing name fails every test that uses it: expect ALL of them, and treat any OTHER red test as a finding to report, not to silence.
- Comments and docstrings are concise and present-tense, only for what the code cannot say. No references to specs, plans, phases or `architecture/` ids in code.
- `architecture/`, `CLAUDE.md` and `BACKLOG-ENGINE.md` are tracked and change in the same commit as the code they describe (RC-10); `docs/` and `benchmarks/` are git-ignored — never `git add -f`.
- Commit subjects: one imperative sentence, capitalized, no prefix, no trailing period; the message ends with the session's `Co-Authored-By` line.
- Ids: this plan uses `AD-26`. The next free ones afterwards are `K-37`, `C-22`, `AD-27`.
- Baseline (2026-09-19, unchanged by `e5688f9`): core 2,551 passed / 34 deselected; frontend 2,493 tests in 252 files; engine 272 tests in 39 files.

## File Structure

```
tests/golden/lower_tables.py                 (new) derives the tables from str.lower(); renders the TS module
tests/golden/driver.py                       generated sources beside the fixtures: write() and stale() cover both
tests/golden/model_steps.py                  + the `read`, `view` and `drop_view` steps
tests/golden/scenarios/py_lower.py           (new)
tests/golden/scenarios/read_pages.py         (new) by id, pages, type filter, incident relationships, summary
tests/golden/scenarios/read_tree.py          (new) roots, children, tree items, a view with placements
tests/golden/scenarios/read_search.py        (new) tiers, unicode, tie-breaks, paging
tests/golden/scenarios/__init__.py           registers the four

engine/.prettierignore                       + /src/value/lower-tables.ts
engine/src/value/lower-tables.ts             (generated) LOWER_PAIRS, LOWER_SPECIAL, CASED_RANGES, CASE_IGNORABLE_RANGES
engine/src/value/lower.ts                    (new) pyLower, pyStrip
engine/src/steps/steps.ts                    (new) Steps, Progress, drain, sortedInSlices
engine/src/model/errors.ts                   + errorDetail (moved from ops/apply.ts)
engine/src/model/root-order.ts               + resetSteps
engine/src/model/indexes.ts                  + rebuildSteps; rebuild drains it
engine/src/model/model.ts                    + rebuildIndexSteps
engine/src/snapshot/open.ts                  batches of 500; options.pause, options.onIndex
engine/src/working/working-copy.ts           coalescing, adoptStaged, own on a duplicate, stagedVersion,
                                             ChangeSet.structural, stagedDiff, verifyDigestSteps
engine/src/working/delta.ts                  + readDeltaText, readTailText
engine/src/read/errors.ts                    (new) ReadError
engine/src/read/wire.ts                      (new) toWire, wireElement, wireRelationship, wire images, readOps
engine/src/read/params.ts                    (new) page, direction and id parameters, checked as the routes check them
engine/src/read/placements.ts                (new) ViewPlacements
engine/src/read/elements.ts                  (new) getElement, getElementsBatch, listElementsPage (listing half),
                                             listElementRelationships, getModelSummary
engine/src/read/tree.ts                      (new) treeItem, getTreeItemsBatch, the three tree pages
engine/src/read/search.ts                    (new) nameScore, searchScore, searchSteps
engine/src/read/index.ts                     (new) READS: method name → read
engine/src/service/types.ts                  (new) Port, ServiceDeps, envelopes, events, params and results
engine/src/service/scheduler.ts              (new) Scheduler
engine/src/service/byte-queue.ts             (new) an async iterable fed by push / end / fail
engine/src/service/service.ts                (new) createService: states, replica life, method table, events
engine/src/index.ts                          exports
engine/bench/run.ts                          + rows: the index build, the digest check and a search, in steps

engine/fixtures/golden/{py_lower,read_pages,read_tree,read_search}.json   (generated)
engine/test/value/lower.test.ts, lower.golden.test.ts                     (new)
engine/test/steps/steps.test.ts                                            (new)
engine/test/model/rebuild-steps.test.ts                                    (new)
engine/test/snapshot/open.test.ts                                          + pause
engine/test/working/{coalesce,adopt,verify-steps,delta-text}.test.ts       (new)
engine/test/working/{working-copy,invariants}.test.ts                      + own on a duplicate, structural, version, seeded runs
engine/test/golden/model-steps.ts                                          + the read, view and drop_view steps
engine/test/read/{pages,tree,search}.golden.test.ts, params.test.ts, wire.test.ts   (new)
engine/test/service/helpers.ts                                             (new) port pair, fake host, gzip, a tiny client
engine/test/service/{scheduler,envelope,queue,replica,staging,reads}.test.ts        (new)

CLAUDE.md, BACKLOG-ENGINE.md, architecture/{contracts,decisions,program}.md
```

`src/read/` depends on `src/model/`, `src/value/` and `src/steps/` only — a read takes a `Model`, never a service. `src/service/` is the one place that knows ports, states and queues.

## Mechanisms

Referred to by the tasks; read them before the task that uses them.

**M1 — Steps.** `Steps<T> = Generator<Progress, T, void>` with `Progress = {done: number, total: number}`: a long operation written as a generator that ends a step, by yielding where it stands, about every millisecond of work at M. `drain(steps)` runs one to its end and returns its value. Every long operation exists ONCE, in steps form, and its synchronous entry point is `drain` of it (`IndexSet.rebuild`, `Model.rebuildIndexes`, `WorkingCopy.verifyDigest`), so the two cannot drift and sub-project A's callers, tests and bench are untouched. A steps generator holds iterators over the model across its yields, which is only sound while nothing mutates the model between two of its steps; who guarantees that is part of each one's contract: the index build runs only while the replica is `opening`; a scan is protected by the queue (M3); the digest check is restarted instead (M4). A generator publishes nothing before its last step.

**M2 — `sortedInSlices(items, compare, run = 2048)`.** A bottom-up merge sort. First every run of `run` items is sorted natively in place, one step each. Then passes of doubling width merge neighbouring runs into a second buffer, ending a step every `run` items written, and the buffers swap. On a tie the LEFT run's item goes first (`compare(right, left) < 0` takes the right one), which makes it stable — the order `Array.prototype.sort` gives with the same comparator. It returns the sorted array, which is the input or the buffer: callers use the return value and drop the input. `Progress.total` is `items.length × (1 + passes)`.

**M3 — The queue.** One pump, two lanes, both in arrival order.
- The *control lane* holds the replica's own transitions — `adoptStaged`, and the deltas of an `applyTail` that arrived while `opening` — and is served in any state, before anything else.
- The *model lane* holds everything that needs a `ready` replica and is served only while the scheduler is open. Its jobs are of three kinds: a `read` (one synchronous call), a `scan` (a `Steps` generator made by `run()`), a `transition` (one synchronous call, never interrupted).
- The pump takes the head of the model lane. A `read` runs and is answered. A `transition` runs to its end and is answered; every job behind it waits for it — that is the barrier of D2, and it needs no code beyond arrival order. A `scan` runs step by step; at each slice boundary (M5), after the host's turn, every `read` that sits in the lane BEFORE the first `transition` is answered — other scans are skipped over, never started — and the scan goes on. A transition that arrived during the scan is thus still behind it.
- With both lanes empty and the scheduler open, the background task gets one slice (M4).
- `cancel(id)`: a queued job is removed; a running scan is dropped at its next step boundary; neither is ever answered. A transition that has started cannot be cancelled; one still queued can.
- Closing the scheduler (the replica diverged, or was closed) keeps every queued job. A scan that was mid-flight goes back to the head of the lane and starts over — `run()` again — when the scheduler reopens: its iterators belong to a model that is gone.
- A job that throws is answered with the error (M7); the pump goes on.

**M4 — The background digest check.** Set when the replica becomes `ready`: `{start: () => wc.verifyDigestSteps(), done}`. The pump runs one slice of it whenever both lanes are empty. After a transition that touched an entity or moved `stagedVersion`, the service calls `restartBackground()`: the generator in flight is dropped — it has published nothing (M1) — and a new one starts at the next idle slice, its progress from zero. When one completes: `true` ends the check for this replica; `false` means `diverged`. Continuous editing can starve it; it completes in the first quiet 0.3 s, and CT-3 sets no deadline.

**M5 — Slices under an injected clock.** The pump notes `deps.now()` when a slice starts and reads it again after every unit of work — a read, a transition, one step. At or past `SLICE_TARGET_MS` (8) it sends the pending progress events (D15), awaits `deps.yieldToHost()` and starts a new slice. Incoming messages are handled on those host turns, never inside a unit, so engine state is consistent whenever a handler runs. With steps near 1 ms a slice ends within 16 ms with room for a collector pause (fact 4); a transition is the exception by design (AD-23). Tests drive this with a clock that advances a fixed amount per `now()` call: a slice is then a known number of units long, and the assertion is that none exceeds 16 and none but the last of a job is shorter than the target.

**M6 — Opening.** `open` makes a `ByteQueue` — an async iterable that `chunk` feeds, `end` closes and `close` (or another `open`) fails — and starts `openSnapshot(deps.inflate(queue), metamodel, onProgress, {pause, onIndex})`. `pause` is the scheduler's: it returns `undefined` while the slice has room and otherwise the promise of M5's host turn, so the reader writes `const wait = pause(); if (wait) await wait;` after each 500-line batch and after each step of `rebuildIndexSteps()` and pays no microtask hop in the common case. Without `pause` the open behaves as today: the index build is drained. `pause` sits in the BATCH loop, not the chunk loop: a snapshot served from the shell's cache can arrive as a few large chunks, each holding many batches, so the reader must be able to stop between two batches of one chunk, and it cuts a chunk larger than 64 KiB into pieces before decoding it (the streaming decoder takes a cut anywhere). Awaiting the next chunk is not enough on its own: an async iterator whose data is already there resolves in microtasks, and messages — a `cancel`, a `close` — are macrotasks. `chunk` answers at once; `end` answers when the open settles: the header, or a 422 with the `SnapshotError`'s text. After a failed open, `chunk` and `end` answer that same 422 until the next `open`. A header whose `project_id` is not the one `open` named is refused: 422 `snapshot belongs to project 'x', not 'y'`. An `open` while a replica is open, or while another open runs, discards it first — the heap never holds two.

**M7 — The boundary.**
- *Out:* `toWire(value)` deep-copies a `Value` into plain JSON-able data — a `PyFloat` leaves as its number, a `bigint` as `Number(v)`, the loss `JSON.parse` of a server response has today — writing an own `__proto__` key as `setProp` does. Entities leave as `{id, type_name, properties, rev}` and `{id, type_name, source_id, target_id, properties, rev}`, in that field order (D9). Over a direct port pair an un-copied result would hand the caller the replica's own property bags.
- *Ops in:* `readOps(raw)` is `parseJson(JSON.stringify(raw))` followed by a shape check (a known `kind`, string ids and ends, plain-object `properties` / `properties_patch`, `temp_id` on creates); a failure is a 422 `ops[i]: …` in the engine's words and nothing is staged. `JSON.stringify` is exactly what the client applies before the server sees an op, so the exact parser then reads what the server reads: an integral double is an `int`, `1e21` a float, `-0` is `0`, `NaN` is `null`.
- *Deltas in (D3):* `readDeltaText(text)` parses with `parseJson`; takes `rev`, or `model_rev` when there is no `rev` (fact 15); refuses a `null` or missing `prev_rev` or `state_digest` and a non-object with a `SnapshotError`; reads the six lists as absent = empty. `readTailText(text)` reads `{complete, deltas}` and refuses `complete: false`.
- *Errors:* `OpError` and `ReadError` → their `status` and `detail`; `ModelError` `key` → 404 with `errorDetail(error)`, `value` → 422 with its message; `SnapshotError` → 422; an unknown method → 404 `No method 'x'`; anything else → 500 with its message.

**M8 — Coalescing.** `stage(ops, {coalesce: true})` with exactly ONE op that is an `update_element` or `update_relationship`:
1. Find the first staged (never a parked) op of the same `kind` and `id`, oldest batch first. None → stage normally.
2. Try the new op alone on top: `applyBatch(model, ops)`. Refused → the `OpError` propagates and nothing has changed. Accepted → `rewind` it at once.
3. Merge: the found op's patch becomes `{...old, ...new}` — later keys win, a `null` stays — in a NEW batch object under the same batch id, at the same place.
4. Rebase from that batch: rewind the staged batches from the newest down to it, rebuild the committed-image maps from the batches below it (their results still stand), replay it and everything above. The common case — the merge target is the newest batch — rewinds one batch and replays one.
The result names the batch merged into and says `coalesced: true`. It is never done in place (fact 18): the invariant `working copy = committed state + replay of staged()` holds to the byte, `rev`s and key order included, and the seeded tests of Task 4 assert exactly that. Step 2 exists so that a bad patch cannot park the batch that holds the user's earlier, valid edits. If the replay parks a batch all the same (an entity deleted and created again in between), it is surfaced through `conflicts()` like any rebase — never dropped.

**M9 — `structural` and `stagedVersion`.** Every operation's `ChangeSet` says `structural`: true iff it names a relationship (changed or deleted), a deleted element, or an element present now that was absent when the operation began; `applyDelta` with a non-empty `own.idMap` is structural too. A rebase over-reports touched elements, so "absent when the operation began" is asked BEFORE the rewind, of the ids the staged batches' before-images name plus the ids the change names. Relationships over-report: a rebased staged relationship makes a peer delta structural; that costs a refresh, never a stale tree. `stagedVersion` is a counter that moves on a successful `stage` and whenever a rebase leaves `staged()` or `conflicts()` holding different batch OBJECTS than before (a remap and a merge make new objects; a plain rebase keeps them; a parked batch shortens the list).

**M10 — Reads in the recorder.** `Recorder` gains three steps. `{"do": "read", "method", "params"}` calls the real route function with a `Session(metamodel=…, model=self.model, views=self._views)` built for the call and EVERY argument passed — the route's defaults restated in the recorder (`limit=100`, `offset=0`, `direction="both"`, `type=None`, `q=None`, `view_id=None`), because a direct call keeps `Query(...)` objects as defaults (fact 13) — and records `result.model_dump(mode="json")`. A `KeyError` and an `HTTPException` fall into the recorder's existing `except` clauses and are recorded as `{"kind": "key", "message"}` and `{"status", "detail"}`. `{"do": "view", "view_id", "_folders": …}` builds a `View` with nested `Folder`s, stores it, and records `placed`: `sorted(read._placed_element_ids(view))` — the flat id list the shell would register. `{"do": "drop_view", "view_id"}` removes it. A read changes nothing, so the recorder's own observation marks it `unchanged`. On the engine side `replaySteps` keeps a `ViewPlacements`, runs `READS[method](model, placements, params)`, drains a generator, and compares `JSON.stringify(result)` with `JSON.stringify(step.result)` — values and key order at once (D9); a `ModelError` compares as `{kind, message}` (the unstripped text: stripping is the service's), a `ReadError` as `{status, detail}`. The replay already shuffles adjacency before every step and runs a second time with every uniqueness key in one bucket; reads ride on both.

**M11 — The score, operation for operation.** `query = pyLower(pyStrip(q ?? ''))`; an empty one is a listing. For each element in state order, after the exact-type filter:
- `name = nameOf(element)`; if there is one: `lowered = pyLower(name)`; `ns` = 1000 when `lowered === query`, else 100 when it starts with it, else, when it contains it, 30 if SOME occurrence at index `i` has no ASCII `[a-z0-9]` right before it (or `i === 0`) and none right after it (or it ends the string), else 10; else 0. When `ns > 0`: `score += ns + cpLen(query) / cpLen(lowered)` — the length of the LOWERED name, in code points (U+0130 lowers to two).
- `idLower = pyLower(element.id)`: `+5` when equal to the query, else `+2` when it contains it.
- `+1` when `pyLower(typeName)` contains the query — memoized per type name for the scan.
- For every property in bag order whose `pyLower(key) !== 'name'` and whose value is a string containing the query once lowered: `+0.5`. A list value counts for nothing here.
- A hit is `score > 0`. Additions happen in exactly that order, in doubles, starting from `0`: equal scores on the server are then equal doubles here. Hits sort by `(-score, id)`, ids by code point, through `sortedInSlices`; `total` is the hit count before paging.
The occurrence walk replaces the route's regular expression and is equivalent to it: `re.search` tries every start, `^` and `$` are the string's ends (a trailing newline is itself a non-alphanumeric), and `[^a-z0-9]` is one character on either side.

---

### Task 1: `pyLower` and `pyStrip`

**Files:**
- Create: `tests/golden/lower_tables.py`, `tests/golden/scenarios/py_lower.py`, `engine/src/value/lower.ts`, `engine/test/value/lower.test.ts`, `engine/test/value/lower.golden.test.ts`
- Generated: `engine/src/value/lower-tables.ts`, `engine/fixtures/golden/py_lower.json`
- Modify: `tests/golden/driver.py`, `tests/golden/scenarios/__init__.py`, `engine/.prettierignore`, `engine/src/index.ts`, `CLAUDE.md`, `BACKLOG-ENGINE.md`

**Interfaces:**
- Produces: `pyLower(text: string): string` — `str.lower()` of Python 3.14, independent of the host's Unicode tables; `pyStrip(text: string): string` — `str.strip()` with no argument. Both exported from `src/index.ts`.
- `tests/golden/lower_tables.py`: `lower_pairs() -> list[tuple[int, int]]` (every non-surrogate code point whose `lower()` is one OTHER code point), `lower_special() -> dict[int, list[int]]` (more than one code point: U+0130 alone today), `cased_ranges()` and `case_ignorable_ranges() -> list[tuple[int, int]]` (inclusive; derived by behaviour: a code point `c` is *case-ignorable* iff `("a" + c + "Σ").lower()` ends in `ς` while `(c + "Σ").lower()` ends in `σ`; it is *cased* — and not ignorable — iff `(c + "Σ").lower()` ends in `ς`), `render() -> str` (the TypeScript module: a header comment naming the generator and `unicodedata.unidata_version`, then four `export const … : readonly number[]` flat arrays — pairs as `cp, lower, cp, lower, …`, ranges as `start, end, …` — and `LOWER_SPECIAL` as `cp, count, …lowered`).
- `driver.py`: `GENERATED: dict[Path, Callable[[], str]]`, holding `engine/src/value/lower-tables.ts → lower_tables.render`; `write()` writes those too; `stale()` reports one whose text differs, by its path relative to the repository. The fixture directory's leftover sweep does not touch them.
- Fixture `py_lower.json`: `unicode`; `lower` — `[[cp, lowered], …]` for every non-identity, non-surrogate code point; `cased` and `ignorable` — the two range lists; `strings` — `[[input, lowered], …]`, hand-picked: `Σ` alone, `ΑΣ`, `ΑΣ.`, `ΑΣΑ`, `ΑΣ` + U+0301 (an ignorable after it), `Α` + U+00AD + `Σ` (an ignorable before it), `ΣΣ`, `ὈΔΥΣΣΕΎΣ`, `İstanbul`, `ẞ`, U+212A, `𐐀𐐁` (astral Deseret), a string of the 28 code points of fact 8, `MiXeD ascii 123`, the empty string; `space` — every code point `str.isspace()` accepts; `stripped` — `[[input, stripped], …]` with U+001C–U+001F, U+0085, U+FEFF, U+2028, U+3000 at both ends and in the middle.

- [ ] **Step 1: Ask, then cut the branch.** Ask the owner whether commits are pre-approved for this plan. Then `git switch engine-migration && git switch -c feat/engine-service`.

- [ ] **Step 2: Write the generator, the scenario and the failing engine tests.**
  - `engine/test/value/lower.golden.test.ts`: (a) for EVERY code point outside U+D800–U+DFFF, `pyLower(String.fromCodePoint(cp))` is the fixture's `lowered` when listed and the input itself when not — one loop, one `expect` on a collected list of mismatches, so a failure prints code points, not a million lines; (b) for every such code point, `pyLower(c + 'Σ')` ends in `ς` iff `cp` is in `cased`, and `pyLower('a' + c + 'Σ')` ends in `ς` iff it is in `cased` or `ignorable`; (c) every `strings` pair; (d) `pyStrip(String.fromCodePoint(cp) + 'x' + String.fromCodePoint(cp)) === 'x'` iff `cp` is in `space`, over every code point; (e) every `stripped` pair.
  - `engine/test/value/lower.test.ts`: an ASCII string takes the native path and equals the table path's answer (compare `pyLower('ABC xyz')` with `pyLower('ABC xyz' + 'é').slice(0, -1)`); a lone surrogate passes through unchanged and nothing throws; `pyLower` does not touch U+16EA0 (the host would).
- [ ] **Step 3: See them fail.** `pixi run golden-fixtures` writes `py_lower.json` and `lower-tables.ts`; then `pixi run engine-test`. Expected red: both new files, at import (`pyLower` is not exported). Everything else green.
- [ ] **Step 4: Implement `lower.ts`.** ASCII fast path: a string matching `/^[\x00-\x7f]*$/` is `text.toLowerCase()` — ASCII lowering is the same in every Unicode version. Otherwise walk code points: U+03A3 goes through the final-sigma rule — scan backwards over case-ignorables; the first other code point must be cased; then scan forwards over case-ignorables; the first other code point must NOT be cased (or the string ends) → `ς`, else `σ`; any other code point maps through `LOWER_SPECIAL`, then `LOWER_PAIRS`, else stays. Lookups are binary searches over the flat arrays (or a `Map` built on first use); ranges by binary search over starts. `pyStrip` trims by the set of fact 9, stated as a literal list in the source — it is 29 code points and no table.
- [ ] **Step 5: See them pass**, then `pixi run -e core-dev pytest tests/golden -q` (the staleness test covers the new fixture and the generated module) and `pixi run engine-check`.
- [ ] **Step 6: Lint.** `pixi run engine-tidy`; ruff check + format by hand on `tests/golden/lower_tables.py`, `tests/golden/driver.py`, `tests/golden/scenarios/py_lower.py`. Add `/src/value/lower-tables.ts` to `engine/.prettierignore` BEFORE running prettier.
- [ ] **Step 7: Docs.** `CLAUDE.md`, "Engine package", the `src/value/` bullet: `pyLower` / `pyStrip` mirror `str.lower()` / `str.strip()` of Python 3.14 whatever Unicode version the host carries — generated tables (`lower-tables.ts`, written by `pixi run golden-fixtures`, never by hand) plus Python's final-sigma rule, held to `py_lower.json` over every code point. In the "Golden fixtures" bullet: the task also writes that one generated source, and the staleness test guards it. `BACKLOG-ENGINE.md`, the header's freeze sentence: add `routes/read.py`'s route functions and `routes/elements.py::get_element`, frozen from the start of B's third plan.
- [ ] **Step 8: Commit** (with the owner's go-ahead): `Lower and strip strings as Python does`.

---

### Task 2: Steps — the index build, the digest check, the sort

**Files:**
- Create: `engine/src/steps/steps.ts`, `engine/test/steps/steps.test.ts`, `engine/test/model/rebuild-steps.test.ts`, `engine/test/working/verify-steps.test.ts`
- Modify: `engine/src/model/root-order.ts`, `engine/src/model/indexes.ts`, `engine/src/model/model.ts`, `engine/src/working/working-copy.ts`, `engine/src/index.ts`, `CLAUDE.md`

**Interfaces:**
- Produces, in `steps.ts`: `type Progress = {done: number; total: number}`; `type Steps<T> = Generator<Progress, T, void>`; `drain<T>(steps: Steps<T>): T`; `sortedInSlices<T>(items: T[], compare: (a: T, b: T) => number, run?: number): Steps<T[]>` (M2).
- `RootOrder.resetSteps(roots: ElementRec[]): Steps<void>`; `reset` drains it.
- `IndexSet.rebuildSteps(): Steps<void>` — today's `rebuild`, the same passes in the same order, ending a step every 1,024 entity visits, then `yield* this.roots.resetSteps(roots)` with its progress folded into the build's own; `Progress.total` is `2 × elements + relationships + 1`, the sort holding at `total − 1` and the last yield reaching `total`. `rebuild()` is `drain(this.rebuildSteps())`. Contract, in its doc comment: nothing may read the indexes or write the model between two steps.
- `Model.rebuildIndexSteps(): Steps<void>`; `rebuildIndexes()` drains it.
- `WorkingCopy.verifyDigestSteps(): Steps<boolean>` — today's three loops, a step every 2,048 entities, `total` = elements + relationships + the two committed-image maps' sizes; `diverged` is set, if at all, after the last step. `verifyDigest()` drains it. Contract: a transition between two steps invalidates it — drop it and start another.

- [ ] **Step 1: Write the failing tests.**
  - `steps.test.ts`: `drain` returns the generator's value and runs every step. `sortedInSlices` against `[...items].sort(compare)` for seeded arrays of length 0, 1, `run − 1`, `run`, `run + 1` and `10 × run + 7` (with `run = 8` so the test is fast, and once with the default on 5,000 items); with a comparator full of ties, each item carrying its input index — equal keys keep input order; no merge step makes more than `run` comparisons and no run step sorts more than `run` items (count comparator calls between yields); `Progress.done` never decreases and the last is `total`.
  - `rebuild-steps.test.ts`: on three models — `family()` of `test/model/fixtures.ts`, the smart-city example loaded as `smart-city.golden.test.ts` loads it (through the fixture's `model_file`), and a seeded model grown as `invariants.test.ts`'s `grow` grows one (3,000 entities, so that the build spans several steps) — after `shuffleAdjacency`: a model rebuilt through `drain(model.rebuildIndexSteps())` and a `clone` rebuilt through `rebuildIndexes()` give equal `dumpIndexes`, and `verifyConsistent` holds; successive `done` values differ by at most 1,024 until the sort; the last progress is `{done: total, total}`.
  - `verify-steps.test.ts`: drained, it equals `verifyDigest()` — true on a fresh replica; true with staged batches that update, delete and create (the committed images stand in); false once a record's `rev` is tampered with, and `diverged` flips only then; a generator abandoned after its first step leaves `diverged` false on that tampered replica.
- [ ] **Step 2: See them fail.** `pixi run engine-test`. Expected red: the three new files (missing exports / methods). The 272 existing tests, plus Task 1's, stay green.
- [ ] **Step 3: Implement** `steps.ts`, then `resetSteps`, `rebuildSteps`, `rebuildIndexSteps`, `verifyDigestSteps`, each synchronous form becoming a `drain`. `RootOrder.reset` keeps its comparator; only the sort call changes.
- [ ] **Step 4: See them pass**; the whole engine suite with them — the golden replays call `rebuildIndexes()` thousands of times through `verifyConsistent` and must not slow down noticeably (say so in the hand-back if the suite's wall time moves by more than a quarter).
- [ ] **Step 5: Lint.** `pixi run engine-check && pixi run engine-tidy`.
- [ ] **Step 6: `CLAUDE.md`.** A new bullet after `src/snapshot/`: **`src/steps/`** — what a `Steps` generator is, that every long operation exists once in that form and its synchronous name drains it, the no-publication-before-the-last-step rule, `sortedInSlices` and its measured price (twice the native sort, no step over 2 ms at M), and who keeps the model still for each of the three users.
- [ ] **Step 7: Commit:** `Run the index build, the digest check and big sorts in steps`.

---

### Task 3: A snapshot open that yields

**Files:** Modify `engine/src/snapshot/open.ts`, `engine/test/snapshot/open.test.ts`, `CLAUDE.md`.

**Interfaces:**
- Consumes: `Model.rebuildIndexSteps()`.
- Produces: `OpenOptions` gains `pause?: () => Promise<void> | undefined` and `onIndex?: OpenProgress`. `BATCH_LINES` is 500 (D12). With `pause`, the reader calls it after every loaded batch and after every step of the index build, awaiting only a returned promise (M6), and reports the build's progress through `onIndex(done, total)`. Without it nothing changes but the batch size.

- [ ] **Step 1: Write the failing tests** (additions to `open.test.ts`; the fixture text is the `snapshot_v2` fixture's, as the file already uses):
  - `pause is asked after every batch and every index step` — a spy that returns `undefined`: called at least once per 500 lines and at least once during the build; the opened replica's `modelLines`, `dumpIndexes` and digest equal those of an open without `pause`.
  - `one large chunk still pauses between its batches` — the whole text of a 2,000-entity seeded model handed over as ONE chunk: `pause` is called at least four times before `onProgress` reports the total.
  - `a returned promise is awaited` — a `pause` that returns a promise every third call and logs `paused` / `resumed`; a log entry from `onProgress` never falls between a `paused` and its `resumed`.
  - `onIndex ends at its total`; `onProgress` still ends at `(total, total)`.
  - `a refusal still surfaces through a paused open` — the cut-text case of the fixture's `refused` list rejects with the same `SnapshotError` text.
- [ ] **Step 2: See them fail** — the five new tests (unknown options are ignored, so the spies are never called). `open.golden.test.ts` stays green.
- [ ] **Step 3: Implement.** Keep the count check BEFORE the last lines are parsed, as today.
- [ ] **Step 4: See them pass**, with `open.golden.test.ts` (byte cuts) and `replica.golden.test.ts`.
- [ ] **Step 5: Lint**, then `CLAUDE.md`, the `src/snapshot/` bullet: lines are parsed and loaded 500 at a time (the largest batch that stays a short step: at 2,000 the worst batch was 36 ms at M, *measured*); `pause` and `onIndex`, and why awaiting the next chunk is not a yield.
- [ ] **Step 6: Commit:** `Let a snapshot open yield between batches`.

---

### Task 4: Working copy — coalescing, `adoptStaged`, own on a duplicate

**Files:**
- Create: `engine/test/working/coalesce.test.ts`, `engine/test/working/adopt.test.ts`
- Modify: `engine/src/working/working-copy.ts`, `engine/src/index.ts`, `engine/test/working/working-copy.test.ts`, `engine/test/working/invariants.test.ts`, `CLAUDE.md`, `architecture/contracts.md`

**Interfaces:**
- `ChangeSet` gains `structural: boolean` (M9).
- `stage(ops, options?: {coalesce?: boolean}): {batch: StagedBatch; coalesced: boolean; changes: ChangeSet}` (M8). Without the option: today's behaviour, `coalesced: false`.
- `adoptStaged(batches: readonly StagedBatch[]): {changes: ChangeSet; conflicts: readonly Conflict[]}` — on a working copy with nothing staged and nothing parked (else `ModelError('value', 'Staged batches can only be adopted by a replica that has none')`): applies each batch in the order given under ITS id, parks the refused ones, and numbers the next staged batch past the highest id. One operation, one change set.
- `applyDelta(delta, own?)`: when the delta is a `duplicate` and `own` names a batch that is still staged or parked, it rebases with `adopt(own)` and returns `{status: 'duplicate', changes}`; otherwise a duplicate stays a no-op.
- `get stagedVersion(): number` (M9).
- `stagedDiff(): {elements: {id: string; before: ElementImage | null; after: ElementRec | null}[]; relationships: {id: string; before: RelImage | null; after: RelRec | null}[]}` — one pair per id in the committed-image maps, in their first-touch order.
- The private `rebase` takes the index to rebase from (M8, step 4).

- [ ] **Step 1: Write the failing tests.** Helpers from `test/working/helpers.ts` (`Server`, `workingCopy`, `clone`) and `RandomOps`.
  - `coalesce.test.ts`:
    - `two updates of one element become one op` — one batch, its id the first's, patch `{...first, ...second}`, a `null` kept, `coalesced: true`.
    - `the merged op keeps its place` — stage update X, update Y, then a coalescing update X: `staged()` is `[X', Y]`, and the model's lines and index dump equal a clone of the committed state with `staged()` replayed.
    - `it merges into the first op of that kind and id, inside a larger batch too`.
    - `a deleted key that is set again stays where it was` — fact 18's case, asserted on `elementLine`.
    - `a refused patch leaves no trace` — an undeclared property: `OpError` 422 with the applier's text; `staged()` (same objects), `conflicts()`, lines, dump and `stagedVersion` unchanged.
    - `nothing coalesces without the option, for two ops, for a create or a delete, for an id met for the first time, or into a parked batch`.
    - `the committed image stays the first one` — after five coalesced edits `committedElement(X)` is the pre-staging state and `unstage({batch})` restores it.
  - `adopt.test.ts`: batches land under their ids and the next `stage` gets `max + 1`; a batch that no longer applies is parked with its `OpError` while later ones apply; refused on a working copy that has something staged; `stagedVersion` moves.
  - `working-copy.test.ts`: `a duplicate that names the user's own batches still drops them` — land the user's batch on a `Server`, apply the delta WITHOUT `own` (the echo first: the staged create now exists twice, under its temp id and its real one), then again WITH `own`: status `duplicate`, the batch is gone, the temp ids in the remaining batches are rewritten, and the state equals the server's plus a replay of what is left. `a batch its own echo parked is dropped too` — the user's batch deletes an element; the echo's rebase parks it (`No element with id …`); the duplicate with `own` empties `conflicts()`. `a duplicate without own changes nothing`. `structural`, one case per clause of M9: a property-only stage is not; a create, a delete, any relationship op, the unstage of a staged create and of a staged delete are; a peer delta that only changes properties while three renames are staged is not; a delta that adds an element is; `own` with an id map is. `stagedVersion`: moves on stage, on a merge, on an unstage that removed something, on an own-commit drop, on a rebase that parks a batch; stays on a delta that leaves the lists alone and on an unstage that matched nothing. `stagedDiff`: an update (both sides), a create (`before: null`), a delete (`after: null`) with its cascade-deleted relationship, in first-touch order.
  - `invariants.test.ts`, two seeded runs in the file's existing style: (a) a random walk of coalescing single-op updates, plain batches, `Server` deltas and unstages — after every operation `observe(wc.model)` equals `observe` of a clone of the server's state with `wc.staged()` replayed through plain `stage`, and `verifyConsistent` holds; (b) `adoptStaged(wc.staged())` on a fresh replica of the same committed state gives the same `observe` and the same conflicts as restaging one by one.
- [ ] **Step 2: See them fail.** `pixi run engine-test`. Expected red: both new files and the new cases (missing methods, missing `structural`, a duplicate that is a no-op). If an EXISTING test compares a whole `ChangeSet` with `toEqual`, it goes red on the new field: add `structural` to its expectation — that is this task's to update, and the only kind of existing assertion that may move.
- [ ] **Step 3: Implement**, in this order: `structural` and the presence capture in `rebase`; `stagedVersion`; the partial rebase; `stage`'s option; `adoptStaged`; the duplicate branch; `stagedDiff`.
- [ ] **Step 4: See them pass**; then the whole suite and `pixi run engine-bench` once to see that staging and rebasing did not move (report the rows `stage`, `unstage`, `rebase`, `delta` next to `K-32`'s numbers: 44, 39, 14, 8.9 ms).
- [ ] **Step 5: Lint.**
- [ ] **Step 6: Docs.** `CLAUDE.md`, the `src/working/` bullet: coalescing (the rule, that it is a rebase from the merged batch and why it is never in place), `adoptStaged`, a duplicate with `own`, `stagedVersion`, `structural` and its deliberate over-report, `stagedDiff`. `architecture/contracts.md`, CT-5: to item 2, "A property update staged alone merges into the first staged update of the same entity, which keeps its place and its first before-image; the result is the state a replay of the staged ops gives"; to item 3, "With the user's own commit named, a delta that arrives as a duplicate still drops the batches it committed"; a new item 7, "`adoptStaged` replays staged batches, under their ids, on a freshly opened replica — what a re-bootstrap carries over — parking what no longer applies."
- [ ] **Step 7: Commit:** `Coalesce staged updates and carry staged batches to a new replica`.

---

### Task 5: Reads I — wire shapes, by-id reads, pages, incident relationships, summary

**Files:**
- Create: `engine/src/read/errors.ts`, `wire.ts`, `params.ts`, `placements.ts`, `elements.ts`, `index.ts`; `tests/golden/scenarios/read_pages.py`; `engine/test/read/pages.golden.test.ts`, `params.test.ts`, `wire.test.ts`
- Generated: `engine/fixtures/golden/read_pages.json`
- Modify: `tests/golden/model_steps.py`, `tests/golden/scenarios/__init__.py`, `engine/src/model/errors.ts`, `engine/src/ops/apply.ts`, `engine/test/golden/model-steps.ts`, `engine/src/index.ts`, `CLAUDE.md`

**Interfaces:**
- `ReadError extends Error {status: number; detail: string}`.
- `wire.ts`: `toWire(value: Value): unknown`; `type WireElement = {id; type_name; properties; rev}`, `type WireRelationship` (with `source_id`, `target_id` after `type_name`); `wireElement(rec: ElementRec)`, `wireRelationship(rec: RelRec)`, `wireElementImage(image)`, `wireRelImage(image)`; `readOps(raw: unknown): ModelOp[]` (M7).
- `params.ts`: `MAX_PAGE_LIMIT = 500`; `pageOf(params): {limit: number; offset: number}` — `limit` absent → 100, else an integer 1…500 or `ReadError(422, 'limit must be an integer from 1 to 500')`; `offset` absent → 0, else an integer ≥ 0 or `ReadError(422, 'offset must be an integer of at least 0')`; `directionOf(params)` — absent → `'both'`, else one of the three or 422 `direction must be 'both', 'in' or 'out'`; `idOf(params)` and `idsOf(params)` — 422 `id must be a string` / `ids must be a list of strings`; `idsOf` raises the ROUTE's `too many ids: N (max 500)` past 500.
- `placements.ts`: `class ViewPlacements { set(viewId: string, elementIds: readonly string[]): void; drop(viewId: string): void; placed(viewId: string | null | undefined): ReadonlySet<string> }` — an unknown, empty or absent view gives the empty set.
- `errors.ts` of `src/model/`: `errorDetail(error: ModelError): string` moves here from `ops/apply.ts`, unchanged, exported.
- `elements.ts` — every read is `(model: Model, placements: ViewPlacements, params: {[key: string]: unknown}) => result | Steps<result>`, the signature `READS` and the recorder's replay share:
  - `getElement {id}` → `WireElement`; unknown → `model.getElement`'s `ModelError`.
  - `getElementsBatch {ids}` → `{items}`: request order, duplicates kept, unknown ids omitted.
  - `listElementsPage {type?, q?, limit?, offset?}` → `{items, total}`. In this task the listing half only: `type` absent or `null` = no filter, any string filters by exact type name; `total` from `model.elementCount` or the type's `byType` set; items by walking `model.elements()` in state order. A non-blank `q` throws `ReadError(500, 'search is not built yet')` until Task 7.
  - `listElementRelationships {id, direction?, limit?, offset?}` → `{items, total}`: 404 for an unknown element; ids sorted by code point; `both` names a self-loop once.
  - `getModelSummary {}` → `{model_rev, element_count, relationship_count, elements_by_type, issue_counts: null, undo_depth: 0}` in that order, `elements_by_type` with its keys sorted by code point. `model_rev` comes from `params.model_rev` (the service passes the committed `rev`; the golden replay passes 0).
- `index.ts`: `READS: {[method: string]: Read}` and the `Read` type.
- Recorder and replay: M10's three steps (the `view` steps are used from Task 6 on; add all three now so the step machinery changes once).

- [ ] **Step 1: Write the scenario and the failing tests.**
  - `read_pages.py` — a metamodel of its own: `Node` (`name: string`, `note: string`, `weight: float`, `tags: string 0..*`, `peer: Node`), `Leaf extends Node`, `Owns` (containment, `Node → Node`), `Links` (`Node → Node`, property `label: string`). Steps: about thirty elements of both types with names, a float `1.0`, an integer past 2^53, a nested dict with unsorted keys, a list-valued `Name`; relationships including a self-loop `Links` and two parallel `Links`; then reads: `getElement` known and unknown (the 404's `KeyError`); `getElementsBatch` with duplicates, unknown ids, the empty list, and 501 ids (422); `listElementsPage` whole, `limit 7` at offsets 0, 7, 28 and past the end, `type: "Leaf"`, `type: "Node"` (exact: no `Leaf`), an unknown type, `type` with `offset` past its total; `listElementRelationships` for the self-loop's element in all three directions, for a hub with `limit 2` at offsets 0 and 2, for an element with none, for an unknown id; `getModelSummary`; then CHURN — delete an element with children, `restore_element` it, delete the last element of a type, rename — and the same reads again (state order after a restore appends; the emptied type leaves `elements_by_type`).
  - `pages.golden.test.ts`: `replaySteps(loadFixture('read_pages'))` and once more with the forced-collision hash, as the other golden tests do.
  - `params.test.ts`: `pageOf` — defaults; 1 and 500 pass; 0, 501, 1.5, `'7'` and `null` for `limit` are 422 with the text above; −1 for `offset`; `directionOf`; `idsOf` with a non-array and a non-string member.
  - `wire.test.ts`: `toWire` — a `PyFloat` is its number, a `bigint` a number, nested lists and dicts are copies (mutating the copy leaves the source), an own `__proto__` key survives as an own key; `wireElement` field order by `JSON.stringify`. `readOps` — `{a: 1.5, b: 1, c: 1e21, d: -0, e: NaN, f: 2 ** 60}` in a patch becomes `PyFloat(1.5)`, `1`, `PyFloat(1e21)`, `0`, `null`, `1152921504606846976n`; an unknown `kind`, a missing `id`, a non-object patch and a non-array are 422 `ops[…]: …`; an `undefined` property is dropped as `JSON.stringify` drops it.
- [ ] **Step 2: See them fail.** `pixi run golden-fixtures`, then `pixi run engine-test`. Expected red: the three new test files (no `src/read/`), and nothing else — the existing golden files do not use the new steps.
- [ ] **Step 3: Implement.** Move `errorDetail` first and see `ops/refused.golden.test.ts` still green. Then `wire.ts`, `params.ts`, `placements.ts`, `elements.ts`, `index.ts`, the replay's new cases.
- [ ] **Step 4: See them pass**; `pixi run -e core-dev pytest tests/golden -q`.
- [ ] **Step 5: Lint.** `pixi run engine-tidy`; ruff by hand on `model_steps.py`, `read_pages.py`, `scenarios/__init__.py`.
- [ ] **Step 6: `CLAUDE.md`.** A new bullet **`src/read/`**: a port of `routes/read.py` (and `get_element`) rule for rule; a read takes a `Model`, returns the HTTP response body in pydantic's field order, and is a plain call or a `Steps` generator; `READS` maps the `lib/api` names to them; `toWire` / `readOps` and why each exists; `ViewPlacements`; page-bound refusals are the engine's own texts because FastAPI, not the route, enforces them. In "Golden fixtures": the `read`, `view` and `drop_view` steps, that a `read` calls the real route function with every argument passed, and that results compare as JSON text.
- [ ] **Step 7: Commit:** `Read elements, pages, relationships and the summary from the engine`.

---

### Task 6: Reads II — the containment tree

**Files:**
- Create: `engine/src/read/tree.ts`, `tests/golden/scenarios/read_tree.py`, `engine/test/read/tree.golden.test.ts`
- Generated: `engine/fixtures/golden/read_tree.json`
- Modify: `engine/src/read/index.ts`, `tests/golden/scenarios/__init__.py`, `CLAUDE.md`

**Interfaces:**
- Consumes: `READS`, `pageOf`, `idOf`, `idsOf`, `ViewPlacements`, `displayName`, `model.indexes.roots.list()`.
- Produces: `treeItem(model, element): {id, type_name, display_name, child_count}` — `child_count` is the number of DISTINCT targets of the element's outgoing containment relationships whose `parents[0].source` is this element; `getTreeItemsBatch {ids}` → `{items}` (the batch contract of Task 5); `listContainmentRoots {limit?, offset?}` → `{items, total}` off the maintained root order; `listExcludedRoots {view_id?, limit?, offset?}` — the root order minus `placements.placed(view_id)`, `total` counted over the whole walk; `listContainmentChildren {id, limit?, offset?}` — 404 for an unknown element; the distinct first-parent children sorted by `(displayName, id)`, both by code point.

- [ ] **Step 1: Write the scenario and the failing test.** `read_tree.py`, the metamodel of Task 5 plus `Holds extends Owns`: a forest with named and unnamed roots (an unnamed root sorts by its id), names that differ only by case and names with astral and high-BMP characters (`""` against `"\U00010000"`: code point order, not UTF-16), a child with TWO containment parents (first wins; the second parent's `child_count` does not count it), two parallel containment edges from one parent to one child (one child), a containment edge of the subtype, a three-level chain. Reads: roots whole and paged (`limit 3`, offsets 0, 3, past the end); children of each interesting parent, paged; `getTreeItemsBatch` with duplicates, an unknown id and 501 ids; `listExcludedRoots` with no view, with an unknown view, and after a `view` step whose nested folders place two roots and one NON-root id (placing a non-root changes nothing); after `drop_view`. Then churn: disconnect the first parent of the two-parent child (it moves), rename a root (it re-sorts), delete a subtree, restore a relationship under its old id with `restore_relationship` — and the reads again.
- [ ] **Step 2: See it fail.** `pixi run golden-fixtures && pixi run engine-test`: `tree.golden.test.ts` red at its first tree read (`READS` has no such method).
- [ ] **Step 3: Implement `tree.ts`** and register the five reads.
- [ ] **Step 4: See it pass**, twice as always (plain hash, forced collisions), adjacency shuffled by the replay.
- [ ] **Step 5: Lint**; `CLAUDE.md`: complete the `src/read/` bullet with the tree rules (first containment parent wins, distinct children, `(displayName, id)` by code point, the excluded pool and what registers a view's placements).
- [ ] **Step 6: Commit:** `Read the containment tree from the engine`.

---

### Task 7: Reads III — fuzzy search

**Files:**
- Create: `engine/src/read/search.ts`, `tests/golden/scenarios/read_search.py`, `engine/test/read/search.golden.test.ts`, `engine/test/read/search.test.ts`
- Generated: `engine/fixtures/golden/read_search.json`
- Modify: `engine/src/read/elements.ts`, `tests/golden/scenarios/__init__.py`, `CLAUDE.md`

**Interfaces:**
- Consumes: `pyLower`, `pyStrip`, `nameOf`, `sortedInSlices`, `cmpCodePoint`, `pageOf`.
- Produces: `nameScore(lowered: string, query: string): number`; `searchScore(element: ElementRec, query: string, typeMatches: boolean): number`; `searchSteps(model, {type, query, limit, offset}): Steps<{items: WireElement[]; total: number}>` (M11) — a step every 512 elements, then `yield*` the hit sort, then the page. `listElementsPage` returns `searchSteps(…)` for a non-blank `pyLower(pyStrip(q))` and the listing otherwise; its `Read` type already allows a generator.

- [ ] **Step 1: Write the scenario and the failing tests.** `read_search.py`, Task 5's metamodel. Elements built to hit every rule of M11 once: the four name tiers on one query (`some_name` exact, `some_name_x` prefix, `left some_name right` and `a_some_name` word-boundary, `pretextsome_name` substring); the length bias (`ab` against `abc` for `q=ab`); an id that equals the query and one that contains it (ids chosen with `restore_element`); a type name that contains it; string properties that contain it (two of them: `+1.0`), a `Name`-cased second key that must NOT count as a weak signal, a list-valued name whose first non-empty entry is the name; an element that matches through nothing (no hit). Unicode: a name `İstanbul` queried by `i̇s` (the lowered name is one code point longer than the name); `ΟΔΟΣ` queried by `οδος` (final sigma); U+212A in a name queried by `k` and the boundary it makes; an astral name for the code-point length; queries wrapped in U+001F and U+0085 (stripped) and in U+FEFF (not stripped: no hit); a blank and a whitespace-only `q` (a listing). Tie-breaks: several elements of equal score whose ids are `id-10`, `id-2`, and a `""` / `"\U00010000"` pair. Paging: `limit 2` at offsets 0, 2 and past the end, `total` constant; `type` combined with `q`. Then a rename and a delete, and the queries again.
  - `search.golden.test.ts`: the replay, twice.
  - `search.test.ts`: `nameScore` on overlapping occurrences (`aa` in `aaa`, `a.a` cases) and on a query that itself holds non-alphanumerics; `searchSteps` over a seeded model of 3,000 elements ends a step at least every 512 elements and its drained result equals a one-shot scoring with a native sort; a generator abandoned midway has touched nothing.
- [ ] **Step 2: See them fail.** `pixi run golden-fixtures && pixi run engine-test`: both new files red — the golden one on Task 5's placeholder `ReadError`.
- [ ] **Step 3: Implement** M11; remove the placeholder.
- [ ] **Step 4: See them pass.** If a score differs from the oracle's in a late digit, the additions are in another order than M11's: fix the order, never round.
- [ ] **Step 5: Lint**; `CLAUDE.md`: the search paragraph of `src/read/` — a full scan in steps (no trigram index, AD-13), `pyStrip` then `pyLower`, the LOWERED name's length in code points, the occurrence walk that stands in for the route's regular expression, the order of the additions, `(-score, id)` through `sortedInSlices`, and that no result is kept between pages.
- [ ] **Step 6: Commit:** `Search elements in the engine`.

---

### Task 8: The scheduler

**Files:** Create `engine/src/service/scheduler.ts`, `engine/test/service/helpers.ts` (its fake host), `engine/test/service/scheduler.test.ts`. Modify `engine/src/index.ts`, `CLAUDE.md`.

**Interfaces:**
- `type HostDeps = {yieldToHost(): Promise<void>; now(): number}`; `SLICE_TARGET_MS = 8`.
- `type Job<T> = {kind: 'read'; run(): T} | {kind: 'scan'; run(): Steps<T>} | {kind: 'transition'; run(): T}`; `type Outcome<T> = {ok: true; value: T} | {ok: false; error: unknown}`.
- `class Scheduler`: `constructor(deps: HostDeps, hooks?: {onSliceEnd?(): void})`; `submit<T>(id: string | number, lane: 'control' | 'model', job: Job<T>, done: (outcome: Outcome<T>) => void): void` — `done` is called once, or never when cancelled (a callback, not a promise: a cancelled request leaves nothing dangling); `cancel(id): void`; `setOpen(open: boolean): void`; `setBackground(task: {start(): Steps<boolean>; progress?(p: Progress): void; done(result: boolean): void} | null): void`; `restartBackground(): void`; `pause(): Promise<void> | undefined` (M6); `whenIdle(): Promise<void>` (for tests and for `close`). The control lane takes `transition` and `read` jobs only.
- `helpers.ts`: `fakeHost({tick})` → `{deps, slices: number[], turn(): void, auto: boolean}` — `now()` advances `tick` ms per call; `yieldToHost()` records the slice's length and resolves on `turn()`, or on the next macrotask (`setImmediate`) when `auto`.

- [ ] **Step 1: Write the failing tests**, all with scripted jobs that log to an array — no model here:
  - `jobs run in arrival order`; `a control job runs before model jobs and while closed`; `model jobs wait while closed and run on setOpen(true)`.
  - `a transition waits for the scan before it and holds the reads behind it` (D2) — submit scan S (20 steps), read R1, transition T, read R2 with `tick = 3`: the log is R1 (between S's slices), S's answer, T, R2 — never T or R2 before S's answer.
  - `a second scan waits for the first; reads pass both`.
  - `cancel` — a queued job is never run and `done` never called; a running scan stops at its next step and the next job runs; a started transition completes; an unknown id is ignored.
  - `a job that throws is answered with its error and the pump goes on`.
  - `closing mid-scan restarts the scan on reopen` — `run()` is called twice, `done` once.
  - `the background runs only when idle, one slice at a time`; `restartBackground drops the generator in flight and starts a new one` (progress returns to zero; the dropped one is never resumed); `done(false)` is delivered; a background that finished is not started again.
  - `no slice exceeds 16 ms and none but a job's last is under the target` — `tick = 3` over a 100-step scan, a burst of 50 reads and a background of 40 steps: every recorded slice is 9 ms. With `tick = 1`: 8 ms. `a transition is never split` — a transition whose `run` calls `now()` six times stays inside one slice.
  - `pause` returns `undefined` inside a slice and a promise once the target has passed; after the promise resolves a new slice has begun.
- [ ] **Step 2: See them fail** — the whole file, at import.
- [ ] **Step 3: Implement** M3, M4's scheduling half and M5. One `async` pump, started by `submit`, `setOpen(true)` and `setBackground`, that returns when there is nothing to do; never two pumps.
- [ ] **Step 4: See them pass.**
- [ ] **Step 5: Lint**; `CLAUDE.md`: a new bullet **`src/service/`**, for now the scheduler — the lanes, the three job kinds, the barrier rule in one sentence and the probe behind it (a `Map` iterator re-reads everything after `byOrd`'s clear-and-refill), cancel, the restart on reopen, the background task, the 8 ms target under the 16 ms chunk and the collector pauses that motivate it.
- [ ] **Step 6: Commit:** `Schedule engine work in slices`.

---

### Task 9: The service — envelope, replica life, events

**Files:**
- Create: `engine/src/service/types.ts`, `byte-queue.ts`, `service.ts`; `engine/test/working/delta-text.test.ts`; `engine/test/service/envelope.test.ts`, `replica.test.ts`
- Modify: `engine/src/working/delta.ts`, `engine/test/service/helpers.ts`, `engine/src/index.ts`, `CLAUDE.md`, `architecture/contracts.md`, `architecture/decisions.md`

**Interfaces:**
- `types.ts`: `type Port = {post(message: unknown, transfer?: readonly ArrayBuffer[]): void; onMessage(handler: (message: unknown) => void): void}`; `type ServiceDeps = HostDeps & {inflate(chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array>}`; `type ReplicaState = 'opening' | 'ready' | 'diverged'`; the envelopes of CT-4; the events — `{event: 'replica', state, rev: number | null}`, `{event: 'progress', task: 'parse' | 'index' | 'tail' | 'verify', done, total}`, `{event: 'changed', rev, staged_version, element_ids, relationship_ids, deleted_element_ids, deleted_relationship_ids, structural}`; a params and a result type per method.
- `createService(port: Port, deps: ServiceDeps): void`.
- `delta.ts`: `readDeltaText(text: string): Delta`, `readTailText(text: string): Delta[]` (M7).
- `ByteQueue`: `push(bytes: Uint8Array)`, `end()`, `fail(error)`, `[Symbol.asyncIterator]()`.
- Replica methods (answered in any state, D8), in this task:
  - `open {project_id, metamodel}` → `null`. Builds `Metamodel.fromJSON` (a throw is a 422), discards any replica or running open, state `opening`, M6.
  - `chunk {bytes: ArrayBuffer}` → `null`; 409 `no snapshot is being opened` without an open.
  - `end {}` → the `SnapshotHeader`.
  - `adoptStaged {batches: {id, ops}[]}` → `{changes, conflicts}`; each batch's ops pass through `readOps`; 409 `replica is not waiting for staged batches` unless a replica is open and not yet `ready`. A control-lane transition.
  - `applyTail {text}` → `{status: 'applied' | 'gap', rev, applied, diverged}`. One transition job per delta, all submitted at once so that nothing slips between them — on the control lane while `opening`, on the model lane while `ready`; 409 while `diverged` or before `end`. Duplicates are skipped; the first `gap` makes the rest a no-op. Emits `progress tail` per delta. While `opening`, a tail that ends applied and not diverged makes the replica `ready`: `replica {state: 'ready', rev}`, the scheduler opens, the digest check is set (M4).
  - `applyDelta {text, own?: {batch_ids: number[], id_map: {[temp: string]: string}}}` → `{status, rev, diverged}`; a model-lane transition; 409 `replica is not ready` otherwise (D8).
  - `close {}` → `null`: drops the replica and any running open (a pending `end` answers 409 `replica closed`), closes the scheduler, clears the background, state `opening`, `replica {state: 'opening', rev: null}`. View placements and queued model jobs stay.
- After every transition that ran while `ready` and changed something: a `changed` event, and `restartBackground()`. A working copy that reports `diverged` — after a delta, or from the digest check — makes the state `diverged`: event, scheduler closed, background cleared.
- `helpers.ts` gains: `portPair()` (two ports that deliver on a microtask), `connect(host?)` → a client with `call(method, params, transfer?)` (rejects with the `{status, detail}` of an error answer), `post(raw)`, `cancel(id)`, `events`, `nextEvent(match)`; `gzChunks(text, size)` and an `inflate` built on `node:zlib`; `smartCity()` (the example model, loaded as `smart-city.golden.test.ts` loads it); `snapshotText(model, {projectId, rev, metamodelId})` (the header, then `modelLines`, its digest from `test/golden/digest.ts`); `openReplica(client, model, options?)` — the whole D4 sequence with an empty tail.

- [ ] **Step 1: Write the failing tests.**
  - `delta-text.test.ts`: a commit event's text reads as a `Delta`; a commit RESPONSE's text reads alike, `rev` taken from `model_rev`, its extra fields ignored; `prev_rev: null`, a missing `state_digest`, an array and broken JSON are `SnapshotError`s; **exactness** — a text holding `1.0`, `9007199254740993` and `-0.0` in a property, applied through `applyDelta`, leaves an `elementLine` that prints `1.0`, `9007199254740993` and `-0.0`; `readTailText` returns the deltas in order and refuses `complete: false`.
  - `envelope.test.ts`: the answer carries the request's `id`; a message without `id` or `method` is ignored; an unknown method is 404 `No method 'x'`; a bug thrown inside a method is a 500 with its message; after any error the next request is served.
  - `replica.test.ts`:
    - `a replica opens from gzip chunks` — `snapshotText(smartCity(), …)`, gzipped, cut at 1 byte, 7 bytes and 64 KiB, as `ArrayBuffer`s: events begin `replica opening`; `progress parse` and `progress index` never decrease and end `done === total`; `end` answers the header; the state is still `opening`; `applyTail` of an empty tail → `replica ready` at the header's `rev`.
    - `what cannot be opened is a 422` — not a snapshot (refused at its first chunk or at `end`, with `SnapshotError`'s text), a cut text (the server's count text), a snapshot of another project, a malformed metamodel; after each, a fresh `open` succeeds.
    - `open replaces what was open`; `close during an open answers the pending end with 409`.
    - `a delta moves the replica` — `applied`, the `changed` event's ids, `rev` and `structural`; then the same text again → `duplicate`, no event; a delta two revisions ahead → `gap`, nothing moves.
    - `a delta is refused before ready and while diverged` (409).
    - `a tail catches a ready replica up` — three deltas: three `changed` events in order, `progress tail` 1/3, 2/3, 3/3; a tail whose first delta is a gap → `{status: 'gap'}` and nothing applied; a tail starting behind the replica skips its duplicates.
    - `the user's own commit` — `applyDelta` with `own`: the batch leaves `staged`, temp ids are rewritten in what stays; the echo-first order of Task 4, through the service.
    - **`divergence, and the way back`** — a delta whose `state_digest` is wrong: `{status: 'applied', diverged: true}`, `replica diverged`; a `getElement` posted now is not answered; `staged` IS answered; then `close`, `open` … `end`, `adoptStaged` with what `staged` returned, `applyTail` → `replica ready`; the waiting `getElement` is answered from the new replica; `staged` shows the carried batches under their old ids.
    - `the digest is checked in the background` — after `ready`, `progress verify` reaches its total with the fake host on `auto`; a snapshot whose header names a wrong digest becomes `diverged` when the check ends; with the host turned by hand, a `stage` between two verify slices sends the progress back to zero and the check still ends true; an `unstage` that matches nothing does not restart it.
    - `no slice of an open exceeds 16 ms under the fake clock` (`tick = 1`).
- [ ] **Step 2: See them fail** — all three files at import. (Two `replica.test.ts` cases use `getElement` and `stage`: register those two methods in this task already, through Task 10's table shape; the rest of the table is Task 10's.)
- [ ] **Step 3: Implement** `readDeltaText` / `readTailText`; `ByteQueue`; `types.ts`; then `service.ts` — the message handler (request, `cancel`), the error mapping of M7, the state machine, M6, the methods above, the events with D15's throttle (the latest progress per task is sent from `onSliceEnd` and at completion).
- [ ] **Step 4: See them pass.** `pixi run engine-test && pixi run engine-check`.
- [ ] **Step 5: Lint.**
- [ ] **Step 6: Docs.**
  - `architecture/decisions.md`: `## AD-26 · A delta crosses into the engine as JSON text` — **Decision:** the shell hands the engine the text it received — a feed frame, a commit response, a tail body — and the engine reads it with its exact parser. **Why:** the host's `JSON.parse` loses `1` vs `1.0` and integers past 2^53 (CT-7), and the state digest, which folds `(id, rev)` only, cannot see a wrong value; it would stay until the next re-bootstrap. **Rejected:** parsed objects (the loss); transferred bytes (exact too, but a feed frame arrives as a string).
  - `architecture/contracts.md`, CT-4: the replica methods and their order (`open`, `chunk`…, `end`, `adoptStaged`, `applyTail`, then `applyDelta`; `close`), that the tail ends opening, that a delta and a tail cross as text (AD-26), `rev` on the `replica` event, the four progress tasks, `staged_version` and `structural` on `changed`, and the error rule gaining `SnapshotError` → 422.
  - `CLAUDE.md`, the `src/service/` bullet: `createService`, the three states and what each method does in each, M6 in three sentences, the text rule, the events, the divergence path.
- [ ] **Step 7: Commit:** `Open and follow a replica through the engine service`.

---

### Task 10: The service — staging, reads, context

**Files:** Create `engine/test/service/queue.test.ts`, `staging.test.ts`, `reads.test.ts`. Modify `engine/src/service/service.ts`, `types.ts`, `engine/src/index.ts`, `CLAUDE.md`, `architecture/contracts.md`.

**Interfaces:**
- Staging:
  - `stage {ops}` → `{batch: {id, ops}, coalesced, changes: {element_ids, relationship_ids, deleted_element_ids, deleted_relationship_ids, structural}, elements: WireElement[] | null, relationships: WireRelationship[] | null}` — `readOps`, then `wc.stage(ops, {coalesce: true})`; the post-state of what `changes` names as changed, or `null` for both lists when they name more than 500 entities together. Model lane, transition.
  - `unstage {what}` → `{changes}`; `what` is `'all'`, `{batch}` or `{entity, incident?}`. Model lane, transition.
  - `stagedDiff {}` → `{elements: {id, before, after}[], relationships: …}` in wire shapes. Model lane, read.
  - `staged {}` → `{id, ops}[]`; `conflicts {}` → `{batch: {id, ops}, error: {status, detail}}[]`. Any state; empty without a replica.
- Context, any state: `setViewPlacement {view_id, element_ids}` → `null`; `dropViewPlacement {view_id}` → `null`.
- Reads: every name in `READS` is a method — a `read` job, or a `scan` when the read returns a generator — with `getModelSummary` handed the committed `rev` as `model_rev`.

- [ ] **Step 1: Write the failing tests.**
  - `queue.test.ts` — the spec's ordering promises, through the port: `a read posted before ready is answered after it, in arrival order`; `a read posted after a stage sees it` (both posted without awaiting); `a stage posted during a re-bootstrap lands after the adopted batches`; D2 end to end — with `tick` large enough that `listElementsPage {q}` over smart-city spans slices: a `getElement` posted mid-scan is answered before the scan, a `stage` posted mid-scan and the `getElement` behind it are answered after it, the scan's page does not show the staged rename and the `getElement` does; `a cancelled search answers nothing and the next request is served`; `a cancelled queued stage stages nothing`; `close mid-scan: the scan answers from the next replica`.
  - `staging.test.ts`: the `stage` result's shape and its post-state; past 500 changed entities the two lists are `null` and the ids are all there; two single-op updates share a batch id and the second says `coalesced`; a refused batch is a 422 with the server's text and nothing is staged; malformed ops are a 422 `ops[0]: …`; `unstage` in its three forms; `conflicts` after a delta deleted an element with a staged update (the batch is parked, its error `{status: 422, detail}`); `stagedDiff`; a `changed` event follows every transition and carries `staged_version` and `structural`; results are copies — mutating a returned element's `properties` and reading again shows the original.
  - `reads.test.ts`: every `READS` name reaches its read (one smoke call each on smart-city, shape only — the fixtures hold the rules); the defaults and the bound refusals through the envelope (`limit` 0 and 501, `offset` −1: 422); an unknown element is 404 with the quote-stripped text `No element with id 'ghost`; `too many ids: 501 (max 500)`; placements — set, read the excluded pool, drop, an unknown view drops none, and they survive `close` and a new `open`; `getModelSummary` — `model_rev` is the committed `rev`, counts include a staged create, `issue_counts` is `null`, `undo_depth` 0; the working copy is what reads see — a staged rename is found by `q`, a staged delete leaves the tree, a temp-id element is reachable by `getElement` and among the roots.
- [ ] **Step 2: See them fail** — every case but the few that only use Task 9's two methods.
- [ ] **Step 3: Implement** the rest of the method table. One table, `method → {lane, kind, run}`; the message handler has no per-method branches.
- [ ] **Step 4: See them pass**; the whole engine suite; `pixi run engine-check`.
- [ ] **Step 5: Lint.**
- [ ] **Step 6: Docs.** `architecture/contracts.md`, CT-4: the staging and context methods; "reads, `stage` and `unstage` that arrive while the replica is not `ready` wait — nothing is refused for arriving early"; "requests are served in arrival order: a transition waits for every read that arrived before it and holds everything behind it, and between the slices of a long read, reads that arrived later are answered"; a result is the `lib/api` function's HTTP body. `CLAUDE.md`: complete the `src/service/` bullet — the method table, what waits and what does not, the `stage` result and its 500-entity rule, that the service always asks for coalescing.
- [ ] **Step 7: Commit:** `Serve staging and reads through the engine service`.

---

### Task 11: Measure, close the docs, bring the branch home

**Files:** `engine/bench/run.ts`, `BACKLOG-ENGINE.md`, `architecture/program.md`, `CLAUDE.md`.

- [ ] **Step 1: Bench rows.** In `bench/run.ts`, after `verify`: `indexSteps` and `indexLongest` (a second model loaded from the same bytes, `rebuildIndexSteps()` driven by hand: total and longest step), `verifySteps` / `verifyLongest`, `scan` / `scanLongest` (`READS.listElementsPage` with `q: 'a'`, `limit: 100`, driven by hand — the broadest query, hit sort included), `scanRare` (`q: 'sensor'`). The bench measures STEPS, not slices: there is no scheduler in it.
- [ ] **Step 2: Run it.** `pixi run engine-bench`. Report, in the hand-back and in Step 3's texts: open against the 3 s budget and against 2.30 s before this plan (expect about 2.4 s: D1, D12), the heap against 400 MB, and the longest step of each of the three. A longest step above 16 ms that is not a lone outlier across the three passes is a finding: report it, do not tune it.
- [ ] **Step 3: Docs.**
  - `BACKLOG-ENGINE.md`: `K-32` is rewritten in place as the watch item it has become — title `The `ord` re-sort after a rewind is watched`; body: the 58 ms re-sort and the 97 ms transition it makes, the cure if the browser benchmark misses (both as today), and one sentence saying the index build, the digest check, the roots sort and the search now run in steps, with Step 2's longest-step numbers *(measured)*. `R-3`: three of B's six plans built.
  - `architecture/program.md`, B's row and status line: plan 3 built — the engine service: CT-4 dispatcher and scheduler, the index build and the digest check in steps, the five read surfaces ported and held to the read routes by fixture.
  - `CLAUDE.md`, "Engine package": the opening paragraph (the engine now also holds the steps layer, the reads and the service; still nothing in the frontend or the server imports it); the `bench/run.ts` bullet (the new rows and what they measure); the commands block needs nothing new.
- [ ] **Step 4: Every suite, every linter.**

```bash
pixi run dr-test
pixi run dr-tidy true
pixi run golden-fixtures
git status --short
```

Expected: core pytest green at 2,551 passed, as before — this plan adds scenarios and one generated source, which the existing staleness test covers, and no Python test of its own; frontend vitest unchanged (2,493 in 252 files); engine vitest green with 272 + this plan's tests and none lost; every linter clean; `git status` shows Step 3's files alone, and no fixture moved.
- [ ] **Step 5: Commit** `Mark the engine service built`, then, with the owner's go-ahead:

```bash
git switch engine-migration
git merge --ff-only feat/engine-service
```

---

## Known limits

- A search keeps nothing between pages: every page of a broad query pays the scan and the sort again (about 0.3–0.45 s at M, *estimate from facts 2 and 5*). The server does the same below three characters.
- A transition still runs up to 100 ms without yielding (AD-23), and the `ord` re-sort stays inside it, watched (`K-32`).
- A tail body is read as one document in one step. A complete tail is bounded in revisions, not bytes (plan 2's known limit); a very large one is a long step.
- The digest check can be starved by continuous editing (M4).
- Step sizes are constants chosen from Node measurements at M. A collector pause inside a step is nobody's to bound. Plan 5's browser benchmark measures the longest slice for real.
- The `changed` event over-reports: a rebase names every staged entity, and any staged relationship makes a peer delta `structural` (M9).
- A query holding a lone surrogate cannot reach the server at all; the engine matches it by UTF-16 rules. No fixture covers it.
- `K-29`: a snapshot holding an element and a relationship under one id is a 422 at `end`; the shell's boot fallback (plan 4) serves that project from the server.
- Page-bound refusals differ from the server's in text and shape (fact 12). No `lib/api` caller sends such a page; shadow comparison (plan 5) compares successful bodies.

## After this plan

Plan 4 (sandbox and shell) is written once this one has landed. What it and the later plans inherit:

- **The worker entry supplies** `inflate` (over `DecompressionStream('gzip')`), `yieldToHost` (a macrotask: a `MessageChannel` post or `setTimeout(0)` — a resolved promise is not a yield) and `now` (`performance.now`). The in-process transport of the shell's tests is `createService` over a direct port pair, as `engine/test/service/helpers.ts` builds it.
- **The shell must keep raw text** (AD-26): the WebSocket frame's `data`, `response.text()` of `POST /commits` and of `/replica/tail`, beside whatever it parses for itself. A commit response is a delta as it stands (`model_rev` is read as `rev`).
- **The open sequence** is `open` → `chunk`… → `end` → `applyTail` (D4), and a re-bootstrap is `staged` (+ `conflicts`, if parked work is to survive) → `close` → that sequence with `adoptStaged` before the tail. The metamodel must be in hand before `open`; pairing it with the descriptor's `metamodel_id` and with the header `end` returns is the shell's.
- **Nothing is refused for arriving early**: reads and edits posted while the replica is opening or diverged are answered from the next `ready` one. A worker that is torn down takes its queue with it; the client rejects what is pending.
- **Plan 5:** method names are the `lib/api` names, results are the HTTP bodies and pass the same zod schemas; `signal` maps to `{cancel}`; `setViewPlacement` takes each loaded view's COMMITTED placed element ids.
- **Plan 6:** the `stage` result (post-state, `null` lists past 500 entities, `coalesced`), the coalescing rule the store's mirror must repeat (the first staged op of the same kind and id), `staged_version`, `structural`, `stagedDiff`'s pairs, the shape of `conflicts`.
- Open: `K-32` (now the `ord` re-sort alone), `K-29`, `K-35`, `K-36`, `C-20`, `C-21` in `BACKLOG-ENGINE.md`; `K-33`, `K-34` in `BACKLOG.md`.
