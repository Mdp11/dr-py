# `core/script/` — snippet facade & runtime reference

This package is the sandbox-agnostic core of code-snippet execution: the
`dr` facade source (`facade_src.py`), the host-side bridge dispatcher
(`bridge.py`), the `ScriptRunner` protocol + dataclasses (`runner.py`), the
payload schema (`schema.py`), and server-side lint (`lint.py`). It imports
only `data_rover.core.*` + stdlib — no `wasmtime`, no `data_rover.api.*`. The
sandbox itself (`WasmScriptRunner`) lives in `src/data_rover/api/
script_runner.py`; the unsandboxed test double (`TrustedRunner`) lives in
`tests/script/trusted_runner.py`. See `CLAUDE.md`'s "Code execution
(snippets)" subsection for how these fit into the wider API.

## The `dr` facade surface

Per-member reference is generated from the facade's own docstrings (see
core/script/docs.py and GET /snippets/docs) — those docstrings are
canonical; this section is the narrative overview.

`dr` is not a Python module on disk — it is the string constant
`FACADE_SOURCE` in `facade_src.py`, `exec`'d verbatim ahead of the snippet's
own source (in a fresh namespace with `_transport` and `_read_memo_max`
already bound; see "Bridge wire contract" below). Both the WASM guest and
`TrustedRunner` `exec` the *same* string, so the surface below is exactly
what a snippet author gets in either environment.

The facade and the snippet are **two separate compilation units** — the facade
under the filename `<facade>`, the snippet under `<snippet>`. Concatenating
them (as this code originally did) offset every traceback frame and every
`SyntaxError` by the facade's ~300 lines, so a three-line snippet reported
errors on line 300-something; and it made facade internals appear as snippet
frames. Splitting them means `line N` is the line the author sees in the
editor, and `_format_guest_traceback`'s `<snippet>`-only filter now strips
facade frames as well as harness frames.

Module-level exceptions (all subclass `dr.BridgeError`, itself
`Exception`):

- `dr.BridgeError` — generic/unclassified error from a bridge response's
  `"error"` field that doesn't match a more specific case below.
- `dr.ReadOnlyError(dr.BridgeError)` — raised when `record_op` is attempted
  against a dispatcher built with `record_ops=False` (a `"value"`/`"step"`
  run — see "Read-only / dry-run stance").
- `dr.NotFoundError(dr.BridgeError)` — raised when a requested element/
  relationship id does not exist (bridge response `"error"` starts with
  `"KeyError"`), and when a hop's `stereotype=`/`other_stereotype=` filter
  names a stereotype the metamodel doesn't have (the `descendants` read op
  raises `KeyError` on an unknown name, so a typo'd filter surfaces instead
  of silently matching nothing).
- `dr.CardinalityError(dr.BridgeError)` — raised when a hop's `expected=`
  count assertion fails (`el.outgoing(..., expected=N)` found some other
  number of *filtered* relationships). Purely guest-side: no bridge response
  carries this. A malformed `expected` argument (not an int, a `bool`, or
  `< 1`) is a plain `ValueError` instead, raised before any bridge work.

Top-level functions/attributes on `dr`:

| call | semantics |
|---|---|
| `dr.element(element_id) -> Element` | Fetch one element by id. Raises `dr.NotFoundError` if it doesn't exist. |
| `dr.elements(stereotypes=None) -> Iterator[Element]` | Lazily iterate all elements, optionally filtered by stereotype. `stereotypes` is `None` (no filter), a single name, or a list of names; each name is expanded HOST-side through `Metamodel.element_descendants` (so a filter matches that stereotype **or any subtype**) and the expansions are unioned. An empty list is a real filter matching nothing — distinct from `None`. An unknown name expands to the empty set and therefore silently matches nothing here (unlike the hop filters below, which raise `dr.NotFoundError` on a typo — `_op_elements_page` expands names itself and never validates them). Pages transparently via the bridge's `elements_page` op (the facade requests 500 per page, clamped host-side to `page_limit`; see limits table) — a snippet never sees pagination. |
| `dr.create(stereotype, properties=None) -> str` | Records a `create_element` op (dry-run — see below) and returns a client-side temp id (`"tmp_1"`, `"tmp_2"`, ...) usable as a `source_id`/`target_id` in a later `dr.connect()` call within the same run. The recorded op's wire key is still `"type_name"` — only the snippet-visible parameter is spelled `stereotype`. |
| `dr.connect(stereotype, source_id, target_id, properties=None) -> str` | Records a `create_relationship` op (wire key `"type_name"` likewise); returns a temp id the same way. |
| `dr.disconnect(rel_id)` | Records a `delete_relationship` op. Returns `None`. |

`Element` (returned by `dr.element`, `dr.elements`, `Element.parent`,
`Element.children`, `Relationship.source`/`destination`; `__slots__ =
("_data",)`, wraps the bridge's plain
`{"id", "type", "name", "properties"}` projection):

