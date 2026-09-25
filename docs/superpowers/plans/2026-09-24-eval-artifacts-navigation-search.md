# Artifacts, Navigation and Criteria Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine holds the project's artifacts — committed payloads handed in by the shell, staged entries mirrored from the frontend's buffer — and answers `evaluateNavigation` and `searchModel` over the working copy, as the server's two routes answer them, behind two new surface switches that default to the engine once shadow comparison is clean.

**Architecture:** Plan 1 of 8 for sub-project C (`architecture/program.md`). Bottom-up: (1) three Python-parity value helpers the criteria need — `str()` / `float()` coercion and a translator from Python `re` to JavaScript `RegExp`, each held to an oracle fixture and backed by generated Unicode tables; (2) a port of `core/search` and the `searchModel` evaluation; (3) the engine's `ArtifactSet` and three context methods; (4) a port of `core/navigation` and the `evaluateNavigation` evaluation, refusing with 501 when a definition reaches a script; (5) a read-only `GET /artifacts/payloads` route; (6) the shell's artifact follower and the staged mirror; (7) the two surfaces, the 501 fallback in `route()` and the fallback marker; (8) the flip, e2e and the documents.

**Tech Stack:** TypeScript 6 (`strict`, erasable syntax, `lib: ["ES2023"]`, no DOM or Node in `engine/src/`), vitest 3, Svelte 5 runes, zod, MSW, Playwright; Python 3.14 (FastAPI, pydantic v2, pytest, ruff); pixi for every command.

**Spec:** `docs/superpowers/specs/2026-09-24-evaluation-design.md` — §1 (the artifact family), §2 (layout, surfaces, the script seam, shadow), §7's plan-1 families and §8's plan-1 freeze row are this plan's scope; §9 lists the `architecture/` edits that ride with the code. Read first: `architecture/contracts.md` (CT-4, CT-5, CT-7), `architecture/decisions.md` (AD-18, AD-22, AD-26, AD-28), `architecture/program.md` (MR-1…MR-4), `architecture/conventions.md`; then `engine/README.md` (value layer, `src/steps/`, `src/read/`, `src/service/`, golden fixtures), `frontend/src/lib/engine/README.md` (sync, surfaces, seam, shadow) and B's plans `docs/superpowers/plans/2026-09-19-engine-service.md` and `2026-09-22-transport-swap.md` for the idioms this plan reuses.

**What kind of plan this is.** Direction with specifics, as B's plans were: interfaces, signatures, the test cases and what each asserts, the order, and the mechanisms that are easy to get wrong, spelled out. It holds no full code. The expected results of the "see it fail" steps are reasoned from the code, not observed; if one does not appear, trust the run, read the step's intent, and say so in the hand-back. What WAS checked while planning is listed next, each with how.

## What planning found

Facts the plan rests on, checked against the code at `4fd6cf6` or by throwaway probes (Python 3.14 through `pixi run -e core-dev`, `PYTHONPATH=src`).

