# Randomized splines + structured script warnings

Date: 2026-07-25

Two independent fixes that happen to share a session. They touch disjoint files
and can be implemented and reviewed separately.

1. **Splines** — the project-open flavor text always runs in authored order, so
   only the first few lines are ever seen.
2. **Script warnings** — the table/navigation warning channel dedupes by
   rendered message text while the messages carry counts *inside* the text, so
   the counts it reports are wrong, near-identical lines fragment, and the strip
   renders raw backend prose.

---

## Part 1 — Randomized splines

### Problem

`frontend/src/lib/state/open-journey.ts` holds 19 flavor lines (`SPLINES`).
`_splineIndex` starts at 0 and increments once per `SPLINE_MS` (4200 ms) tick;
`splineAt` wraps it over the array. A typical project open completes in a
handful of ticks, so a user sees lines 0–3 on every single open and never sees
lines 4–18.

### Constraint

The module header makes an explicit promise:

> The controller (added below) contains no `Date.now()`/`Math.random()`:
> elapsed time is accumulated from the ticker interval so the store is
> deterministic under fake timers.

`open-journey.test.ts` depends on it: it asserts the first label is `SPLINES[0]`
and that the label after one spline period is `SPLINES[1]`. A bare
`Math.random()` would break both the promise and the tests.

### Design

Shuffle once per journey and walk that order, so every line gets a turn before
any repeat and each open reads differently.

**`shuffled(items, rand)`** — a new exported pure helper using the *forward*
Fisher–Yates variant:

```ts
for (let i = 0; i < out.length - 1; i++) {
  const j = Math.min(out.length - 1, i + Math.floor(rand() * (out.length - i)));
  [out[i], out[j]] = [out[j], out[i]];
}
```

The forward variant is chosen deliberately: with `rand = () => 0` every `j`
equals `i`, so the result is the **identity permutation**. (The conventional
backward variant swaps `out[i]` with `out[0]` and does *not* degenerate to
identity.) That property is what lets the existing fake-timer tests keep their
verbatim `SPLINES[0]` / `SPLINES[1]` assertions. The `Math.min` clamp guards
against a stub `rand` that returns exactly `1` — `Math.random` never does, but
the seam is public.

**The RNG seam** — a module-level `let _rand: () => number = Math.random` plus
an exported `setSplineRandom(fn: () => number): void`. Production uses the
default; tests install `() => 0` (identity) or a scripted sequence. This keeps
the module header's promise honest: the *controller* still contains no
`Math.random()` call of its own, only an injectable source with a documented
default. The header comment is updated to say exactly that rather than deleted.

**Journey wiring**

- New module state `let _order: readonly string[] = SPLINES`.
- `beginJourney` sets `_order = shuffled(SPLINES, _rand)` before taking the
  first label, and starts from `_order[0]`.
- `_onSplineTick` reads `cycleAt(_order, _splineIndex)`. When the index wraps
  past the end (`_splineIndex % SPLINES.length === 0`) it **re-shuffles**, so a
  very long open does not replay the same permutation. 19 lines × 4.2 s ≈ 80 s,
  so this path is rare but cheap.
- `_stop()` resets `_order = SPLINES` alongside the other fields.
- `setSplineRandom` is deliberately **not** reset by `resetJourney()` — a test
  installs it once in `beforeEach` and it must survive the teardown that runs
  in `afterEach`.

**`splineAt` stays exported and behaviorally unchanged.** It is refactored to
`cycleAt(SPLINES, index)` over a new shared `cycleAt(list, index)` wrap helper
(the existing `((i % n) + n) % n` negative-tolerant modulo), so its current
tests continue to pass untouched and the journey reuses the same wrap logic
over `_order`.

### Tests

`frontend/src/lib/state/__tests__/open-journey.test.ts`:

- `shuffled(SPLINES, () => 0)` returns the identity order (this is the property
  the whole seam rests on — assert it explicitly, not incidentally).
- `shuffled` returns a permutation: same length, same set, original untouched.
- A `rand` returning `0.999…` never produces an out-of-range index.
- Over 19 ticks with a scripted non-identity `rand`, the emitted labels are all
  19 distinct lines.
- Tick 20 (the wrap) re-shuffles rather than replaying the first permutation.
- Existing tests gain a `beforeEach(() => setSplineRandom(() => 0))` so their
  `SPLINES[0]` / `SPLINES[1]` expectations stand verbatim.

---

## Part 2 — Structured script warnings

### Problem

`ScriptEvalContext.add_warning` (`src/data_rover/core/script/embed.py:202`)
dedupes by **exact message text**:

```python
if message in self._warning_set or len(self.warnings) >= MAX_SCRIPT_WARNINGS:
    return
```