| member | semantics |
|---|---|
| `.id` / `.stereotype` / `.name` | The element's id, stereotype (type) name, and display name. `.name` is resolved HOST-side by `_project_element` via `core.model.naming.name_of` — the same case-insensitive `name`/`Name`/`NAME` resolution the tree/search/table code uses, with a list-valued (multiplicity-many) name contributing its first non-empty string entry — and is `None` when no usable name property exists. There is **no id fallback** (that is `display_name`, which the facade does not use). The raw bag is still reachable via `el.props()`/`el.get("name")` — not `el["name"]`, which raises a plain `KeyError` whenever the property is absent or spelled `Name`/`NAME`, precisely the cases where `.name`'s resolution differs. `repr(el)` is `Element(id=..., stereotype=...)`. |
| `el[key]` | `properties[key]` — raises a plain (not `dr.`) `KeyError` if the property is absent, since this reads the already-fetched local dict, not a fresh bridge call. |
| `el.get(key, default=None)` | `properties.get(key, default)`. |
| `el.props() -> dict` | A shallow copy of the full property bag. |
| `el.outgoing(stereotype=None, other_stereotype=None, expected=None)` | Outgoing `Relationship` objects, sorted by relationship id host-side. `stereotype`/`other_stereotype` accept a str or a list of names and match that stereotype **or any subtype** (the filter is applied GUEST-side over the memoized unfiltered hop; descendant closures come from the internal `descendants` bridge op, memoized per `(kind, name)` for the session). As with `dr.elements`, an empty list for either filter is a real filter matching nothing — distinct from `None`. `other_stereotype` checks the far — for `outgoing`, the TARGET — element's stereotype; a dangling far endpoint (the engine stays inspectable) is treated as non-matching, never raising, while an *unfiltered* hop still returns that relationship. `expected` (an int ≥ 1; `bool` is rejected explicitly since it is an `int` subclass) asserts the **filtered** count, raising `dr.CardinalityError` naming the element id, the direction, the active filters, and expected vs. actual; with `expected=1` the single `Relationship` is returned directly instead of a one-item list. A bad `expected` is a `ValueError` raised before any bridge work. At most one bridge round trip for the hop itself regardless of filters — the hop is memoized under `(direction, self.id)`, so repeating it on the same element within the same run costs zero round trips — plus, on first use, one `descendants` trip per distinct filter name, and per-neighbor `element` fetches under `other_stereotype` whenever trip-collapse inlining didn't prime the memo: past `bridge.py`'s high-degree guard `_MAX_INLINE_FAR_ENDPOINTS`, or for a dangling far endpoint below that threshold, which `bridge.py` silently omits from the inline list. |
| `el.incoming(stereotype=None, other_stereotype=None, expected=None)` | Same, with the far element being the relationship's SOURCE. |
| `el.parent() -> Element | None` | The containing element, or `None` at a containment root. |
| `el.children() -> list[Element]` | Elements reached via this element's own outgoing containment relationships (derived host-side from `metamodel.is_containment`, not a dedicated model index). |
| `el.set(key, value)` | Records an `update_element` op with `properties_patch={key: value}`. Dry-run — see below. |
| `el.delete()` | Records a `delete_element` op. Dry-run — see below. |