1. **`_js_str` is Python's `str()` with two exceptions.** *Probe:* `True → 'true'`, `1.0 → '1'`, `1e16 → '10000000000000000'`, `1e21 → '1000000000000000000000'` (JavaScript's `String` gives `1e+21`), `1e-05 → '1e-05'`, `[1, 'a', True, None, 1.5] → "[1, 'a', True, None, 1.5]"`, `{'k': 'v', 'n': [1.0]} → "{'k': 'v', 'n': [1.0]}"`, `2**60 → '1152921504606846976'`. Inside a container a bool is `True`, a float `1.0`: plain `repr`. The module docstring's "mirrors JavaScript" is aspirational; the code is the oracle.
2. **`_to_number` is Python's `float()`.** *Probe:* `'1_000' → 1000.0`, `' 1.5 ' → 1.5`, `'inf'`, `'-Infinity'`, `'nan'` accepted, `'٣' → 3.0` (Unicode decimal digits), `'１２' → 12.0`, `'\xa01\xa0' → 1.0`, `'.5'`, `'5.'`, `'+1'` accepted, `'0x10'`, `'1__0'`, `'1 000'` → NaN. An `int` past the double range raises `OverflowError: int too large to convert to float` — a 500 on the route.
3. **`_safe_regex` is `re.search`, and Python-only syntax is live.** *Probe:* `(?P<a>x)(?P=a)` matches `xx`; `\d` matches `٣`; `a$` matches `"a\n"`; `x{,2}y` matches `xxy`; `[` is an invalid pattern and never matches. JavaScript differs on every one.
4. **Criteria read a name as a STRING only.** `core/search/criteria.py::name_prop` takes a non-empty `str`; the engine's `nameOf` (`src/model/naming.ts`) also takes a list's first string (it ports `display_name`). Criteria need their own `nameProp`.
5. **Criteria match exact type names**: `entity_type`, `relation_count.rel_types`, `connected_to_type`, `endpoint_type` compare `type_name in names`, no subtypes. Navigation scopes, hops and target types are subtype-inclusive through the metamodel.
6. **`SearchQueryIn.limit` defaults to 500**, not 100 (`api/search.py:57`); results are in state order, paged after matching, `total` before paging; the body's field order is `target, elements, relationships, total`.
7. **The navigation route's outputs and error texts.** *Probe (`routes/artifacts.py::evaluate_navigation` called directly with a stand-in `db`):*
   - a scalar float property step answers `{"kind":"value","value":1.0}` (the client's `JSON.parse` reads `1`);
   - top-level `artifact_id` unknown → 422 `unknown navigation artifact n1` — NO quotes (`LookupError(id)` formatted with `str`);
   - a nested `ref` unknown → 422 `unknown navigation artifact 'n1'` (`RefNotFoundError`, `repr`); a self-reference → 422 `navigation reference cycle through 'n1'`; a ref to an artifact of another kind → 422 `unknown navigation artifact 't1'`;
   - an unbound `RowStart` → 422 `navigation is row-rooted; no row element bound`;
   - an unknown `row_element_id` with NO steps → `KeyError('ghost')` from `_tree_item` → 404 `ghost` (the handler strips quotes); behind a filter or a property step → `model.elements[...]` raises `KeyError` INSIDE the route's `try`, and `except LookupError` catches it (a `KeyError` is a `LookupError`) → 422 `unknown navigation artifact 'ghost'`; behind a relationship step → 0 chains;
   - an unconfigured script step (`snippet: {}`) prunes silently, `step_types` `["script"]`; a dangling snippet ref yields a `nav_snippet_not_found` warning — `navigation_has_script` is true for it, so it is the server's.
8. **One crash.** An element-typed property whose list holds a dict makes `_hop_property`'s `set(candidates)` raise `TypeError: cannot use 'dict' as a set element` — a 500. The docstring promises "never raises on odd models".
9. **Snippet resolution cannot change `navigation_has_script`.** A `ScriptStep` counts when its snippet is not empty; resolving a ref to a definition, or leaving a dangling ref in place, keeps it non-empty. The engine needs no snippet resolver.
10. **Pydantic fills defaults and requires the discriminators.** `kind` on every node and step, `type` on every criterion, `op` on a set expression are required tags (a discriminated union cannot extract a missing tag); `direction` defaults to `out`, `target_types` / `types` / `criteria` / `names` to `[]`, `exclude_visited` to `true`, `PropertyCriterion.value` to `""`, `RelationCountCriterion.rel_types` takes the alias `relTypes` (the frontend sends `relTypes`). Unknown keys are ignored.
11. **The artifact buffer's post-commit order.** `checkout.svelte.ts:607-618` calls `clearStagedArtifacts()` and, in the same synchronous run, `notifyArtifactCommit({idMap, changed, deletedIds})` with full headers (`artifact_rev` included). A staged-mirror push deferred by one microtask therefore sees the commit's notification before it goes.
12. **Staged payloads may be `$state` proxies.** Editors hand `stageArtifactCreate` / `stageArtifactUpdate` their draft objects; a proxy cannot be structured-cloned through a `MessagePort` (`DataCloneError`). The mirror must post `$state.snapshot(...)` copies.
13. **Artifact changes reach peers as `artifact` feed events** carrying the header (`routes/commits.py` `broadcast_artifact_events`, also undo and the legacy `/artifacts` writes), and the user's own commit as `notifyArtifactCommit`. `realtime.svelte.ts::handleFeedEvent` hands every event to `handReplicaFeed` first.
14. **`/artifacts/payloads` must be declared before `/artifacts/{artifact_id}`**, or FastAPI matches `payloads` as an id.
15. **`staging: engine` forces EVERY surface to `engine`** (`lib/engine/surfaces.ts::readSwitches`): a new surface added to `SURFACES` would be on the engine from the first commit, whatever its default. The force exists because a staged model edit is visible only in the replica; evaluation on the server never saw staged edits in either mode, so the new surfaces need no force.
16. **The engine's error client carries the detail as the message** (`lib/engine/client.ts:100`: `errorForStatus(status, {detail}, detail)`), so `route()` can tell a 501 fallback by `status` and `message`.
17. **An untyped scope at M sorts 170,340 ids**, and a criteria scan visits every element: both must run in steps (B measured the native sort of 170k search hits at 88–100 ms, `sortedInSlices` at no step over 2 ms).

## Decisions

Taken with the owner during the brainstorm (spec §"Decisions"): the frontend owns the staged artifact buffer and the engine mirrors it; a call that reaches a script routes whole to the server before D; eight plans, this one first.

Taken by this plan — each small and reversible at review; say so if one is wrong:

- **D1. The artifact methods are context, like view placements.** `setArtifacts`, `putArtifacts`, `setStagedArtifacts` are `now` methods, answered in any state; the sync keeps what it sent and sends it again to every new worker before anything else. Sound because every evaluation resolves its whole artifact closure before its first step (M4): a later change cannot reach a scan in flight. This refines spec §1's "transitions in the model lane"; update the spec's §1 in Task 8.
- **D2. Crashes are fixed on both sides; quirks are mirrored.** Fact 8's `TypeError` is fixed in `core/navigation/evaluate.py` and in the engine, with a fixture step (MR-3: a bug fixed during a port lands on both sides). Fact 7's texts — the unquoted top-level id, the `KeyError` caught as "unknown navigation artifact" — are reproduced exactly and recorded as `C-22` for a later fix on both sides.
- **D3. A regex the translator cannot vouch for goes to the server.** The translator answers `ok`, `invalid` (Python would refuse it too: the matcher never matches) or `unsupported`. Any `unsupported` pattern in a call's criteria refuses the call with 501 `reaches an unsupported pattern`, and `route()` sends it to the server. Never a silent difference (CT-7).
- **D4. Payloads cross the port as plain JSON values** and the engine reads them as the server reads what a client sends: `JSON.stringify` then the exact parser (`readOps`' rule). A committed payload's integral float reads as an int, which nothing in navigation or criteria observes; plan 3 revisits this for rule documents.
- **D5. The engine shape-checks definitions and criteria in canonical JSON only**: the types the frontend's own types produce, pydantic's defaults filled, unknown keys ignored, required tags required. What pydantic would coerce (`"3"` for an int) the engine refuses with a 422 in its own words — a loud difference, never a silent one, as B's page parameters.
- **D6. Evaluations are always scans.** `searchModel` and `evaluateNavigation` are `Steps` generators registered in an `EVALUATIONS` table; the scheduler runs them in the model lane like a search. No result is kept between pages (the server keeps none).
- **D7. New surfaces start on `server` and escape the staging force.** `SURFACES` gains `navigation` and `criteria` with defaults `server`; the force of fact 15 covers B's five read surfaces only (`READ_SURFACES`). Task 8 flips both defaults to `engine`.
- **D8. A fallback is marked by reason.** `route()` answers a 501 from the server and adds `fallback: 'script' | 'pattern'` to an object result when the caller asks for it; the navigation results dock renders a marker for it. No shadow probe runs on a fallback.
- **D9. Shadow stays off while anything is staged** — model edits (B's probe) or an artifact entry.
- **D10. The post-commit artifact refresh holds the staged push.** When a commit's notification arrives, the follower fetches the changed payloads and sends them with the current staged buffer in ONE `putArtifacts`; a staged change during that fetch rides with it (M8).

## Global Constraints

- Everything runs through pixi. There is no global `node` or `python`: `pixi run <task>`, `pixi run -e core-dev …`, `pixi run -e frontend …`.
- Work on `feat/eval-navigation`, cut from `engine-migration` (Task 1 cuts it; the empty `chore/evaluation-spec` branch can be deleted) and fast-forwarded back when the plan is done (Task 8). Never touch `main`. **Commit only with the owner's go-ahead for this plan's execution** — ask before Task 1.
- **Freeze (MR-3):** `core/model`, `core/metamodel` and the model-op applier stay frozen. From Task 1 on, `core/search`, `core/navigation`, `api/search.py`, the `search_model` and `evaluate_navigation` route functions are frozen for behaviour too; the ONE change this plan makes there is D2's fix, with its fixture. The Python core is the oracle: fix the engine, never a fixture; fixtures change only through `pixi run golden-fixtures`.
- **Engine `src/` rules:** no DOM, no Node built-in, no timer or clock, no `Math.random`, no `Intl`, no locale comparison (RC-4, RC-5); erasable syntax only; `.ts` import specifiers; no `any` in an exported signature; strings compare by `cmpCodePoint`; lengths Python counts are counted in code points; lowering is `pyLower`, stripping `pyStrip`.
- Tests import the engine through `engine/src/index.ts` only. Engine tests and frontend tests run the real engine, never a mock, without fake timers; every in-process link is `dispose()`d.
- A steps generator publishes nothing before its last step, and an evaluation reads its artifacts only before its first yield.
- Nothing live leaves the service: results go through `toWire` / the `wire*` functions.
- Formatting and lint: `pixi run engine-tidy` for `engine/`, `pixi run dr-tidy` for the rest; `pixi run -e core-dev ruff check <files>` and `ruff format <files>` by hand on every file under `tests/`. `pixi run frontend-check` and `pixi run engine-check` must pass.
- A "see it fail" step lists the tests it expects red; any OTHER red test is a finding to report, not to silence.
- Comments and docstrings: concise, present-tense, only for what the code cannot say; no references to specs, plans or `architecture/` ids in code (RC-6).
- `architecture/`, the READMEs and `BACKLOG-ENGINE.md` change in the commit of the code they describe (RC-10); `docs/` and `benchmarks/` are git-ignored — never `git add -f`.
- Commit subjects: one imperative sentence, capitalized, no prefix, no trailing period; the message ends with the session's `Co-Authored-By` line.
- Ids: next free are `AD-30`, `K-49`, `C-22`.
- Baseline (2026-09-24, `4fd6cf6`): engine 461 tests in 59 files; core 2,565 passed / 34 deselected; frontend 2,897 tests in 281 files; sandbox 14 tests.

## Review Focus

The five conditions most likely to bite a user that the tasks' ordinary tests would not reach; each has its test in the task named.

1. **A staged artifact that names another staged artifact.** A staged navigation whose `set_op` operand refs a navigation staged under a `tmp_` id evaluates against the staged one; a staged delete of a referenced navigation answers `unknown navigation artifact 'x'` as a missing ref does. *Task 4 (overlay), Task 5 (resolution through it).*
2. **An artifact edit during a commit's refresh.** An edit staged while the follower fetches a commit's payloads reaches the engine with that fetch, and nothing reads a state where the committed artifact is neither staged nor committed. *Task 6.*
3. **A worker that dies or a replica that re-bootstraps.** A navigation evaluated right after a new worker is adopted sees every committed and staged artifact — never `unknown navigation artifact`. *Task 6.*
4. **A project switch.** No artifact of project A reaches project B's engine: a payload fetch that answers after the switch is dropped. *Task 6.*
5. **A criterion with a Python-only pattern or an odd number.** Either the engine answers exactly as the oracle, or the call goes to the server (501); never a third answer. *Task 2 (fixture), Task 3 (criteria with an unsupported pattern → 501), Task 7 (the fallback reaches the server).*

---

## File Structure

```
tests/golden/coerce_tables.py                (new) Python's decimal digits and whitespace; renders digit-tables.ts
tests/golden/regex_tables.py                 (new) Python 3.14's \w, \d, \s over str; renders regex-tables.ts
tests/golden/driver.py                       GENERATED gains the two modules
tests/golden/model_steps.py                  + `artifacts`, `navigate`, `has_script` steps; `searchModel`, `evaluateNavigation` reads
tests/golden/scenarios/py_coerce.py          (new) _js_str, _to_number
tests/golden/scenarios/py_regex.py           (new) patterns × subjects, re.search and re.fullmatch
tests/golden/scenarios/search_criteria.py    (new)
tests/golden/scenarios/nav_eval.py           (new)
tests/golden/scenarios/__init__.py           registers the four
src/data_rover/core/navigation/evaluate.py   D2's fix in _hop_property (one line)
src/data_rover/api/routes/artifacts.py       + GET /artifacts/payloads
src/data_rover/api/schemas.py                + ArtifactPayloadListOut
tests/api/test_artifact_payloads_route.py    (new)
tests/navigation/test_evaluate.py            + the dict-in-list case

engine/src/value/coerce.ts                   (new) jsStr, toNumber, pyFloatOf, PyOverflowError
engine/src/value/repr.ts                     + pyReprValue
engine/src/value/digit-tables.ts             (generated)
engine/src/value/regex.ts                    (new) translatePyRegex
engine/src/value/regex-tables.ts             (generated)
engine/src/search/criteria.ts                (new) Criterion types, readCriteria, matchers, nameProp
engine/src/search/search-model.ts            (new) searchModel
engine/src/artifacts/artifact-set.ts         (new) ArtifactSet, wire shapes, readers
engine/src/navigation/schema.ts              (new) types, readNavigation
engine/src/navigation/resolve.ts             (new) resolveRefs, navigationHasScript, resolve errors
engine/src/navigation/evaluate.ts            (new) evaluateSteps, PropertyValue, limits
engine/src/navigation/route.ts               (new) evaluateNavigation (the route body)
engine/src/evaluate/index.ts                 (new) EvalContext, EVALUATIONS
engine/src/service/service.ts                + the artifact methods, the evaluations
engine/src/service/types.ts                  + wire types
engine/src/index.ts                          exports
engine/bench/run.ts                          + a broad criteria scan and an untyped navigation, in steps
engine/test/value/{coerce,regex}.golden.test.ts, regex.test.ts           (new)
engine/test/search/{criteria,criteria.golden}.test.ts                    (new)
engine/test/artifacts/artifact-set.test.ts                               (new)
engine/test/navigation/{nav,nav.golden,staged}.test.ts                   (new)
engine/test/golden/model-steps.ts                                        + the new steps
engine/test/service/evaluations.test.ts                                  (new)
engine/.prettierignore                                                   + the two generated modules

frontend/src/lib/api/artifacts.ts            + listArtifactPayloads; evaluateNavigation routed
frontend/src/lib/api/model-read.ts           searchModel routed
frontend/src/lib/api/engine-route.ts         Surface + 'navigation' | 'criteria'; 501 fallback; mark
frontend/src/lib/api/types.ts                ChainPageSchema + fallback; ArtifactPayloadListSchema
frontend/src/lib/engine/surfaces.ts          READ_SURFACES; new defaults
frontend/src/lib/engine/sync.ts              artifact context kept and re-sent
frontend/src/lib/engine/artifacts.ts         (new) the follower
frontend/src/lib/state/artifact-edits.svelte.ts   onStagedArtifactsChanged, stagedArtifactsForEngine
frontend/src/lib/state/replica.svelte.ts     follower wiring; shadow's staged probe
frontend/src/lib/state/navigation-editor.svelte.ts  preview carries fallback
frontend/src/lib/components/Navigation/ResultsDock.svelte  the marker
frontend tests under the touched modules' __tests__/; frontend/e2e/eval-navigation.spec.ts (new)

architecture/{contracts,decisions,program}.md, engine/README.md, frontend/src/lib/engine/README.md,
src/data_rover/api/README.md, BACKLOG-ENGINE.md, core/metamodel/schema.py (a comment)
```

`src/search/` and `src/navigation/` depend on `src/model/`, `src/metamodel/`, `src/value/`, `src/steps/`; `src/navigation/` also on `src/search/` and `src/artifacts/`. `src/evaluate/` is the only module the service imports for them.

## Mechanisms

Referred to by the tasks; read them before the task that uses them.

**M1 — Python's `str()` and `float()` for criteria.**
- `pyReprValue(v)`: `repr` of any `Value` — `None`, `True`/`False`, an int (`number` or `bigint`) as decimal, a `PyFloat` through `pyFloatRepr`, a string through `pyRepr`, a list `[a, b]` and a dict `{'k': v}` joined with `', '` and `': '`, keys through `pyRepr`, in property order.
- `jsStr(v)` = `_js_str`: `true`/`false` for a bool; a `PyFloat` that is integral and finite as the exact decimal of the double (`BigInt(value).toString()`, which gives `1000000000000000000000` for `1e21` and `99999999999999991611392` for `1e23`, as `str(int(x))` does; `-0.0` gives `0`); any other float through `pyFloatRepr`; an int as decimal; a string as itself; `null` as `None`; a container through `pyReprValue`.
- `pyFloatOf(text)` = `float(text)` or `null` where Python raises `ValueError`: every Unicode decimal digit becomes its ASCII digit and every `str.isspace()` code point a space (the transform CPython applies first; `digit-tables.ts`, generated); leading and trailing ASCII whitespace go; then the grammar — optional sign, then `inf`, `infinity` or `nan` in any case, or `digits ['.' [digits]] | '.' digits` with an optional `e|E [sign] digits`, where `digits` is `[0-9](_?[0-9])*`; anything else is `null`. A valid text drops its underscores and goes to `Number()`, which rounds correctly as Python does. A remaining non-ASCII code point is `null`.
- `toNumber(raw)` = `_to_number`: missing (`undefined`) → NaN; `null` → 0; `true` → 1, `false` → 0; an int → itself (a `bigint` past ±1.797…e308 throws `PyOverflowError('int too large to convert to float')`, which the service answers as a 500 with that message, as the route does); a `PyFloat` → its value; a string → `pyStrip`, blank → 0, else `pyFloatOf` or NaN; a container → NaN.

**M2 — The regex translator.** `translatePyRegex(pattern, mode: 'search' | 'fullmatch')` → `{kind: 'ok', test(subject): boolean} | {kind: 'invalid'} | {kind: 'unsupported', reason}`, memoized per `(pattern, mode)` in a map of at most 256 entries. It parses the Python pattern itself and emits a JavaScript source compiled with the `u` flag (plus `i`, `s`, `m` from leading global flags). The supported subset:
- literals and escaped punctuation; `\n \t \r \f \v`, `\a` (→ `\x07`), `\xhh`, `\uhhhh`, `\Uhhhhhhhh` (→ `\u{…}`), octal `\0` and `\ooo`;
- `.` → `[^\n]` (`[\s\S]` under `s`): JavaScript's `.` also excludes `\r`, U+2028 and U+2029;
- `\d \D \w \W \s \S` → character classes from `regex-tables.ts` (Python 3.14's own Unicode data), also inside `[...]`; `\b` / `\B` → look-arounds over the `\w` class;
- `^` → `(?<![\s\S])`, `$` → `(?=\n?(?![\s\S]))` without `m`; with `m`, `^` → `(?<![^\n])`, `$` → `(?=\n|(?![\s\S]))`; `\A` → `(?<![\s\S])`, `\Z` → `(?![\s\S])`;
- classes `[...]`, negated, ranges, the escapes above inside them; a class that Python would read as a set operation or a nested class (`[[`, `--`, `&&`, `~~`, `||` inside) is `unsupported`;
- quantifiers `* + ? {m} {m,} {m,n} {,n}` (→ `{0,n}`) and their lazy forms; possessive forms and `(?>…)` are `unsupported`;
- groups `(…)`, `(?:…)`, `(?P<name>…)` with an ASCII identifier (→ `(?<name>…)`), `(?P=name)` (→ `\k<name>`), `\1`…`\99` as Python reads them; look-ahead; look-behind only when every alternative has one fixed width the translator computes (else `unsupported`, since Python's own rule decides validity);
- leading global flags `(?i)`, `(?s)`, `(?m)` and their combinations; any other flag, a flag not at the start, or a scoped `(?i:…)` is `unsupported`;
- an unknown ASCII-letter escape (`\q`), an unbalanced parenthesis, a bad range, an unterminated class, a nothing-to-repeat: `invalid` — the cases where `re.compile` certainly refuses.
- `fullmatch` wraps the source as `^(?:…)(?![\s\S])` with the start anchored as `(?<![\s\S])`; `search` leaves it unanchored. Everything else is `unsupported` with a one-line reason.

**M3 — Criteria.** `readCriteria(raw, path)` reads a list of the eight criterion shapes (fact 10's tags and defaults; `relTypes` and `rel_types` both accepted, as pydantic's `populate_by_name`), refusing with `ReadError(422, '<path>[i]: …')`. Before any step, `compileCriteria(criteria)` translates every `matches` pattern (property and name/id criteria, `any_of` members included); an `unsupported` one throws `ReadError(501, 'reaches an unsupported pattern')`. The matchers are a line-for-line port of `match_element` / `match_relationship`: `_nullish_str` is `jsStr` after missing/`null` → `''`; `contains` compares `pyLower` of both; `equals` compares `jsStr` exactly; numeric ops through `toNumber`, NaN on either side → false; `_rels_for` collects the element's `out`, `in` or both into a `Set<RelRec>` (a self-loop counts once); an empty `any_of` matches; an element-only criterion on a relationship query and the reverse match. `nameProp(props)` ports `name_prop` (strings only; exact `name` first, then other keys in property order whose `key.toLowerCase() === 'name'`).

**M4 — The artifact set and evaluations.**
- Wire: `WireArtifact = {id, kind, name, artifact_rev, payload}`; `WireStagedArtifact = {op: 'create', id, kind, name, payload} | {op: 'update', id, name?, payload?} | {op: 'delete', id}`. A create's `id` is its `tmp_` id. The readers refuse a malformed entry with 422 and change nothing.
- `ArtifactSet`: a committed `Map` by id and a staged `Map` by id. `setCommitted(list)` replaces the committed layer; `put(changed, deletedIds)` upserts and removes; `setStaged(entries)` replaces the overlay. `resolve(id)` → `{id, kind, name, payload} | null`: a staged `delete` → `null`; a staged `create` → itself; a staged `update` over a committed artifact → the committed one with the update's `name` / `payload` where given; an update with no committed artifact under it → `null` (it names nothing); otherwise the committed one. Payloads are read on entry per D4 and never handed out live: a resolved payload is read, never mutated.
- `EvalContext = {model, artifacts, placements}`; `EVALUATIONS: {[method]: (ctx, params) => Steps<unknown>}` holds `searchModel` and `evaluateNavigation`. An evaluation reads its params, resolves every artifact it needs and compiles every pattern BEFORE its first `yield`; refusals (422, 501) therefore happen before any work and leave nothing behind.
- Service: the three artifact methods are `now` methods (D1) on a `service.artifacts` that survives `close` and `open`, as `placements` does. Each `EVALUATIONS` name is a model-lane `scan` job whose `run()` builds the generator over `{model: ready().model, artifacts, placements}`.

**M5 — The navigation reader.** `readNavigation(raw, path)` returns the discriminated shapes of `core/navigation/schema.py`: `PathNavigation {kind: 'path', start, steps, exclude_visited}`, `SetExpression {kind: 'set_op', op, operands}`, `Scope`, `RowStart`, `Operand {ref | definition, step_index}`, and the four steps. Rules: fact 10's tags and defaults; `children` must be empty (`branching steps (\`children\`) are not supported in schema v2`); at most 10 steps (`a navigation may have at most 10 steps`); an operand needs exactly one of `ref` / `definition` (`an operand needs exactly one of \`ref\` / \`definition\``); `step_index` null or an integer ≥ 0; `operands` non-empty; a `ScriptStep.snippet` is `{ref?, definition?}` with at most one set (`provide at most one of \`ref\` / \`definition\``) and is not read further (fact 9); criteria through `readCriteria`. `schema_version`, `name` and `comment` are read only as `comment` for a script step's label. Refusals are `ReadError(422, '<path>: <text>')`.

**M6 — The evaluator in steps.** A line-for-line port of `evaluate.py` in which every loop that can grow with the model yields:
- `evaluateSteps(mm, model, defn, limits, rowElements, meter)` is a `Steps<ChainResult>`; `meter` is shared by the whole call and yields `{done, total}` every 1,024 units (an edge examined, an element matched, an id sorted by `sortedInSlices`), `total` = `limits.maxVisited`.
- Ids sort by `cmpCodePoint`; the untyped no-criteria scope sorts every element id through `sortedInSlices`; typed scopes gather `byType` over `elementDescendants` into a `Set<string>` first.
- `_walk` becomes a recursive generator (`yield*`), depth ≤ 11; the budget (`visited`, `exhausted`) and the chain cap behave exactly as in Python, including `_start_ids` setting `exhausted` when a set start truncated and each operand getting a fresh budget.
- A hop collects relationships into a `Set<RelRec>` (`either` unions `out` and `in`, a self-loop once), spends `set.size`, filters by `isRelationshipSubtype` and target types, collects the far ids into a `Set<string>`, sorts them.
- A property hop: the element's effective property of that name (`effectiveElementProperties`); missing def or value → nothing; `spend(candidates.length)`; a scalar datatype → one `PropertyValue` per item that is a string, a number, a `bigint`, a `PyFloat` or a boolean, in list order; an element datatype → the distinct STRING items naming an existing element, sorted (D2's fix: non-strings are skipped, never hashed).
- A script step never runs here: a non-empty snippet has already refused the call (M7); an empty one prunes.
- `PropertyValue` equality and set membership key on `(type, value)`: `bool`, `int` (`number` and `bigint` alike), `float` (`PyFloat`), `str` — `True`, `1` and `1.0` stay three nodes.
- Set algebra over `Set<string>`; `difference` folds left; the members of a `set_op` definition leave as single-node chains sorted by id.
- A missing element where Python indexes `model.elements[...]` raw (the filter step, the property hop) throws `NavKeyError(id)`; `step_index` errors and the unbound row throw `NavValueError` with Python's texts.

**M7 — The route body.** `evaluateNavigation(ctx, params)`:
1. Read `definition` / `artifact_id` (exactly one: `provide exactly one of \`definition\` / \`artifact_id\``), `row_element_id` (string or null), `limit` (1–500, default 100), `offset` (≥ 0) — before anything else.
2. `artifact_id`: `fetch(id)` — `ctx.artifacts.resolve(id)` of kind `navigation`, else 422 `unknown navigation artifact <id>` (no quotes); then `resolveRefs(defn, fetch, {id})`. `definition`: `resolveRefs(defn, fetch)`. A nested ref missing or of another kind → 422 `unknown navigation artifact '<id>'`; a cycle → 422 `navigation reference cycle through '<id>'`. A fetched payload is read through `readNavigation`.
3. `navigationHasScript(resolved)` → `ReadError(501, 'reaches a script')`.
4. Drain nothing yet: `yield*` the evaluator. `NavKeyError(id)` → 422 `unknown navigation artifact ${pyRepr(id)}` (fact 7's quirk); `NavValueError` → 422 its text.
5. Window `chains.slice(offset, offset + limit)`; each id node → `treeItem(model, element)` where a missing element throws `ModelError('key', id)` (so the service answers 404 `<id>`, the raw-dict `KeyError`'s text); a value node → `{kind: 'value', value: toWire(value)}`.
6. Answer `{step_types, chains, total, truncated, warnings: []}` in that field order.

**M8 — The shell's artifact context.**
- `ReplicaSync` gains `setArtifacts(list)`, `putArtifacts(changed, deletedIds, staged?)`, `setStagedArtifacts(entries)`. It keeps a committed `Map` and the staged list, posts each call to the current link at once (`.catch(() => {})`, as placements), and on `adopt` sends `setArtifacts` with every committed artifact and then `setStagedArtifacts`, right after the placements and before anything else. `stop()` clears both.
- `createArtifactFollower({sync, payloads, staged})` (`lib/engine/artifacts.ts`), one per started replica:
  - `load()`: `payloads()` (every artifact) → `sync.setArtifacts`; remembers each `artifact_rev`.
  - `onEvent(action, header)`: `deleted` → `putArtifacts([], [id])`; otherwise, when `header.artifact_rev` is past the remembered one, `payloads([id])` → `putArtifacts(changed, [])`.
  - `onCommit({changed, deletedIds})`: sets `holding`, fetches `payloads(changed ids)`, then `putArtifacts(changed, deletedIds, staged())` and clears `holding`.
  - `stagedChanged()`: queues ONE microtask; when it runs and `holding` is false, `setStagedArtifacts(staged())`; while `holding`, it does nothing (the commit's `putArtifacts` carries the latest buffer).
  - Every continuation checks a generation token that `stop()` moves: an answer that arrives after a stop, or for a project that is no longer the sync's, is dropped. A failed fetch leaves the context as it was and retries at the next `load()` (the feed's next `snapshot`).
- `artifact-edits.svelte.ts` gains `onStagedArtifactsChanged(cb)` — fired by every function that changes `_staged` — and `stagedArtifactsForEngine()`, the entries as `WireStagedArtifact` with `$state.snapshot` copies of names and payloads (fact 12), in insertion order.
- `replica.svelte.ts` builds the follower in `startReplica()` (`payloads` = `listArtifactPayloads` for the project, `staged` = `stagedArtifactsForEngine`), calls `load()`, and routes to it: an `artifact` feed event (`handReplicaFeed`), a `snapshot` feed event (`load()` again, which heals a missed event after a reconnect), `onArtifactCommit`, `onStagedArtifactsChanged` (both subscribed once, module-level, forwarding to the current follower); `stopReplica()` / `resetReplica()` stop it.

**M9 — Routing.**
- `Surface` gains `'navigation' | 'criteria'`; `SURFACES` lists them; `SURFACE_DEFAULTS` gives them `server` until Task 8; `READ_SURFACES` is B's five and is what the staging force iterates (D7).
- `route(surface, cfg, engineCall, serverCall, options?)` with `options.mark?: (value: T, reason: 'script' | 'pattern') => T`: an engine error that is an `ApiError` of status 501 whose message is `reaches a script` or `reaches an unsupported pattern` → `serverCall()`, then `mark(value, reason)` when given; no shadow probe. Any other 501 is the caller's error.
- `evaluateNavigation` routes `navigation` with the body as flat params (absent keys left out) and `mark: (page, reason) => ({...page, fallback: reason})`; `ChainPageSchema` gains `fallback: z.enum(['script', 'pattern']).optional()`. `searchModel` routes `criteria` with `{target, criteria, limit, offset}` and no mark.
- The shadow's `staged` probe becomes `anyStaged() || getStagedArtifactDepth() > 0` (D9).
- The navigation editor's preview keeps `fallback` from the first page; `ResultsDock.svelte` shows, above the chain table, a one-line muted note `data-testid="nav-fallback"`: `Reads committed state: this navigation runs a script on the server.` for `script`, `Reads committed state: a pattern here runs on the server.` for `pattern`.

---

### Task 1: Python's `str()` and `float()` for criteria

**Files:**
- Create: `tests/golden/coerce_tables.py`, `tests/golden/scenarios/py_coerce.py`, `engine/src/value/coerce.ts`, `engine/test/value/coerce.golden.test.ts`, `engine/test/value/coerce.test.ts`
- Generated: `engine/src/value/digit-tables.ts`, `engine/fixtures/golden/py_coerce.json`
- Modify: `engine/src/value/repr.ts` (+ `pyReprValue`), `tests/golden/driver.py` (`GENERATED`), `tests/golden/scenarios/__init__.py`, `engine/.prettierignore`, `engine/src/index.ts`, `engine/README.md`

**Interfaces:**
- Produces: `pyReprValue(value: Value): string`; `jsStr(value: Value): string`; `pyFloatOf(text: string): number | null`; `toNumber(raw: Value | undefined): number`; `class PyOverflowError extends Error` — all exported from `src/index.ts` (M1).
- `coerce_tables.py`: `decimal_pairs() -> list[tuple[int, int]]` (every code point with `unicodedata.decimal(c)` defined, and its value), `space_points() -> list[int]` (every `str.isspace()` code point), `render() -> str` (a header naming the generator and `unicodedata.unidata_version`, then `export const DECIMAL_DIGITS: readonly number[]` flat `cp, digit, …` and `export const SPACE_POINTS: readonly number[]`).
- Fixture `py_coerce.json`: `js_str` — `[[tagged value, text], …]` over ints, big ints, floats (integral and not, `1e16`, `1e21`, `1e23`, `-0.0`, `5e-324`, `1e308`), bools, `None`, strings, nested lists and dicts holding every scalar kind and a string that needs escaping; `to_number` — `[[tagged input or {"missing": true}, tagged float or "nan" or {"error": text}], …]` over fact 2's list, every `str.isspace()` code point around `1`, one Unicode decimal digit from each of ten scripts, underscores in every position, exponents with and without sign, `inf`/`nan` in mixed case with signs, `10**400` (the `OverflowError`), booleans, `None`, lists; `float_of` — `[[text, tagged float or null], …]`, `float()` called directly with the same texts. Values go through `tests/golden/tagged.py` so floats and big ints survive.

- [ ] **Step 1: Ask, then cut the branch.** Ask the owner whether commits are pre-approved. `git switch engine-migration && git switch -c feat/eval-navigation`.
- [ ] **Step 2: Write the generator, the scenario and the failing tests.** `coerce.golden.test.ts`: every `js_str`, `to_number` and `float_of` row, NaN compared with `Number.isNaN`, `-0` with `Object.is`, the overflow row as a thrown `PyOverflowError` with the fixture's text. `coerce.test.ts`: `jsStr` of a `PyFloat(1e21)` is 22 characters; `toNumber(undefined)` is NaN and `toNumber(null)` is 0; `pyFloatOf('1_000')` is 1000 and `pyFloatOf('1__0')` is null; a lone surrogate is `null` and nothing throws.
- [ ] **Step 3: See them fail.** `pixi run golden-fixtures`, then `pixi run engine-test`. Expected red: the two new files, at import. Everything else green.
- [ ] **Step 4: Implement** `pyReprValue` in `repr.ts` and `coerce.ts` per M1; add `/src/value/digit-tables.ts` to `engine/.prettierignore` before running prettier.
- [ ] **Step 5: See them pass**; `pixi run -e core-dev pytest tests/golden -q` (staleness covers the new fixture and module); `pixi run engine-check`.
- [ ] **Step 6: Lint.** `pixi run engine-tidy`; ruff check and format on the three Python files.
- [ ] **Step 7: Docs.** `engine/README.md`, the `src/value/` bullet: `jsStr`, `toNumber`, `pyFloatOf`, `pyReprValue` — what each mirrors, that the criteria's "JavaScript" coercion is Python's `str()` / `float()` in fact, and the generated `digit-tables.ts`.
- [ ] **Step 8: Commit** (with the go-ahead): `Coerce values as the criteria's Python does`.

---

### Task 2: A translator from Python `re` to `RegExp`

**Files:**
- Create: `tests/golden/regex_tables.py`, `tests/golden/scenarios/py_regex.py`, `engine/src/value/regex.ts`, `engine/test/value/regex.golden.test.ts`, `engine/test/value/regex.test.ts`
- Generated: `engine/src/value/regex-tables.ts`, `engine/fixtures/golden/py_regex.json`
- Modify: `tests/golden/driver.py`, `tests/golden/scenarios/__init__.py`, `engine/.prettierignore`, `engine/src/index.ts`, `engine/README.md`

**Interfaces:**
- Produces: `type PyRegex = {kind: 'ok'; test(subject: string): boolean} | {kind: 'invalid'} | {kind: 'unsupported'; reason: string}`; `translatePyRegex(pattern: string, mode: 'search' | 'fullmatch'): PyRegex` (M2).
- `regex_tables.py`: `word_ranges()`, `digit_ranges()`, `space_ranges()` — inclusive `(start, end)` lists of the code points `re.fullmatch(r'\w', c)`, `\d`, `\s` accept on a `str` (probed code point by code point, surrogates skipped); `render()` → `WORD_RANGES`, `DIGIT_RANGES`, `SPACE_RANGES` as flat `start, end, …` arrays.
- Fixture `py_regex.json`: `cases` — `[{pattern, subjects: [[subject, search, fullmatch], …]} | {pattern, error: true}, …]`, from `re.search` / `re.fullmatch`, `re.error` recorded as `error`. At least 150 patterns: fact 3's four; every construct of M2's subset, each with subjects that tell a right translation from a naive one (`.` against `\r` and U+2028; `$` against `"a\n"` and `"a\n\n"`; `\w` against `é`, `_`, `٣` and U+212A; `\d` against `٣` and `²`; `\s` against U+001C, U+0085, U+FEFF; `\b` at non-ASCII word edges; `(?i)` against `K` / `k` / U+212A, `ſ` / `s`, `ß`, `İ`; `(?m)` anchors; `{,2}`; named groups and back-references; look-behind); the invalid ones (`[`, `(`, `a**`, `\q`, `[z-a]`); and the ones M2 calls unsupported (`(?x)…`, `a*+`, `(?>a)`, `(?i:a)`, `[[a]]`, a variable-width look-behind, a mid-pattern flag).
- `REQUIRED_OK` in `regex.test.ts`: the fixture patterns the translator MUST answer `ok` for — every construct of M2's supported list — so that answering `unsupported` everywhere cannot pass.

- [ ] **Step 1: Write the generator, the scenario and the failing tests.** `regex.golden.test.ts`: for every case, `translatePyRegex(pattern, mode)` for both modes; `invalid` requires the fixture's `error`; `ok` requires every subject's result to equal the fixture's (a pattern the fixture marks `error` answering `ok` is a failure); `unsupported` is allowed unless the pattern is in `REQUIRED_OK`. `regex.test.ts`: `REQUIRED_OK` all `ok`; memoization returns the same object; 300 distinct patterns keep the map at 256; `test` never throws on a lone surrogate.
- [ ] **Step 2: See them fail** — the two new files. Everything else green.
- [ ] **Step 3: Implement** `regex.ts` per M2: a small recursive-descent parser over code points producing the JavaScript source, never string replacement over the pattern.
- [ ] **Step 4: See them pass**; staleness test; `engine-check`. If a `(?i)` case disagrees with Python (JavaScript's `iu` folding differs from Python's for some code point), narrow the subset — `(?i)` with a pattern holding that code point becomes `unsupported` — and say so in the hand-back.
- [ ] **Step 5: Lint** as Task 1.
- [ ] **Step 6: Docs.** `engine/README.md`, the `src/value/` bullet: the translator, its three answers, where the class tables come from, and the rule that anything outside the subset is `unsupported`, never guessed.
- [ ] **Step 7: Commit:** `Translate Python regular expressions for the engine`.

---

### Task 3: Criteria and `searchModel`

**Files:**
- Create: `engine/src/search/criteria.ts`, `engine/src/search/search-model.ts`, `engine/src/evaluate/index.ts`, `tests/golden/scenarios/search_criteria.py`, `engine/test/search/criteria.test.ts`, `engine/test/search/criteria.golden.test.ts`, `engine/test/service/evaluations.test.ts`
- Generated: `engine/fixtures/golden/search_criteria.json`
- Modify: `tests/golden/model_steps.py` (`_read` gains `searchModel`), `tests/golden/scenarios/__init__.py`, `engine/test/golden/model-steps.ts` (evaluations beside reads), `engine/src/service/service.ts`, `engine/src/index.ts`, `engine/bench/run.ts`, `engine/README.md`

**Interfaces:**
- Consumes: `jsStr`, `toNumber`, `translatePyRegex`, `pyLower`, `sortedInSlices`, `wireElement`, `wireRelationship`, `ReadError`, `pageOf`'s texts.
- Produces:
  - `type Criterion` (the eight shapes); `readCriteria(raw: unknown, path: string): Criterion[]`; `compileCriteria(criteria: readonly Criterion[]): CompiledCriteria` (throws `ReadError(501, 'reaches an unsupported pattern')`); `matchElement(model: Model, element: ElementRec, c: Criterion, compiled: CompiledCriteria): boolean`; `matchRelationship(model, rel: RelRec, c, compiled): boolean`; `nameProp(props: Props): string | null` (M3).
  - `searchModel(ctx: EvalContext, params: ReadParams): Steps<SearchResultPage>` — `target` (`element` | `relationship`, required), `criteria` (default `[]`), `limit` (1–500, default 500), `offset` (≥ 0); state order, 512 entities a step, `{target, elements, relationships, total}`.
  - `src/evaluate/index.ts`: `type EvalContext = {model: Model; artifacts: ArtifactSet; placements: ViewPlacements}` — `ArtifactSet` comes in Task 4; until then declare `artifacts: unknown` and narrow it there; `EVALUATIONS: {readonly [method: string]: (ctx: EvalContext, params: ReadParams) => Steps<unknown>}` holding `searchModel`.
  - Service: every `EVALUATIONS` name is a method; `scan` job; `ReadError(501)` travels as `{status: 501, detail}`.
- Recorder: `_read`'s `searchModel` calls `read.search_model(SearchQueryIn.model_validate(params), session=session)`.
- Fixture `search_criteria.json`: a model of about 40 elements and 60 relationships over a metamodel with a subtype, a relationship subtype, a self-loop, parallel edges, an orphan, properties of every scalar kind, list values, a `Name`-cased key, a list-valued `name`, and a value per row of Task 1's `js_str` table; then `read` steps for every criterion type and op — Task 1's awkward numbers as `gt` / `lt` operands, `equals` against lists, dicts, bools and integral floats, `contains` with non-ASCII case, `matches` with Task 2's supported patterns and one invalid pattern — plus `any_of` (empty, one member, several), `relation_count` with and without `rel_types` (a subtype NOT counted), `orphan`, `connected_to_type`, `endpoint_type`, relationship queries, paging (`limit` 1, `offset` past the end, the 500 default), and a batch between two identical reads so that state order after churn is held.

- [ ] **Step 1: Write the scenario and the failing tests.** `criteria.golden.test.ts` replays `search_criteria` through `replaySteps` with evaluations beside reads (each drained). `criteria.test.ts`: `readCriteria` fills defaults, accepts `relTypes` and `rel_types`, ignores unknown keys, refuses a missing `type`, a nested `any_of` and `count: "3"` with texts naming the path; `compileCriteria` refuses `(?x)a` with 501 and accepts `[`; `nameProp` skips a list-valued `name`. `evaluations.test.ts` (over `test/service/helpers.ts`' port pair): `searchModel` answers the fixture model's first page; a 501 arrives as `{status: 501, detail: 'reaches an unsupported pattern'}`; a read posted after it is answered; a cancelled scan is never answered; with a clock that advances 1 ms per `now()`, no slice of a 5,000-element scan exceeds 16.
- [ ] **Step 2: See them fail** — the three new files. Everything else green.
- [ ] **Step 3: Implement** per M3 and M4's evaluation half; the recorder change; `model-steps.ts` looks a `read` step's method up in `READS`, then in `EVALUATIONS` (called with `{model, artifacts: <the replay's set>, placements}`).
- [ ] **Step 4: See them pass**; staleness test; `engine-check`.
- [ ] **Step 5: Bench.** `engine/bench/run.ts` gains `criteria scan (property contains 'a')` in the stepped rows: total and longest step at M (`pixi run engine-bench`, after `engine-bench-data` once). Report the numbers; do not optimize.
- [ ] **Step 6: Lint** as before.
- [ ] **Step 7: Docs.** `engine/README.md`: a `src/search/` bullet (criteria, the Python coercions, exact type names, the 501 for an unsupported pattern) and a `src/evaluate/` bullet (`EvalContext`, `EVALUATIONS`, always a scan, artifacts and patterns resolved before the first step); the golden-fixtures bullet gains evaluations in `read` steps.
- [ ] **Step 8: Commit:** `Evaluate criteria searches in the engine`.

---

### Task 4: The artifact set

**Files:**
- Create: `engine/src/artifacts/artifact-set.ts`, `engine/test/artifacts/artifact-set.test.ts`
- Modify: `engine/src/evaluate/index.ts` (narrow `artifacts`), `engine/src/service/service.ts`, `engine/src/service/types.ts`, `engine/src/index.ts`, `engine/test/service/evaluations.test.ts`, `engine/README.md`

**Interfaces:**
- Produces: `WireArtifact`, `WireStagedArtifact` (M4); `readArtifacts(raw: unknown): CommittedArtifact[]`, `readStagedArtifacts(raw: unknown): StagedArtifact[]` (422 in the engine's words); `class ArtifactSet { setCommitted(list); put(changed, deletedIds); setStaged(entries); resolve(id): ResolvedArtifact | null; get size(): number }` with `ResolvedArtifact = {id, kind, name, payload: Value}`.
- Service methods (`now`): `setArtifacts {artifacts}`, `putArtifacts {changed, deleted_ids, staged?}`, `setStagedArtifacts {entries}` → `null`.

- [ ] **Step 1: Write the failing tests.** `artifact-set.test.ts`: each resolution rule of M4 (committed; staged create under `tmp_x`; update over committed with only `name`, only `payload`, both; update with nothing under it → `null`; delete hides; `setStaged([])` restores the committed view; `put` then `setStaged` in either order); a payload with `1` read through D4 is the int `1`, with `1.5` a `PyFloat`; mutating the object passed in after `setCommitted` changes nothing resolved; a malformed entry refuses and leaves the set as it was. **Review Focus 1:** a staged create `tmp_a` whose payload names `tmp_b`, staged too — both resolve; a staged delete of a committed id → `null`. `evaluations.test.ts` gains: the three methods answer `null` in `opening`; `setArtifacts` survives `close` + `open` of the same service; a malformed `putArtifacts` is a 422.
- [ ] **Step 2: See them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: See them pass**; `engine-check`; `engine-tidy`.
- [ ] **Step 5: Docs.** `engine/README.md`: a `src/artifacts/` bullet (the two layers, `resolve`, D4's reading, that it survives `close`); the `src/service/` bullet lists the three methods among the `now` kind.
- [ ] **Step 6: Commit:** `Hold the project's artifacts in the engine`.

---

### Task 5: Navigation

**Files:**
- Create: `engine/src/navigation/{schema,resolve,evaluate,route}.ts`, `tests/golden/scenarios/nav_eval.py`, `engine/test/navigation/nav.test.ts`, `engine/test/navigation/nav.golden.test.ts`, `engine/test/navigation/staged.test.ts`
- Generated: `engine/fixtures/golden/nav_eval.json`
- Modify: `src/data_rover/core/navigation/evaluate.py` (D2), `tests/navigation/test_evaluate.py`, `tests/golden/model_steps.py`, `tests/golden/scenarios/__init__.py`, `engine/test/golden/model-steps.ts`, `engine/src/evaluate/index.ts`, `engine/src/index.ts`, `engine/bench/run.ts`, `engine/README.md`, `BACKLOG-ENGINE.md`

**Interfaces:**
- Consumes: `readCriteria`, `compileCriteria`, `matchElement`, `ArtifactSet.resolve`, `treeItem` (`src/read/tree.ts`), `sortedInSlices`, `toWire`, `pyRepr`.
- Produces: `readNavigation(raw: unknown, path: string): NavigationDefinition` (M5); `resolveRefs(defn, fetch: (id: string) => NavigationDefinition, seen?: ReadonlySet<string>): NavigationDefinition`; `navigationHasScript(defn): boolean`; `class NavigationResolveError extends Error` (texts of fact 7); `type EvalLimits = {maxVisited: number; maxChains: number}` (defaults 100,000 / 5,000); `type ChainNode = string | PropertyValue` (an element id or a terminal value); `type ChainResult = {stepTypes: string[]; chains: ChainNode[][]; truncated: boolean}`; `type ChainPageOut = {step_types: string[]; chains: (TreeItem | {kind: 'value'; value: unknown})[][]; total: number; truncated: boolean; warnings: []}`; `evaluateSteps(mm, model, defn, limits, rowElements: readonly string[] | null): Steps<ChainResult>` and `evaluateNavigationCore(...)` = its `drain`; `evaluateNavigation(ctx, params): Steps<ChainPageOut>` (M7), added to `EVALUATIONS`.
- Recorder steps:
  - `{"do": "artifacts", "_artifacts": {id: {"kind", "payload"}}}` replaces the recorder's committed artifacts; result `null`; logged with the artifacts (tagged).
  - `read` with `evaluateNavigation` calls `routes.artifacts.evaluate_navigation(EvaluateNavigationIn.model_validate(params), project_id="p", session=session, db=_ArtifactDb(self._artifacts), runner=None, settings=Settings())`; `_ArtifactDb.get(ArtifactRow, id)` returns a `SimpleNamespace(project_id="p", kind=ArtifactKind(kind), payload=payload)` or `None`.
  - `{"do": "navigate", "definition", "limits": {"max_visited", "max_chains"}, "row_elements"}` resolves refs against the recorder's artifacts and calls core `evaluate` with those limits; records `{step_types, chains, truncated}`, element nodes as ids and value nodes as `{"value": tagged}`.
  - `{"do": "has_script", "definition"}` records `navigation_has_script(resolve_refs(...))`.
  - The engine replay keeps an `ArtifactSet` (`setCommitted` from `artifacts` steps), runs `navigate` through `evaluateNavigationCore` and `has_script` through `navigationHasScript(resolveRefs(...))`, and compares as for reads.
- Fixture `nav_eval.json` — a metamodel with an element subtype chain, a relationship subtype, a containment type, a scalar property of every kind, a single and a list element-typed property; a model of about 30 elements with parallel edges, a self-loop, a cycle, dangling element-typed values and a list holding a dict (D2); artifacts: three navigations, a table (a ref of the wrong kind) and a snippet. Cases: every step kind; `either` with a self-loop; target types; `exclude_visited` true and false over the cycle; typed and untyped scopes with and without criteria (existence gating; an empty `any_of`); every set op, nested, operands by ref and inline, `step_index` 0, k, null and out of range; a set as a path's start; row starts bound, unbound and to an unknown id with each step kind (fact 7); a ref missing, of another kind, a cycle and a diamond; `artifact_id` known and unknown; paging; a scalar property step ending in a `1.0`, a `1`, a `True` and a `"1"` in one list (three nodes and a string); `navigate` cases that hit `max_chains` and `max_visited` (and a set start that truncates); `has_script` on definitions with an empty snippet, an inline snippet, a ref, and a script step reached only through a ref'd navigation.
- The Python fix (D2): in `_hop_property`, `set(item for item in candidates if isinstance(item, str))` and the `sorted(...)` over it; `tests/navigation/test_evaluate.py` gains the dict-in-list case expecting the string items only.

- [ ] **Step 1: The Python fix, test first.** Add the `test_evaluate.py` case; `pixi run -e core-dev pytest tests/navigation -q` → it fails with the `TypeError`; apply the one-line fix; it passes.
- [ ] **Step 2: Write the scenario, the recorder steps and the failing engine tests.**
  - `nav.golden.test.ts` replays `nav_eval`.
  - `nav.test.ts`: `readNavigation` — defaults filled, each refusal text of M5, a missing `kind` refused; `evaluateSteps` over a 3,000-element seeded model — successive yields at most 1,024 units apart, the drained result equal to `evaluateNavigationCore`; `PropertyValue` keys keep `true`, `1`, `1.0` apart; `evaluateNavigation` answers 501 for an inline script step and for one reached through a ref, and 422 before any step for a bad `limit`.
  - `staged.test.ts` (**Review Focus 1**): every `read` step of `nav_eval` replayed a second time with every artifact moved into the STAGED layer (creates under their own ids) gives the same answers; a staged navigation `tmp_a` whose operand refs a staged `tmp_b` evaluates `tmp_b`; with `tmp_b` then staged as a delete, 422 `unknown navigation artifact 'tmp_b'`; a staged update of a committed navigation is what `artifact_id` evaluates.
- [ ] **Step 3: See them fail** — the three new files. Everything else, and the Python suite, green.
- [ ] **Step 4: Implement** per M5–M7.
- [ ] **Step 5: See them pass**; the staleness test; `engine-check`; `pixi run core-test`.
- [ ] **Step 6: Bench.** A stepped row `navigation, untyped scope, one relationship hop` at M: total and longest step. Report.
- [ ] **Step 7: Lint** as before.
- [ ] **Step 8: Docs.** `engine/README.md`: a `src/navigation/` bullet (the reader, resolution through the `ArtifactSet`, the 501, the evaluator in steps, the route's error texts including the two mirrored quirks). `BACKLOG-ENGINE.md`: `C-22` — the navigation route's `LookupError` handler also catches the evaluator's `KeyError` (an unknown `row_element_id` behind a filter or property step answers 422 `unknown navigation artifact 'x'`, with no steps 404 `x`), and the top-level `artifact_id` refusal names the id unquoted while a nested ref's is quoted; mirrored by the engine; fix on both sides with a fixture.
- [ ] **Step 9: Commit:** `Evaluate navigations in the engine`.

---

### Task 6: Artifact payloads reach the engine

**Files:**
- Create: `tests/api/test_artifact_payloads_route.py`, `frontend/src/lib/engine/artifacts.ts`, `frontend/src/lib/engine/__tests__/artifacts.test.ts`
- Modify: `src/data_rover/api/routes/artifacts.py`, `src/data_rover/api/schemas.py`, `frontend/src/lib/api/artifacts.ts`, `frontend/src/lib/api/types.ts`, `frontend/src/lib/engine/sync.ts`, `frontend/src/lib/engine/__tests__/sync-call.test.ts` (where the placements' re-send is tested), `frontend/src/lib/state/artifact-edits.svelte.ts`, `frontend/src/lib/state/replica.svelte.ts`, `frontend/src/lib/state/__tests__/replica.svelte.test.ts`, `src/data_rover/api/README.md`, `frontend/src/lib/engine/README.md`

**Interfaces:**
- Server: `GET /artifacts/payloads` with repeated `id` query params (optional) → `ArtifactPayloadListOut{items: list[ArtifactOut]}`: every artifact of the project in `content.list_artifacts` order, or only the named ids that exist (unknown ids left out, no error); viewer-callable; declared before `/artifacts/{artifact_id}` (fact 14).
- `lib/api/artifacts.ts`: `listArtifactPayloads(ids?: readonly string[], cfg?): Promise<Artifact[]>`.
- `sync.ts` (M8): `setArtifacts(artifacts: readonly WireArtifact[]): void`, `putArtifacts(changed: readonly WireArtifact[], deletedIds: readonly string[], staged?: readonly WireStagedArtifact[]): void`, `setStagedArtifacts(entries: readonly WireStagedArtifact[]): void` on `ReplicaSync`.
- `lib/engine/artifacts.ts`: `createArtifactFollower(deps: {sync: Pick<ReplicaSync, 'setArtifacts' | 'putArtifacts' | 'setStagedArtifacts'>; payloads(ids?: readonly string[]): Promise<Artifact[]>; staged(): WireStagedArtifact[]}): ArtifactFollower` with `load()`, `onEvent(action: 'created' | 'updated' | 'deleted', header: ArtifactHeader)`, `onCommit(info: {changed: ArtifactHeader[]; deletedIds: string[]})`, `stagedChanged()`, `stop()`.
- `artifact-edits.svelte.ts`: `onStagedArtifactsChanged(cb: () => void): () => void`; `stagedArtifactsForEngine(): WireStagedArtifact[]`.

- [ ] **Step 1: Server, test first.** `test_artifact_payloads_route.py` with `client`, `seed_default_project`, `AUTH_HEADERS`: all payloads in list order; `?id=a&id=ghost` → only `a`; a viewer is allowed; another project's artifact never appears; `GET /artifacts/payloads` is not read as an artifact id. Implement the route and the schema; `pixi run -e core-dev pytest tests/api/test_artifact_payloads_route.py -q`.
- [ ] **Step 2: Write the failing frontend tests.**
  - `artifacts.test.ts` over the in-process engine (`connectInProcess`) and a stub `payloads`: `load()` then an `evaluateNavigation` of an `artifact_id` resolves it; an `updated` event with a newer rev fetches that id and an older rev fetches nothing; `deleted` drops it; **Review Focus 2:** `onCommit` holds — a `stagedChanged()` during the fetch posts no `setStagedArtifacts`, and the one `putArtifacts` carries the buffer as it is when the fetch lands, the staged entry edited during the fetch included; **Review Focus 4:** `stop()` during a fetch → the late answer posts nothing.
  - `sync-call.test.ts` gains: **Review Focus 3:** after a worker dies and a new link is adopted, the new engine gets `setArtifacts` then `setStagedArtifacts` before a held `evaluateNavigation`, which resolves the artifact; `stop()` clears both.
  - `replica.svelte.ts` tests: an `artifact` feed event reaches the follower; a `snapshot` feed event re-loads; `onArtifactCommit` and a staged change reach it; a staged payload that is a `$state` object crosses (fact 12).
- [ ] **Step 3: See them fail.**
- [ ] **Step 4: Implement** per M8.
- [ ] **Step 5: See them pass**: `pixi run frontend-test`, `pixi run frontend-check`, `pixi run core-test`.
- [ ] **Step 6: Lint** — `pixi run dr-tidy`.
- [ ] **Step 7: Docs.** `src/data_rover/api/README.md`: the payloads route. `frontend/src/lib/engine/README.md`: the sync's artifact context, the follower (events, commit hold, generation), the staged mirror.
- [ ] **Step 8: Commit:** `Hand the project's artifacts to the engine`.

---

### Task 7: Two surfaces and the server fallback

**Files:**
- Modify: `frontend/src/lib/api/engine-route.ts`, `frontend/src/lib/engine/surfaces.ts`, `frontend/src/lib/api/artifacts.ts`, `frontend/src/lib/api/model-read.ts`, `frontend/src/lib/api/types.ts`, `frontend/src/lib/state/replica.svelte.ts`, `frontend/src/lib/state/navigation-editor.svelte.ts`, `frontend/src/lib/components/Navigation/ResultsDock.svelte`, their tests (`api/__tests__/engine-route.test.ts`, `engine/__tests__/surfaces.test.ts`, `engine/__tests__/shadow.test.ts`, `api/__tests__/artifacts.test.ts`, `api/__tests__/model-read.test.ts`, `components/Navigation/__tests__/results-dock.test.ts`), `frontend/src/lib/engine/README.md`

**Interfaces:**
- Consumes: the engine's `evaluateNavigation` and `searchModel` (Tasks 3, 5), the follower (Task 6).
- Produces: `Surface` with `'navigation' | 'criteria'`; `READ_SURFACES`; `route(..., options?: {mark?: (value: T, reason: 'script' | 'pattern') => T})`; `ChainPage.fallback?: 'script' | 'pattern'`; the preview's `fallback: 'script' | 'pattern' | null` (M9).

- [ ] **Step 1: Write the failing tests.**
  - `surfaces` tests: `navigation` and `criteria` default to `server`; `staging: engine` forces B's five and leaves the two alone; `dr.surfaces` can set each.
  - `engine-route` tests: a 501 `reaches a script` → the server answers and `mark` is applied with `'script'`; `reaches an unsupported pattern` → `'pattern'`; another 501 rejects; no shadow probe on a fallback.
  - `artifacts` / `model-read` tests (in-process engine, MSW for the server side): with the surface on `engine`, `evaluateNavigation` of an inline definition is the engine's page; of an inline script step, the server's page with `fallback: 'script'`; `searchModel` with a staged property edit finds the staged value (the server, MSW, is never asked); **Review Focus 5:** `searchModel` with `matches (?x)a` reaches MSW. With the surface on `server`, both hit MSW only.
  - The shadow's staged probe: a staged artifact entry suppresses a comparison.
  - `ResultsDock` test: a preview with `fallback: 'script'` shows `nav-fallback` with the script text; `null` shows nothing.
- [ ] **Step 2: See them fail.**
- [ ] **Step 3: Implement** per M9.
- [ ] **Step 4: See them pass**; `frontend-check`.
- [ ] **Step 5: Lint** — `dr-tidy`.
- [ ] **Step 6: Docs.** `frontend/src/lib/engine/README.md`, "Surfaces": the two new surfaces, `READ_SURFACES` and the staging force, the 501 fallback and its mark, the dock's note; "Shadow comparison": the staged-artifact gate.
- [ ] **Step 7: Commit:** `Route navigations and criteria searches through the engine`.

---

### Task 8: The flip, e2e and the documents

**Files:**
- Create: `frontend/e2e/eval-navigation.spec.ts`
- Modify: `frontend/src/lib/engine/surfaces.ts` (defaults), its test, `frontend/e2e/engine-mode.spec.ts` (if it lists surfaces), `architecture/contracts.md`, `architecture/decisions.md`, `architecture/program.md`, `BACKLOG-ENGINE.md`, `src/data_rover/core/metamodel/schema.py` (the comment at :203), `engine/README.md`, `frontend/src/lib/engine/README.md`, `docs/superpowers/specs/2026-09-24-evaluation-design.md` (local)

- [ ] **Step 1: Flip.** `SURFACE_DEFAULTS.navigation` and `.criteria` become `engine`; the surfaces test follows.
- [ ] **Step 2: e2e.** `eval-navigation.spec.ts`, importing `test` / `expect` from `e2e/fixtures.ts` (engine mode, shadow on, a `[shadow]` line fails the test): stage a navigation that refs another staged navigation and see the results dock list the staged one's elements before any commit; a navigation with a script step shows `nav-fallback` and the server's rows; the advanced search finds an element whose name was renamed and not committed; commit, reload, and the same navigation evaluates from the committed artifacts. Stop any stale `vite preview` on :5174 first; `pixi run sandbox-build`; `pixi run frontend-test-e2e`. The whole suite must stay free of `[shadow]` lines.
- [ ] **Step 3: `architecture/`.**
  - CT-4: the three artifact methods among the "Context" methods, answered in any state and sent again to every new worker; `searchModel` and `evaluateNavigation` among the reads; the 501 refusal with its two details and that the client answers it from the server.
  - CT-5.5: "The artifact family is the committed payloads the shell hands in plus the staged entries mirrored from the frontend's buffer; references resolve against it, staged artifacts included. View and metamodel staged buffers stay in the frontend." — replacing "*B built the model family; the artifact family is C's.*".
  - `decisions.md`: `AD-30 · The staged artifact buffer stays in the frontend; the engine mirrors it` (why: payload checks stay on the server, an artifact entry replaces its payload whole and meets no model op, checkout is untouched; rejected: an engine-owned buffer, a closure per call); `AD-31 · Before scripts run in the browser, a call that reaches a script is the server's` (why: one table or navigation never mixes committed and working state; rejected: forwarding script calls, placeholder cells; consequence: the 501, the fallback marker, D deletes both). Cite them in CT-4 and CT-5.
  - `program.md`: C's status `in progress — plan 1 of 8 built (artifacts in the engine, navigation and criteria search served by it)`.
- [ ] **Step 4: Backlog.** `BACKLOG-ENGINE.md`: `C-20` closes — `check_metamodel` refuses a property that redeclares an ancestor's, so the two readings never differ on a metamodel that reaches the engine; `R-3`'s open list and the freeze sentence (`core/search`, `core/navigation`, the two route functions frozen, and out of the freeze for features now that their surfaces default to the engine). `core/metamodel/schema.py:203`'s comment reads what the code does: `# root -> leaf; check_metamodel refuses a redeclared property, so the first definition seen is the only one`.
- [ ] **Step 5: Spec.** The local spec's §1: the artifact methods are context methods (D1), not model-lane transitions.
- [ ] **Step 6: Everything green.** `pixi run dr-test`, `pixi run dr-tidy true`, `pixi run engine-check`, `pixi run frontend-check`, `pixi run sandbox-check`.
- [ ] **Step 7: Commit:** `Serve navigations and criteria searches from the engine by default`. Then, with the owner's go-ahead, fast-forward `engine-migration` to `feat/eval-navigation`.

## After this plan

Plan 2 (validation core) starts from: an engine that holds artifacts (the rules artifacts of plan 3 arrive the same way), an `EVALUATIONS` table and its scan registration, the regex translator's `fullmatch` mode for pattern facets, `jsStr`/`pyReprValue` for messages, and `route()`'s 501 fallback. Open from this plan: `C-22`.
