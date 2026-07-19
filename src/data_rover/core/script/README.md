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
own source (in a fresh namespace with `_transport` already bound; see
"Bridge wire contract" below). Both the WASM guest and `TrustedRunner` `exec`
the *same* string, so the surface below is exactly what a snippet author gets
in either environment.

Module-level exceptions (all subclass `dr.BridgeError`, itself
`Exception`):

- `dr.BridgeError` — generic/unclassified error from a bridge response's
  `"error"` field that doesn't match a more specific case below.
- `dr.ReadOnlyError(dr.BridgeError)` — raised when `record_op` is attempted
  against a dispatcher built with `record_ops=False` (a `"value"`/`"step"`
  run — see "Read-only / dry-run stance").
- `dr.NotFoundError(dr.BridgeError)` — raised when a requested element/
  relationship id does not exist (bridge response `"error"` starts with
  `"KeyError"`).

Top-level functions/attributes on `dr`:

| call | semantics |
|---|---|
| `dr.element(element_id) -> Element` | Fetch one element by id. Raises `dr.NotFoundError` if it doesn't exist. |
| `dr.elements(type=None) -> Iterator[Element]` | Lazily iterate all elements, optionally filtered to a type and its subtypes (`type_name` passed through `Metamodel.element_descendants`). Pages transparently in batches of `page_limit` (default 500; see limits table) via the bridge's `elements_page` op — a snippet never sees pagination. |
| `dr.types() -> list[str]` | All element type names in the metamodel. |
| `dr.type(name) -> dict` | `{"type": name, "properties": [{"name", "datatype", "multiplicity"}, ...]}` — the type's effective (inherited) properties. Raises `dr.NotFoundError` for an unknown type. |
| `dr.create(type_name, properties=None) -> str` | Records a `create_element` op (dry-run — see below) and returns a client-side temp id (`"tmp_1"`, `"tmp_2"`, ...) usable as a `source_id`/`target_id` in a later `dr.connect()` call within the same run. |
| `dr.connect(type_name, source_id, target_id, properties=None) -> str` | Records a `create_relationship` op; returns a temp id the same way. |
| `dr.disconnect(rel_id)` | Records a `delete_relationship` op. Returns `None`. |

`Element` (returned by `dr.element`, `dr.elements`, `Element.parent`,
`Element.children`; `__slots__ = ("_data",)`, wraps the bridge's plain
`{"id", "type", "name", "properties"}` projection):

| member | semantics |
|---|---|
| `.id` / `.type` / `.name` | The element's id, type name, and `properties.get("name")` (may be `None`). |
| `el[key]` | `properties[key]` — raises a plain (not `dr.`) `KeyError` if the property is absent, since this reads the already-fetched local dict, not a fresh bridge call. |
| `el.get(key, default=None)` | `properties.get(key, default)`. |
| `el.props() -> dict` | A shallow copy of the full property bag. |
| `el.out() -> list[dict]` | Outgoing relationships as plain dicts (`id`/`type`/`name`/`properties`/`source_id`/`target_id`) — **not** wrapped in a facade class, sorted by relationship id host-side. One bridge round trip. |
| `el.in_() -> list[dict]` | Incoming relationships, same shape. (Named `in_` — `in` is a keyword.) |
| `el.parent() -> Element | None` | The containing element, or `None` at a containment root. |
| `el.children() -> list[Element]` | Elements reached via this element's own outgoing containment relationships (derived host-side from `metamodel.is_containment`, not a dedicated model index). |
| `el.set(key, value)` | Records an `update_element` op with `properties_patch={key: value}`. Dry-run — see below. |
| `el.delete()` | Records a `delete_element` op. Dry-run — see below. |

## The read-only / dry-run stance

Every `dr` **read** (`element`, `elements`, `types`, `type`, `Element.out`/
`in_`/`parent`/`children`) is answered by `BridgeDispatcher` calling only
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
one argument is the list.

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

Settings that shape the *runner*, not a per-run `RunLimits` value:
`snippet_runner` (`"wasm"` default, or `"trusted"` — gated by the RCE
tripwire, see below), `snippet_guest_wasm_path`/`snippet_guest_lib_path`
(vendor binary/stdlib paths), `snippet_pool_size` (default `2` warm guest
instances), `snippet_concurrency`/`snippet_per_user_concurrency` (default
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
| `"syntax"` | `compile(facade_source + "\n" + code, ...)` raises `SyntaxError` — the snippet doesn't parse. |
| `"runtime"` | Any other unhandled exception during `exec`/entry-call, including a `dr.BridgeError`/`dr.ReadOnlyError`/`dr.NotFoundError` raised by facade code, and (WASM only) a nonzero guest exit whose stderr doesn't mention `MemoryError`. |
| `"timeout"` | (WASM only) the epoch kill trips (`Trap.trap_code == TrapCode.INTERRUPT`) or the host's wall-bounded read hits its deadline with no final message. |
| `"memory"` | (WASM only) a nonzero guest exit whose stderr contains `MemoryError`, or a non-`INTERRUPT` `Trap` (the portability path for wasmtime builds that trap-on-allocation instead of raising `MemoryError` guest-side). |
| `"cancelled"` | **Not currently produced by either runner.** `POST /snippets/cancel`'s abort hook (`_noop_cancel` in `routes/snippets.py`) is a documented no-op in M1 — a "cancelled" run still only terminates via `wall_timeout_s`, surfacing as `"timeout"`. |
| `"limit"` | **Not currently produced by either runner.** An op-count/byte-cap breach raises `BridgeLimitError` inside `bridge.py`, which `BridgeDispatcher.dispatch` maps to a generic error string; the facade's `_raise_for_error` doesn't recognize that prefix, so it re-raises as a plain `dr.BridgeError` in guest code — which is then caught by the outer handler and reported as `kind="runtime"`. |

## Bridge wire contract (brief)

The guest talks to the host over newline-JSON: one line in is one request
dict, one line out is one response dict echoing the same `"id"`. The
request's `"op"` field is polymorphic — a `str` selects a fixed read op
(`element`, `elements_page`, `outgoing`, `incoming`, `parent`, `children`,
`types`, `type_info`) with extra params read from sibling keys; a `dict` *is*
an `OpIn`-shaped write payload, i.e. an implicit `record_op` call. This is
not incidental — see `bridge.py`'s module docstring for why (JSON can't
carry two values under one repeated key, so there's no separate "op name"
for writes). `bridge.py`'s module docstring is the authoritative source for
this contract, including the exact read-op parameter/response shapes and the
`BridgeDispatcher` construction knobs (`record_ops`, `max_ops`,
`max_op_bytes`, `page_limit`).