`Relationship` (returned by `Element.outgoing`/`Element.incoming` — the only
two members that produce one; `__slots__ = ("_data",)`, wrapping a
`_copy_projection` copy of the bridge's plain `{"id", "type", "name",
"properties", "source_id", "target_id"}` relationship projection, never a
live `_memo` entry):

| member | semantics |
|---|---|
| `.id` / `.stereotype` | The relationship's id and stereotype (type) name. The wire key stays `"type"` — only the snippet-visible spelling changed. `repr(rel)` is `Relationship(id=..., stereotype=...)`. |
| `rel[key]` | `properties[key]` — a plain (not `dr.`) `KeyError` if absent, same reasoning as `el[key]`. |
| `rel.get(key, default=None)` | `properties.get(key, default)`. |
| `rel.props() -> dict` | A shallow copy of the full property bag. |
| `rel.source() -> Element` | The relationship's source element (`_fetch_element(source_id)`). |
| `rel.destination() -> Element` | The relationship's target element (`_fetch_element(target_id)`). |

Both `.source()`/`.destination()` are ordinary `_fetch_element` calls, so
they are memo-primed by trip collapse (a hop response inlines its far
endpoints' projections) and therefore typically cost **zero** round trips —
but they always record an `("el", id)` read in the call's read-set, memo hit
or not. There is deliberately **no** `.name` (the wire projection does carry
a `name` key — a raw `properties.get("name")`, *not* the `name_of`
resolution `Element.name` gets — but the facade exposes no accessor for it;
`rel.get("name")` is the same value) and no `.set()`/`.delete()`: recording
a relationship delete goes through
`dr.disconnect(rel.id)`, and `value()`/`step()` reject a `Relationship`
return value outright since the tagged wire payloads only carry elements and
scalars.

## The read-only / dry-run stance

Every `dr` **read** (`element`, `elements`, `Element.outgoing`/`incoming`/
`parent`/`children`, `Relationship.source`/`destination`, plus the internal
`descendants` closure lookup behind the hop filters) is answered by
`BridgeDispatcher` calling only
accessor methods on the live `Model`/`Metamodel` — never a mutation-boundary
method. A read-only run can never corrupt the session model, and reads never
need `session.write_mutex` (see `routes/snippets.py`'s module docstring and
the "stale" flag it derives from a benign start-rev/end-rev race).

Every `dr` **write** (`create`, `connect`, `disconnect`, `Element.set`,
`Element.delete`) is *recorded, not applied*: `BridgeDispatcher.record_op`
appends the op dict verbatim to `.ops` and returns — it never calls into
`Model`'s mutation boundary. The accumulated `RunResult.ops` list is a
*proposal* that the route layer validates via `schemas.OPS_ADAPTER` and
returns to the caller; nothing is staged into the session model until a
client separately submits it through `POST /model/ops` (or the check-out/
commit flow), exactly as a human-driven client edit would be. Op-dict
*shape* is not validated inside `bridge.py` itself — only size/count caps
(`max_ops`, `max_op_bytes`) are enforced there; shape validation happens at
the API route boundary.

Whether writes are even allowed is controlled by the *caller*, not the
snippet: `routes/snippets.py`'s `run_snippet` constructs the runner call with
`record_ops=(payload.entry == "script")` — only `entry="script"` runs may
record ops; `"value"`/`"step"` runs get a `record_ops=False` dispatcher, so
any `dr` write call in that mode raises `dr.ReadOnlyError` in the snippet.

Entry-point calling convention: a `"value"` run calls the snippet's
top-level `value(elements)` with a **list of `Element` handles** — one per
id in the request's `element_ids`, in that order (validated non-empty at the
route); a `"step"` run calls `step(el)` with its single bound element. The
arity rule for both is unchanged — exactly one argument; for `value` that
one argument is the list. This is the same calling convention an embedded
session (see "Evaluation sessions (M2/M3)" below) uses for its `value`/`step`
calls — the only difference is that a console run boots a fresh guest per
call, while a session boots once and serves many calls off the same warm
instance.

## Limits (`RunLimits`)

`core/script/runner.py`'s `RunLimits` dataclass; `api/script_runner.py`'s
`run_limits_from_settings` maps each field one-to-one from a `Settings.
snippet_*` field (`api/settings.py`), itself a `DATA_ROVER_SNIPPET_*` env var
(`Settings.model_config` sets `env_prefix="DATA_ROVER_"`).

| `RunLimits` field | default | env var | enforced as |
|---|---|---|---|
| `wall_timeout_s` | `10` | `DATA_ROVER_SNIPPET_WALL_TIMEOUT_S` | Absolute wall-clock deadline; the WASM runner arms an epoch-based kill and a wall-bounded FIFO read off this value. Exceeding it yields `ScriptError(kind="timeout")`. |
| `memory_bytes` | `256 * 1024 * 1024` (268,435,456) | `DATA_ROVER_SNIPPET_MEMORY_BYTES` | Peak guest `Store` memory cap (`store.set_limits(memory_size=...)`), armed per-run (best-effort — some wasmtime builds only honor `set_limits` before instantiation, in which case the boot-time default applies). Breach yields `ScriptError(kind="memory")`. |
| `stdout_bytes` | `256 * 1024` (262,144) | `DATA_ROVER_SNIPPET_STDOUT_BYTES` | Cumulative captured-stdout cap; guest-side `_CappedStdout` truncates and sets `RunResult.truncated`, and the host defensively re-caps in `_build_result`. |
| `result_repr_bytes` | `64 * 1024` (65,536) | `DATA_ROVER_SNIPPET_RESULT_REPR_BYTES` | Cap on `repr(value)` for `"value"`/`"step"` runs (and an explicit `result` in `"script"` mode); truncated with `truncated=True` if exceeded. |
| `max_ops` | `1000` | `DATA_ROVER_SNIPPET_MAX_OPS` | Cap on recorded op count; `BridgeDispatcher.record_op` raises `BridgeLimitError` past this (see "Error kinds" — this currently surfaces to the snippet as a `dr.BridgeError`, not a distinct `ScriptError.kind`). |
| `max_op_bytes` | `1024 * 1024` (1,048,576) | `DATA_ROVER_SNIPPET_MAX_OP_BYTES` | Cap on cumulative JSON-serialized op bytes; same `BridgeLimitError` path as `max_ops`. |
| `page_limit` | `500` | `DATA_ROVER_SNIPPET_PAGE_LIMIT` | Max elements per `dr.elements()` page (`elements_page` bridge op); a snippet never observes pagination directly. |
| `read_memo_max` | `4096` | `DATA_ROVER_SNIPPET_READ_MEMO_MAX` | Entry cap on the guest facade's session-lifetime read memo; 0 disables. |

Settings that shape the *runner*, not a per-run `RunLimits` value:
`snippet_runner` (`"wasm"` default, or `"trusted"` — gated by the RCE
tripwire, see below), `snippet_guest_wasm_path`/`snippet_guest_lib_path`
(vendor binary/stdlib paths), `snippet_pool_size` (default `6` warm guest
instances — sized as `snippet_sweep_workers` (4) for a sharded background
sweep plus 2 headroom for interactive console/table evaluation, since sweeps
draw from their own semaphore and do NOT take an interactive
`_ConcurrencyGuard` slot), `snippet_concurrency`/`snippet_per_user_concurrency` (default
`4`/`1` — enforced by `routes/snippets.py`'s `_ConcurrencyGuard`, fail-fast
429, no queuing).

## Determinism guarantees

**WASM runner only** — `TrustedRunner` (tests) applies none of this; it runs
real, unmodified CPython in-process, so `time.time()`/`random`/hashing behave
normally there. For `WasmScriptRunner`, `_add_determinism_shims` (`api/
script_runner.py`) shadows two WASI imports so that identical guest code
produces byte-identical output across runs:

- **Fixed wall clock**: `wasi_snapshot_preview1.clock_time_get` with
  `clock_id == 0` (realtime) always returns `1_750_000_000_000_000_000` ns
  (`1_750_000_000.0` s, i.e. `time.time()`/`datetime.now()` are pinned to
  that instant every run). The **monotonic** clock (any other `clock_id`) is
  left real (`time.perf_counter_ns()`), so the interpreter can still boot and
  the epoch/timeout machinery keeps working.
- **Seeded random**: `wasi_snapshot_preview1.random_get` always fills the
  guest's entropy buffer with the byte `0x42`, so `random`'s PRNG (and
  anything else that seeds off OS entropy at boot) initializes identically
  every run.
- **`PYTHONHASHSEED=0`** is set in the guest's WASI env, so `hash()` of
  strs/bytes (and therefore `set`/`dict` iteration order where it depends on
  hash) is stable across runs too.

Net effect for snippet authors: two runs of the same code against the same
model produce identical `stdout`/`result_repr` — useful for caching (a later
milestone) and for reasoning about a snippet's output without re-running it.
It also means `time.time()`/`random.random()`/`hash(...)` are **not**
sources of real entropy inside a snippet — don't rely on them to vary.

## What's absent under WASI

**Advisory vs. enforced.** `lint.py`'s `IMPORT_ALLOWLIST` (`re`, `math`,
`itertools`, `collections`, `functools`, `json`, `statistics`, `datetime`,
`string`) is what `POST /snippets/lint` warns about — importing anything
outside that set produces a **non-blocking warning** diagnostic, not a
rejection; lint never stops a save or a run. What actually determines
success or failure at **runtime** is the CPython-WASI guest's real module
availability plus the WASI capability surface the runner links in
(`Linker.define_wasi()` plus the two clock/random shims — no socket,
process-spawn, or extra filesystem capability is ever granted). Concretely,
inside a run:

- **`threading`** — not usable for real concurrency; the guest is a single
  WASI instance driven by one host worker thread per run, and no threading
  syscalls are linked in.
- **`socket`** — no networking capability is granted to the guest; there is
  no way to reach the host network or any other guest.
- **`subprocess`** — no process-spawn capability; a guest cannot launch
  child processes.
- **File I/O beyond the preopened stdlib** — the guest only has two preopened
  directories: `settings.snippet_guest_lib_path` mounted at `/lib`
  (`PYTHONHOME`/`PYTHONPATH`, i.e. the CPython-WASI stdlib) and a host-managed
  bootstrap-script directory mounted at `/spike`. There is no writable
  filesystem, no access to the project's model files, and no other host path
  is reachable — `open()` against anything outside those two mounts fails.

A snippet's only channel to host data is the `dr` facade / bridge protocol
above — there is no ambient way to reach the model, the filesystem, the
network, or another run.

## Error kinds (`ScriptError.kind`)

`core/script/runner.py`'s `ScriptError.kind` is typed as `Literal["syntax",
"runtime", "timeout", "cancelled", "memory", "limit"]`, but not every value
is currently ever constructed — this table is what the two runner
implementations actually produce today:

| `kind` | when it's actually raised |
|---|---|
| `"syntax"` | Compiling the snippet unit (`<snippet>` — the facade is its own unit, see above) raises `SyntaxError` — the snippet doesn't parse. |
| `"runtime"` | Any other unhandled exception during `exec`/entry-call, including a `dr.BridgeError`/`dr.ReadOnlyError`/`dr.NotFoundError`/`dr.CardinalityError` raised by facade code, and (WASM only) a nonzero guest exit whose stderr doesn't mention `MemoryError`. |
| `"timeout"` | (WASM only) the epoch kill trips (`Trap.trap_code == TrapCode.INTERRUPT`) or the host's wall-bounded read hits its deadline with no final message. |
| `"memory"` | (WASM only) a nonzero guest exit whose stderr contains `MemoryError`, or a non-`INTERRUPT` `Trap` (the portability path for wasmtime builds that trap-on-allocation instead of raising `MemoryError` guest-side). |
| `"cancelled"` | **Not currently produced by either runner.** `POST /snippets/cancel`'s abort hook (`_noop_cancel` in `routes/snippets.py`) is a documented no-op in M1 — a "cancelled" run still only terminates via `wall_timeout_s`, surfacing as `"timeout"`. |
| `"limit"` | **Not currently produced by either runner.** An op-count/byte-cap breach raises `BridgeLimitError` inside `bridge.py`, which `BridgeDispatcher.dispatch` maps to a generic error string; the facade's `_raise_for_error` doesn't recognize that prefix, so it re-raises as a plain `dr.BridgeError` in guest code — which is then caught by the outer handler and reported as `kind="runtime"`. |

## Bridge wire contract (brief)

The guest talks to the host over newline-JSON: one line in is one request
dict, one line out is one response dict echoing the same `"id"`. The
request's `"op"` field is polymorphic — a `str` selects a fixed read op
(`element`, `elements_page`, `outgoing`, `incoming`, `parent`, `children`,
`descendants`) with extra params read from sibling keys; a `dict` *is*
an `OpIn`-shaped write payload, i.e. an implicit `record_op` call. This is
not incidental — see `bridge.py`'s module docstring for why (JSON can't
carry two values under one repeated key, so there's no separate "op name"
for writes). `bridge.py`'s module docstring is the authoritative source for
this contract, including the exact read-op parameter/response shapes and the
`BridgeDispatcher` construction knobs (`record_ops`, `max_ops`,
`max_op_bytes`, `page_limit`).

## Evaluation sessions (M2/M3)

Table columns (`ScriptColumn`) and navigation steps (`ScriptStep`) call a
snippet's entry point once per row/hop against the live model, but unlike a
console run (`ScriptRunner.run` — one fresh guest instance per invocation)
that would mean booting a WASM interpreter and re-`exec`ing the whole
snippet module for every cell. `ScriptRunner.open_session` instead opens one
**warm session per distinct column/step code**: the guest execs the facade +
snippet module exactly once, then serves as many entry-point calls as the
caller needs on that same live instance, so module-level state (imports,
top-level computation) persists across calls the way it would in a normal
long-lived interpreter — see the determinism caveat below for the one place
that persistence bites.

A `ScriptStep`'s cycle guard (`core/navigation/evaluate.py`) drops an id
already visited earlier in the chain exactly like a relationship hop's
revisit — but, unlike a relationship hop where a revisit is expected
navigation semantics, it also emits `script step: N element(s) dropped
(already visited in this chain)`, since the natural `def step(el): return
[el]` idiom returns an already-visited id and would otherwise disappear into
an empty result with no signal at all.

**The `SnippetSession` protocol** (`core/script/runner.py`) is the
sandbox-agnostic session handle: `boot_error: ScriptError | None` (set if the
facade+module `exec` itself failed at open, or set LATER if the guest dies
mid-session — either way every subsequent call must report that same
error), `call(entry, element_ids) -> CallResult`, and an idempotent
`close()` ("discards the underlying instance (never pooled again)").
`CallResult.value` is the already-validated tagged wire payload (never a
repr string); it is `None` iff `.error` is set.

**`mode: "embedded"` start message.** `_WasmSnippetSession.__init__`
(`api/script_runner.py`) pops a warm pool instance and sends ONE start
message shaped like a normal run's (`code`, `facade_source`, `stdout_bytes`,
`result_repr_bytes`) plus `"mode": "embedded"`. The guest bootstrap
(`_GUEST_BOOTSTRAP_SOURCE`) branches on that field: `"embedded"` runs
`_run_embedded` instead of the one-shot `_run_once` console runs use.
`_run_embedded` execs `FACADE_SOURCE` then `code` once (separate units,
see above), emits a boot ack
(`{"boot": true, "error": ...}`), and — if the exec didn't raise — enters a
call loop reading newline-JSON frames from the host:

- `{"call": {"entry": "value"|"step", "element_ids": [...], "elements":
  [<projection>, ...]}}` — the additive `"elements"` field is the root
  piggyback (trip-collapse): the host projects each bound root it can still
  find in the live model (`bridge.py`'s `project_roots`) and ships those
  projections alongside the ids, so a property-math cell that never
  navigates past its bound element(s) costs zero bridge round trips. An id
  the host could not project (e.g. a benign race — the root was deleted
  between binding the call and running it) is simply ABSENT from
  `"elements"`, never a `None` placeholder; the guest's own fetch for that
  id then goes to the bridge and raises the same `NotFoundError` a direct
  fetch always produced. The whole per-call sequence — priming the read
  memo from `"elements"`, resolving the named entry function, fetching any
  remaining `Element`s by id, invoking it (`value` gets the whole list;
  `step` gets the single bound element), and serializing the result via
  `_dr_serialize_entry_result` — is driven by ONE guest-side function,
  `facade_src.py`'s `_dr_call_entry`, called by BOTH hosts (the WASM
  bootstrap loop above and `tests/script/trusted_runner.py`'s
  `_TrustedSession`) so per-call semantics live in exactly one place and the
  two hosts cannot drift. `_dr_call_entry` returns `{"payload", "reads"}` —
  the guest replies with `{"call_result": {"payload": ..., "error": ...,
  "reads": <sorted list of [tag, id_or_null] 2-lists> | null}}`. `reads` is
  the call's recorded read-set (Phase B — see `runner.py`'s `ReadKey` and
  `CallResult.reads`), decoded host-side via `decode_reads`; `null` means
  "depends on everything" (recording overflowed, or the call errored).
  `print()` output during the call is still captured
  through the same size-capped `_CappedStdout` console runs use, but the
  buffer is never included in `call_result` — **embedded calls' stdout is
  captured and discarded**, by design; only the tagged wire payload, the
  read-set, and, in a future write-enabled mode, recorded ops (sessions are
  read-only in M2/M3, see below) reach the caller.
- `{"close": true}` — the loop returns, ending the guest's `_start`; the host
  then tears the instance down (never pooled again, same lifecycle as a
  console run's single-use instance).

**Tagged return-value wire shapes.** The guest-side encoder
(`facade_src.py`'s `_dr_serialize_entry_result`) and the host-side untrusted-
payload validator (`runner.py`'s `decode_call_payload`) are written to agree
on the same tags and the same scalar set *by construction* — one changes,
the other must change with it:

| entry | shape |
|---|---|
| `step` | `{"ids": [str, ...]}` — `step()` may return `None` (→ `[]`, ending the chain), a single `Element`, a single element-id `str`, or an iterable of `Element`s and/or raw id strings; anything else raises, guest-side, `ValueError("step() must return an Element, an element id, an iterable of those, or None (None ends the chain); got <TypeName>")`, which surfaces as a `"runtime"` `CallResult.error`. The single-value cases are checked before generic iteration: a bare `Element` would otherwise be "iterated" via its `__getitem__` (`KeyError: 0`), and a bare id string would be iterated per character. |
| `value`, scalar | `{"kind": "scalar", "value": None \| str \| int \| float \| bool}` |
| `value`, list of scalars | `{"kind": "scalars", "values": [...]}` |
| `value`, single `Element` | `{"kind": "element", "id": str}` |
| `value`, list of `Element`s | `{"kind": "elements", "ids": [str, ...]}` |

`decode_call_payload` re-validates every field's shape on the host — the
guest is untrusted input, same stance as every other bridge response — and
returns `(None, error message)` on anything that doesn't match one of the
rows above; that path surfaces as a plain `"runtime"` `CallResult.error`,
not a host-side crash.

**Read-only stance.** `WasmScriptRunner.open_session` always builds its
`BridgeDispatcher` with `record_ops=False` — embedded sessions are read-only
by construction, not by caller choice (`open_session` has no `record_ops`
parameter at all). Any `dr.create`/`connect`/`disconnect`/`Element.set`/
`Element.delete` call inside a `value`/`step` snippet raises
`dr.ReadOnlyError` in the guest, exactly like a console `"value"`/`"step"`
run (see "The read-only / dry-run stance" above) — the entry-point calling
convention is otherwise identical between a console run and a session call,
just invoked once per run there vs. repeatedly per warm session here.

**`ScriptEvalContext`** (`core/script/embed.py`) is the per-request state
that ties embedded evaluation together: one instance is built per top-level
evaluate/export request and threaded through everything that request
transitively triggers — a script step inside a navigation used by a table
column shares the SAME context as the table's own script columns, not a
fresh one.

- **Sessions keyed by code** — two columns/steps carrying byte-identical
  code share one guest instance, opened lazily on the first `.call()` that
  needs it; all sessions are closed together by `.close()`.
- **Calls memoized by `(code, entry, element_ids)`** — `.call()` checks its
  memo before dispatching to a session, so sorting a table by a script
  column and then rendering the page calls `value()` at most once per
  distinct binding, and identical bindings across rows dedupe for free.
  This is sound under the WASM determinism guarantee (same code + same
  model ⇒ same output — see "Determinism guarantees" above) — but an entry
  point that mutates **module-level globals** across calls (e.g. a counter
  it bumps on every invocation) falls outside that soundness assumption:
  the memo has no notion of call order, so a second identical binding
  returns the FIRST call's cached result rather than re-running against the
  now-mutated module state. This is not detected or warned about — it is a
  documented caveat for snippet authors, not a bug the context guards
  against.
- **Build lookup indexes at module top level, never lazily.** A read-set
  capture pass (`facade_src.py`'s `_note_read`, threaded into
  `CallResult.reads`) records which parts of the model each call USES, so a
  later commit can evict only the table cells that read something it
  changed. Reads made while the snippet MODULE executes (e.g. `_index = {e.id:
  e.name for e in dr.elements(stereotypes="Building")}` at top level) are charged to
  every call against that session, which is correct and exactly what you
  want. But if the same index is built LAZILY inside `value`/`step` (`if
  _index is None: _index = {...}`), only the FIRST call that happens to
  trigger the build performs — and therefore records — those reads; every
  later call hits the already-built global directly and reports nothing for
  it, even though its result still depends on it just as much as the first
  call's did. Those later cells will NOT be evicted when the underlying data
  changes and will silently serve stale values. The same trap catches a
  generator merely created at module level but advanced (`next()`'d) inside a
  call. This cannot be fixed without making every later call in the session
  inherit every earlier call's reads, which degrades back to clear-all
  invalidation and defeats the point — so the fix has to be author discipline:
  build your indexes at real module top level, not behind an `if _x is None`
  guard.
- **`.warnings` / `.add_warning(message)`** — deduped by exact message
  text, capped at `MAX_SCRIPT_WARNINGS` (20); the table/nav evaluation
  layers use this to report prune/degrade decisions without flooding the
  response.
- **`.errored`** — flips `True` the first time any `.call()` in the
  context's lifetime returns a `CallResult` with `.error` set. Callers (the
  table route's row-order cache) use this as a cache-poisoning guard: an
  order built while ANY script call in the request failed (or while the
  model moved mid-build) must never be cached under a fingerprint/rev pair
  that won't change on retry — see `routes/tables.py`'s comment at the
  `TableOrderCache.put` call site.
- **Degradation, not failure** — if the context was built with no runner
  (`unavailable_reason` set explicitly, or defaulted to `"script runner
  unavailable"`) or the shared budget is exhausted, `.call()` never touches
  a session at all: it synthesizes a `CallResult` whose `ScriptError.kind`
  is `"unavailable"` or `"timeout"` respectively. Route-layer glue for the
  runner-missing / no-concurrency-slot cases lives in `api/script_eval.py`'s
  `open_script_context`/`close_script_context`.