Three of the four navigation warnings bake a count into that text
(`src/data_rover/core/navigation/evaluate.py`):

| line | message |
| --- | --- |
| `:355` | `script step: snippet artifact {ref!r} not found` |
| `:363` | `script step failed: {res.error.message}` |
| `:371` | `script step returned {N} unknown element id(s)` |
| `:435` | `script step: {N} element(s) dropped (already visited in this chain)` |

Consequences:

1. **Counts are wrong.** Ten chains each dropping one unknown id emit ten
   identical strings, deduped to one line reading "1". The user is told 1 when
   the true figure is 10.
2. **Near-identical lines fragment.** Chains dropping 1, 2 and 5 produce three
   separate lines saying almost the same thing, when one line saying 8 is the
   truth.
3. **The cap gets burned by count variants.** A spread of counts fills
   `MAX_SCRIPT_WARNINGS` (20) with near-duplicates and crowds out genuinely
   different warnings. (`routes/tables.py:288` already has a comment defending
   the sort warning's emission order against exactly this.)
4. **Presentation is raw.** `TableView.svelte:413` renders
   `{warnings.join(' · ')}` — developer-toned prose (`element(s)`,
   `script step:`) crammed into one line with middle dots, with no indication of
   how many rows are affected. `ResultsDock.svelte:161` shows
   `⚠ {warnings.length} script warnings`, a count of *distinct strings*, which
   inherits every problem above.

### Design

Make the channel structured, aggregate by kind rather than by rendered text,
and move the copy to the client.

#### Core (`src/data_rover/core/script/embed.py`)

```python
class ScriptWarningCode(StrEnum):
    NAV_SNIPPET_NOT_FOUND = "nav_snippet_not_found"
    NAV_STEP_FAILED = "nav_step_failed"
    NAV_UNKNOWN_IDS = "nav_unknown_ids"
    NAV_ALREADY_VISITED = "nav_already_visited"
    SORT_NEEDS_SCRIPT_NAV = "sort_needs_script_nav"


@dataclass
class ScriptWarning:
    code: ScriptWarningCode
    #: How many times this kind fired.
    occurrences: int = 0
    #: Summed subject count (ids returned unknown, elements dropped). 0 for
    #: kinds that have no such quantity.
    total: int = 0
    #: The variable part — an artifact ref, an error message. Part of the
    #: aggregation key, so two distinct failures stay two distinct rows.
    detail: str | None = None
```

`self.warnings` becomes `list[ScriptWarning]`, backed by an insertion-ordered
`dict[(code, detail), ScriptWarning]`. The new signature:

```python
def add_warning(
    self,
    code: ScriptWarningCode,
    *,
    detail: str | None = None,
    count: int = 0,
) -> None
```

`occurrences += 1` always; `total += count`. `MAX_SCRIPT_WARNINGS` (20) now caps
**distinct kinds**: once full, a *new* key is dropped but *existing* keys keep
accumulating — today the cap silently stops counting everything, which is the
worse failure. Overflow is far less likely after this change, since keys are now
bounded by 5 codes × distinct details rather than by every count variant; only
`nav_step_failed` and `nav_snippet_not_found` carry unbounded details. No
truncation flag is exposed (YAGNI — today's cap is silent too); the cap
behavior is documented on the method.

**Snapshot/diff.** `navigation/evaluate.py` slices `script.warnings[w0:]` at
`:126`, `:141` and `:175` so `ChainResult.warnings` carries only what *this*
evaluate call produced. Index slicing cannot express that once entries mutate in
place, so the context gains:

```python
def warning_snapshot(self) -> dict[tuple[ScriptWarningCode, str | None], tuple[int, int]]
def warnings_since(self, snap) -> list[ScriptWarning]
```

`warnings_since` returns, in insertion order, a `ScriptWarning` per key whose
`occurrences` grew, carrying the **delta** occurrences/total. The documented
"only THIS call" semantics on `ChainResult` are preserved exactly; only the
mechanism changes. `ChainResult.warnings` becomes `list[ScriptWarning]`.

#### Call sites

- `navigation/evaluate.py:355` → `add_warning(NAV_SNIPPET_NOT_FOUND, detail=step.snippet.ref)`
- `navigation/evaluate.py:363` → `add_warning(NAV_STEP_FAILED, detail=res.error.message)`
- `navigation/evaluate.py:371` → `add_warning(NAV_UNKNOWN_IDS, count=len(raw) - len(known))`
- `navigation/evaluate.py:435` → `add_warning(NAV_ALREADY_VISITED, count=dropped)`
- `table/evaluate.py:741` and `routes/tables.py:292` → `add_warning(SORT_NEEDS_SCRIPT_NAV)`

The `SORT_SCRIPT_NAV_WARNING` prose constant (`table/evaluate.py:602`) is
deleted — its copy moves to the client. The comment block above it explaining
*why* the wording says "sorting by this column needs" rather than "this
column's navigation" moves with the copy, to the client formatter, because that
is where the wording now lives.

#### Wire (`src/data_rover/api/schemas.py`)

New `ScriptWarningOut` (`code: str`, `occurrences: int`, `total: int`,
`detail: str | None`). `code` is typed `str`, not the enum, so a client that
does not know a newly added code still parses the payload.

- `TablePageOut.warnings` (`:1010`): `list[str]` → `list[ScriptWarningOut]`
- `NavigationPreviewOut.warnings` (`:864`): `list[str]` → `list[ScriptWarningOut]`

Both are read-only response fields with no stored form, so this is a pure
response-shape change — no migration, no persisted data affected.

#### Frontend

**`frontend/src/lib/script/warnings.ts`** (new, pure) owns every user-facing
string:

```ts
export function formatScriptWarning(w: ScriptWarning): string
```

One branch per code, with correct pluralization driven by the real numbers:

| code | copy |
| --- | --- |
| `nav_unknown_ids` | Navigation script returned {total} unknown element id(s) across {occurrences} call(s) — dropped. |
| `nav_already_visited` | {total} element(s) already visited in the chain, dropped across {occurrences} step(s). |
| `nav_step_failed` | Navigation script step failed ({occurrences}×): {detail} |
| `nav_snippet_not_found` | Navigation script step references a snippet that no longer exists ({detail}). |
| `sort_needs_script_nav` | Sorting by this column needs script values that aren't computed for every row, so rows stay in build order. |

An unrecognized code falls back to `detail ?? code`, so a server ahead of the
client degrades to something readable rather than to a blank strip.

**`ScriptWarningsPanel.svelte`** (new, in `components/Table/`) — a dumb
presenter in the same mould as the neighbouring `ScriptErrorsPanel`: non-modal
`role="dialog"`, absolutely positioned below its trigger, owns no fetching and
no open/closed state, renders `<ul>` of formatted lines. Unlike the errors
panel there is nothing to fetch and no jump targets — warnings are
whole-evaluation facts, not per-cell ones — so it has no loading/empty phases.

**`TableView.svelte`** — the `{warnings.join(' · ')}` strip (`:411-415`) becomes
a summary line, `⚠ {n} script warning(s)`, plus a **View** toggle button that
opens the panel. It follows the script-errors badge's existing conventions in
this file: a `relative` wrapper, `aria-controls`/`aria-expanded` on the trigger,
Escape-to-dismiss handled on the shared wrapper, and an `$effect` closing the
panel when `warnings.length === 0` so it cannot outlive what it describes. It
stays in the tab's **fixed chrome** for the reason already documented at
`:416-423` — an in-flow element inside the grid's scroll container would scroll
away and would shift the virtualizer's row math.

**`ResultsDock.svelte:159-161`** keeps its inline badge; its count is now
distinct *kinds*, which no longer lies, and its `title` tooltip is built from
the shared formatter joined by newlines. No panel there — navigation is outside
the scope of "table warnings", and the badge+tooltip already works.

**`frontend/src/lib/api/types.ts`** — a `ScriptWarningSchema` zod object
replaces `z.array(z.string())` at `:502` and `:840`. `frontend/src/lib/state/`
`table-editor.svelte.ts:120` and `navigation-editor.svelte.ts:103` retype their
`warnings` field.

### Tests

Python:

- `tests/navigation/test_script_step.py` — assert on codes and aggregated
  counts. New case: N chains each dropping one id yield **one** warning with
  `occurrences=N, total=N` (the bug this fixes). New case: two distinct error
  messages stay two rows.
- `tests/table/test_script_column.py`, `tests/api/test_tables_nav_script.py`,
  `tests/api/test_script_embedding_routes.py` — updated to the structured shape.
- New: `warnings_since` returns deltas, not absolutes, when a key already had
  counts before the snapshot.
- New: the 20-kind cap drops new keys but keeps counting existing ones.

Frontend:

- `formatScriptWarning` — one case per code, singular/plural boundaries at 1,
  and the unknown-code fallback.
- `ScriptWarningsPanel` renders one line per warning.
- `TableView` shows the summary count, opens the panel on click, and closes it
  when the warnings go away.
- `open-journey.test.ts` as listed in Part 1.

### Out of scope

- Navigation gets no warnings panel (badge + tooltip only).
- No truncation indicator when the 20-kind cap is hit.
- No change to the script *errors* recap, `script_status`, or the sweep.