- **`.close()`** — closes every session opened during the request
  (route-level `finally`); a session is never reused across requests, even
  identical ones.

**Per-call deadline.** Every `SnippetSession.call` (and session boot) arms
the guest's epoch deadline to `min(limits.wall_timeout_s, budget.
remaining())`. Both the per-call wall-timeout cap AND the whole-request
`ScriptBudget` (`settings.snippet_eval_budget_s`, a single `time.
monotonic()` deadline shared by every session the context opens) bound each
call — a column that burns most of the budget leaves later columns/steps in
the same request a shrinking window rather than each getting a fresh
`wall_timeout_s`.

### Trip collapse (Phase A', spec 2026-07-21)

Embedded sessions minimize guest<->host round trips three ways, all invisible
to snippet authors: (1) the facade memoizes bridge reads for the session's
lifetime (`_memo`, capped at `snippet_read_memo_max` entries; sound because a
session's results are rev-stamped and rejected if the rev moved under them —
see `RunLimits.read_memo_max`; an unstamped console run can observe a torn
read with or without the memo); (2) `outgoing`/`incoming` responses inline
the far endpoints' projections under an additive `elements` key, priming
that memo (see the bridge wire contract above); (3) each embedded call ships
its bound root elements' projections in the call frame's own `elements`
field (the root piggyback described above under the `mode: "embedded"` start
message), so a property-math cell that never navigates past its bound
element(s) makes zero bridge round trips. Every path that hands memo-derived
data to a snippet goes through `facade_src.py`'s `_copy_projection`, which
copies the projection dict, its `properties` dict, and any list/dict-valued
property within it — so a snippet that mutates what it gets back (e.g.
`el.outgoing()[0]["tags"].append(...)`) can never reach into
`_memo` and corrupt a later call's result. Only genuinely immutable scalars
(`str`/`int`/`float`/`bool`/`None`) are ever shared between a memo entry and
what a snippet holds — see the invariant comment above `_memo` in
`facade_src.py` and the regression test
`test_memoized_element_does_not_alias_list_valued_property`.

### Incremental invalidation (Phase B, spec 2026-07-21)

Each embedded call records the read-keys it USED — memo hits and piggybacked
roots included, via `facade_src.py`'s `_note_read` threaded into
`_dr_call_entry` (see above) — and ships them on `call_result`
(`CallResult.reads`; `None` means "depends on everything" and is always
evicted, e.g. an errored call or a read-set that overflowed `_READS_CAP`/
`_MAX_READS`). On the op-delta commit paths (`/model/ops`, `/model/undo`,
`/commits`), `api/invalidation.touched_keys` translates the applied batch
into the same `ReadKey` vocabulary and `ScriptCellCache.evict_touched` drops
only intersecting cells, re-stamping survivors to the new rev — one edit no
longer recomputes a 3k-row table. Paths with no op delta (`touch_model`,
uploads, hydration, metamodel swap, every rollback) keep clear-all — the
same safe default the cell cache already used everywhere before this phase.
Escape hatch: `DATA_ROVER_SNIPPET_INCREMENTAL_INVALIDATION=false`. See
"Build lookup indexes at module top level, never lazily" above for the one
way a snippet author can make this optimization observe a stale value
despite `touched_keys` being correct — the read-set capture itself, not the
commit-side translation, is the thing that misses a dependency in that case.

**The tag vocabulary is fixed and did not follow the facade's rename.** A
read key is a `(tag, id_or_None)` pair; the tags are `"scan"`, `"el"`,
`"out"`, `"in"`, `"children"`, `"parent"` — in particular `el.outgoing()`
records `"out"` and `el.incoming()` records `"in"`, deliberately keeping the
short spellings `api/invalidation.py`'s `touched_keys` emits even though the
method and memo/op names are now the longer `outgoing`/`incoming`. Renaming
either half silently breaks incremental invalidation. Two rules worth
knowing:

- **A scan records one `("scan", name)` per REQUESTED stereotype name** —
  not one per expanded subtype, and never the list object itself. This is
  sound only because the commit side pulls the other half of the weight:
  `api/invalidation.py`'s `touched_keys` emits a changed element's type
  **plus its ancestors**, so a scan cell recorded against a supertype name
  still gets evicted when a subtype element changes, without the guest ever
  having to record one key per expanded subtype. An unfiltered
  `dr.elements()` records the distinct `("scan", None)` key, which
  `touched_keys` treats as "depends on every stereotype". `_note_read` fires
  once per call, before the paging loop, however many pages the scan takes.
- **`descendants` records nothing at all.** The stereotype-closure lookup
  behind a hop filter is deliberately untagged: the metamodel is immutable
  for a session's lifetime (a swap goes through session replacement /
  clear-all), so a cached cell can never observe a stale descendant set and
  recording it would only add a dependency nothing can ever touch.

**Author note: `other_stereotype=` inflates the read-set.** To decide
whether a candidate relationship matches, the filter must fetch each far
endpoint, and every one of those fetches records an `("el", far_id)` read —
memo hit or not, and including the candidates the filter then REJECTS. A hop
with `other_stereotype=` therefore makes the cell depend on every candidate
neighbor (every one surviving the `stereotype=` filter, or all of them when
there is none), not just the ones it kept, so an edit to any of them evicts it.
That is correct (the result genuinely did depend on those stereotypes), but
it makes such cells noticeably more eviction-prone than the equivalent
`stereotype=`-only hop, which touches no far endpoints. Prefer filtering on
the relationship stereotype when it is selective enough.

### Cell cache + background sweep (whole-table work)

A warm session makes one cell cheap (~0.5 ms round trip), but a table has as
many cells as it has rows: evaluating 3,000 of them inline took ~49 s and
froze the UI for the whole of it. The fix is not a faster cell — it is that
**no request ever computes a whole table**. A request serves what is already
cached and returns; a background job computes the rest; the client polls.

**`ScriptCellCache`** (`core/script/cell_cache.py`) is the per-`Session` store
that makes this possible.

- **Key** — `(sha256(code).hexdigest(), entry, tuple(element_ids))`. The code
  is hashed so keys stay small (`ScriptEvalContext` hashes each distinct code
  once per request). Nothing about the table definition, the sort, or the row
  is in the key: a cell is a pure function of *what snippet ran against which
  elements*, which is exactly why one sweep can serve every consumer (below).
- **Rev stamping, not rev-in-key** — the cache carries one `_stamp` (a model
  rev) instead of putting the rev in every key. `Session.touch_model`/
  `set_model` call `clear_and_stamp(new_rev)`; a `get`/`put` at any *other* rev
  is a miss/no-op. This is the same sampled-rev poisoning guard the table
  order cache uses: evaluation runs outside any lock, so a request that
  computed against a since-superseded model must never write into the fresh
  cache (a lost race merely recomputes).
- **Self-stamping** — a `put` at a rev NEWER than the stamp clears and
  re-stamps rather than being rejected. Some paths advance `model_rev` without
  running the invalidation hooks (hydration assigning the DB-authoritative
  rev, most notably); without self-stamping the cache would silently refuse
  every write until the next commit.
- **Which errors are cached: `runtime` and `syntax`, and nothing else.** Those
  two are DETERMINISTIC — the same code against the same model reproduces them
  exactly, so recomputing is pure waste and caching them is what stops a
  broken snippet from being re-run for every row. Every other kind
  (`timeout`, `unavailable`, `memory`, `cancelled`, and the synthetic
  `pending`) is environmental: it says something about the machine or the
  caller, not the snippet, and must stay retryable. `put()` enforces this
  itself, so no caller can poison the cache with a transient failure.

**Cache-only mode and the `pending` kind.** `ScriptEvalContext(cache_only=...)`
(also flippable per phase as an instance attribute, or overridden per call)
turns a cache miss into a synthesized `CallResult` with
`ScriptError(kind="pending")` instead of invoking the guest. `pending` is a
first-class degradation, not an error:

- it does **not** set `.errored` (the row-order cache-poisoning guard must not
  trip merely because the table is still computing);
- it is **never memoized** and **never written to the cell cache**, so the same
  context can serve a live window call for a cell that a preceding cache-only
  whole-table pass already reported pending;
- the table layer renders it as a `PendingCell` (wire `kind: "pending"`), a
  placeholder, not an error cell.

`ScriptEvalContext.pending_misses` counts them, and that counter — not
`.errored` — is what the routes branch on. `should_abort` (an optional
zero-arg predicate consulted before any guest work) is the sibling mechanism:
an aborted call returns `kind="cancelled"`, which is likewise uncached,
unmemoized, and not an error.

**`SweepJob` / `ScriptSweepRegistry`** (`api/script_sweep.py`) is the
background half. One job computes every script cell of ONE resolved table
definition at ONE model rev, writing into that session's `ScriptCellCache`.

- **The job key excludes the sort.** The fingerprint is
  `table_fingerprint(dumped_definition, None)` on purpose: `_sort_value` calls
  the same `(code, "value", ids)` keys that cell rendering does, so ONE sweep
  serves every sort order of that table, the `keep_empty` filter, cell
  rendering, and export. Adding the sort would multiply the guest work by the
  number of sort orders the user tries for zero benefit.
- **Four states.** `running` → `done` | `failed` | `cancelled`. `cancelled` is
  deliberately distinct from `failed`: it means no pathology occurred (the rev
  moved, or the session was evicted), which a client-facing status wants to be
  able to tell apart. **Every** exit from the run loop must leave a TERMINAL
  state — a job left `running` behind a dead thread strands a polling client
  forever, because of:
- **Failed-job memory.** `kick()` returns an existing same-rev job **as-is,
  whatever its state** — running, done, or failed. Only a rev change creates a
  new job. This exists because timeouts are deliberately not cached: without
  it, the next poll would restart the exact grind that just aborted, forever.
  `touch_model`/`set_model` cancel-and-clear the registry, so the next commit
  retries naturally. (If `start` raises — thread exhaustion — the freshly
  registered job is removed before the exception propagates, so a threadless
  "running" zombie is never remembered.)
- **Two pathology guards**, both counted JOB-GLOBALLY across workers (per-worker
  counters would let a bad table burn `workers × threshold` guest calls), both
  reset by any other outcome, both thresholded on
  `snippet_sweep_timeout_abort`:
  - *consecutive `timeout`* — timeouts are never cached, so a snippet that
    keeps timing out would otherwise be re-run for every remaining cell.
  - *consecutive `unavailable`* — **this one is load-bearing, not symmetry.**
    `unavailable` (no runner, or an exhausted warm pool) is also never cached,
    so without the guard a sweep against a busy/absent runner grinds every
    cell, caches NOTHING, and still ends `state="done"` — a "success"
    indistinguishable from a real one. Since `kick()` hands a same-rev `done`
    job back forever, nothing would ever re-kick and the table would render
    pending for the rest of the rev.
- **Ceiling.** The job runs under a `ScriptBudget.start(snippet_sweep_ceiling_s)`;
  exhausting it fails the job with a `sweep ceiling (Ns) exceeded` message.
- **Cancellation.** `job.cancel` is set by the session invalidation hooks and
  by eviction. The run loop checks it between cells, AND the job's
  `ScriptEvalContext`s are built with `should_abort=job.cancel.is_set` so a
  cancelled job also stops mid-row-build — otherwise an evicted session's
  ~80 MB model stays reachable from a sweep thread until the ceiling.
- **Concurrency.** A per-session `run_lock` gives one active sweep per session
  (a queued job blocks its own daemon thread, a natural FIFO); a lazily-sized
  process-wide semaphore bounds concurrently running jobs across ALL sessions,
  so N open projects cannot mean N × workers guest instances.

**Sharding.** The row BUILD stays serial — it may itself call the guest to
resolve expand or script-as-source columns, and every later stage depends on
its output — but the per-cell work after it is fanned out over up to
`snippet_sweep_workers` threads, each driving its OWN `ScriptEvalContext` and
therefore its own guest instances — one per distinct snippet code it touches
(see the pool-sizing caveat below). Results are identical to serial execution:
a cell's value is a pure function of (code, model, element ids), the cell
cache is internally locked, and the pathology counters are job-global.

> **DON'T rely on module-global state inside a snippet.** Mutating a module
> global between `value()` calls was already outside the determinism guarantee
> (see the memo caveat above), but sharding makes it reachable in a NEW way:
> two cells of the same table can now land on different guest instances, so
> "accumulate into a global across cells" no longer even sees a single
> interpreter. Snippet entry points must be pure functions of their arguments.

**Route contracts** (`api/routes/tables.py`) — the client-visible half:

- `POST /tables/evaluate` runs its whole-table passes (`build_rows_ex` +
  `order_rows`) CACHE-ONLY and evaluates only the visible window live. If
  anything went pending it degrades to BUILD order (a sort over half-pending
  values would visibly reshuffle on every poll) and kicks/joins the sweep.
- **A sort that would need an UNCOVERED navigation `ScriptStep` falls back
  instead of pending.** The sweep never calls `order_rows`, so a `step()` cell
  that ONLY the sort wants is filled by nothing, ever. Driving the context for
  it under cache-only produced one `pending` per off-window row, a page
  permanently degraded to build order, and `script_status: failed` for the life
  of the rev behind a once-a-second poll loop. `core/table/evaluate.py`'s
  `_sort_script` therefore hands the sort pass a `None` context for exactly
  that case, so the step prunes silently, every row ties, and the rows stay in
  build order — with `SORT_SCRIPT_NAV_WARNING` on the response so the user is
  told. The decision is taken ONCE per `order_rows` call (it depends only on
  the definition, the sort column, and `cache_only`), and the LIVE path never
  enters the branch at all.
  - **What counts as COVERED** — a collapse `ScriptColumn` is a *sweep-covered
    boundary*, so the walk (`_sort_reaches_script_navigation` /
    `_source_reaches_script_navigation`) stops at one rather than recursing
    through its source. `script_sweep._run_inner` resolves every collapse
    script column's `source` LIVE, once per built row, to enumerate its
    `value()` work — and that resolution drives and caches every navigation
    `step()` underneath it. So `[nav column with a script step, script column
    sourced from it]` sorted on the script column pends once and converges on
    the next poll; degrading it would tie every row forever AND never kick a
    sweep at all (a degrade records no pending miss). Sorting by an
    ELEMENT/PROPERTY column sourced from that same navigation column has no
    such backstop and does degrade.
  - **The warning survives the order cache.** A degraded order records no
    pending miss, so `TableOrderCache` stores it and later requests skip
    `order_rows` entirely. `evaluate_table` therefore re-derives the warning on
    the cache-hit path from the public, context-free
    `sort_falls_back_to_build_order(defn, sort)` — otherwise only the one
    request per rev that built the order would ever explain itself.
- `script_status` (`ScriptStatusOut`) is `null` for a table with no script
  column at all; otherwise `ready` (nothing pending — these rows are final for
  this rev, though a cell may still hold an `unavailable`/error value, since
  retrying that is the client's decision), `computing` (a sweep is filling the
  cache — these rows are degraded, poll again), or `failed` (dead work,
  `message` says why; both `failed` and `cancelled` jobs collapse here,
  because no thread is behind either). **A response that saw a pending cell
  can never report `ready`** — `_status_from_job` has no `ready` branch at all,
  and the status is finalized after the window pass on every branch (including
  an order-cache hit) so this holds universally. A sweep that finished
  *during* the very request that kicked it still reports `computing`: the rows
  in hand predate it, and one more poll returns the clean page. The
  computing-vs-failed call for a TERMINAL job is made exactly like the export
  route's ship-vs-retry one — by RE-PROBING the cache ("would a retry actually
  help"), never by the job's state alone: a dead job whose values landed anyway
  reports `computing` (the retry really will deliver), while a job that ended
  `done` with holes still in the cache reports `failed`, because failed-job
  memory hands that same job back at this rev forever and the page would
  otherwise stay stuck in build order behind an endless once-a-second poll.
- `POST /tables/export` must touch every row, so it runs entirely cache-only
  and probes for completeness first (a full cache-only render pass — a plain
  collapse display column is invisible to build/order, so judging completeness
  from those alone would ship a workbook full of silent `#ERROR`s). If
  anything is still uncomputed it kicks/joins the sweep and answers **`202`
  with `Retry-After: 1`** and a `ScriptStatusOut` body instead of a workbook.
  **The STATUS CODE is the retry signal, not the body's `state`** — a 202 body
  routinely carries `state: "computing"` for a job that has already finished,
  and the ship-vs-retry decision is made by RE-PROBING the cache after the
  kick ("would a retry actually help"), not by the job's state. When a retry
  would not help (a terminal sweep that still left holes, or no runner at all)
  the file ships with pending cells as `#ERROR`, flagged by
  `X-Table-Script-Errors` and a trailing notice row.

**Sweep + cache settings** (`api/settings.py`, all `DATA_ROVER_`-prefixed):

| setting | default | meaning |
|---|---|---|
| `snippet_cell_cache_max` | `50_000` | LRU cap on `ScriptCellCache` entries per session. |
| `snippet_sweep_workers` | `4` | Threads a sweep fans its cell work across, AND the size of the process-wide semaphore bounding concurrently running sweep jobs. |
| `snippet_sweep_ceiling_s` | `600.0` | Per-sweep wall ceiling; the job's `ScriptBudget`. Exhausting it fails the job. |
| `snippet_sweep_timeout_abort` | `3` | Consecutive-`timeout` **and** consecutive-`unavailable` abort threshold (job-global). |
| `snippet_sweep_sync` | `False` | Run each sweep inline inside `kick_or_join_sweep` instead of on a daemon thread. **Tests only** — it makes a sweep complete deterministically within the calling test. |

**Pool sizing caveat.** `snippet_pool_size` (6) is nominally sized for this: 4
sweep workers + 2 interactive headroom. That arithmetic is only right for a
table with ONE distinct snippet. `ScriptEvalContext._sessions` is a
`dict[code, SnippetSession]` (`embed.py`), so a worker holds one live guest
session per distinct column/step code it has touched, and does not release any
of them until the context closes. The real demand is therefore

    snippet_sweep_workers × (distinct script codes in the table)

Exceed the pool and `open_session` finds it exhausted, so those cells come back
`unavailable`. That is not benign here: the sweep's consecutive-`unavailable`
guard (`snippet_sweep_timeout_abort`, 3) then FAILS the whole job, and the
failed job stays in the sweep registry — blocking retry until the next commit
re-keys it, with the table stuck reporting `failed` in the meantime. Concretely,
a table with 3 distinct snippets at `workers=4` wants 12 instances against the
default pool of 6, so roughly half the cells miss and the sweep dies. Size the
pool for the widest table you expect (`workers × distinct codes`, plus
interactive headroom), or lower `snippet_sweep_workers` to match the pool.

Coverage: `tests/api/test_script_sweep.py` and
`tests/api/test_tables_script_status.py` (fakes, default suite),
`tests/api/test_script_sweep_wasm.py` (`-m integration`, real guest,
end-to-end settle + sharding determinism), `tests/api/test_script_sweep_perf.py`
(`-m perf`, per-call round-trip budget + parallel speedup floor).
