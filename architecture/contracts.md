# Contracts

Formats and interfaces shared by more than one sub-project. Normative. A sub-project spec
fills in detail; it does not redefine anything here.

Entity shapes are today's, unchanged (`src/data_rover/api/serialize.py`):

```
element       {"id", "type_name", "properties", "rev"}
relationship  {"id", "type_name", "source_id", "target_id", "properties", "rev"}
```

`rev` on an entity is its own monotonic change counter; `rev` on a project is `model_rev`.

## CT-1 · Snapshot — `datarover.snapshot/v2`

- One gzip member, UTF-8, one compact JSON object per line (`separators=(",", ":")`,
  `ensure_ascii=False`, `allow_nan=False`). Every line, the last included, ends with LF. A
  writer escapes every control character, so LF never occurs inside a line; a reader MUST
  split on LF alone (U+2028 and U+2029 occur raw).
- Line 1 is the header, its keys in this order:
  `{"format":"datarover.snapshot/v2","project_id","rev","metamodel_id","elements":<count>,"relationships":<count>,"state_digest"}`.
  `format` comes first, so the inflated bytes of every v2 snapshot start with
  `{"format":"datarover.snapshot/v2"` — that prefix is how a reader tells v2 from v1, whose
  first line may be the whole document.
- Then `elements` element lines, then `relationships` relationship lines.
- **Entity order is state.** Lines are in insertion order. An entity absent from a replica is
  appended when a delta introduces it. Every replica, on every host, MUST iterate entities in
  this order; exports depend on it.
- An id is unique across elements and relationships (CT-3 folds both into one digest). The
  engine refuses a snapshot that breaks this.
- Stored as `application/gzip` and inflated by the reader (CN-11). The store key suffix is
  naming only; readers identify the format from the header line.
- `src/data_rover/api/snapshot_codec.py` stays the only server module that knows the format
  and MUST keep reading v1 (one JSON document) until sub-project F.

## CT-2 · Delta — one shape, three carriers

```
{"type":"commit","rev","prev_rev","state_digest","scope","commit_id","author_id","message",
 "validation_error_count","changed_elements","changed_relationships",
 "deleted_element_ids","deleted_relationship_ids",
 "recreated_element_ids","recreated_relationship_ids"}
```

- The feed's `commit_event`. `changed_*` hold full post-commit entities in first-touch order;
  `deleted_*` include cascade deletions; `recreated_*` name the changed ids the commit
  deleted and created again under the same id — an apply-CR rewire does that — each a new
  entity, which the server's dict holds last.
- Carriers: the feed event, the commit response (which keeps its extra fields: `id_map`,
  `changed_artifacts`, `deleted_artifact_ids`, `view_revs`, …), and the tail route.
- Tail response: `{"from_rev","head_rev","complete","deltas":[…]}`. `complete` is `false` when
  any revision in range cannot be expressed as a delta: a baseline, a commit whose
  `entity_states` is `NULL`, a metamodel rebind, or a `model_rev` bump with no journal row.
- **Apply rule.** Apply a delta iff `prev_rev == replica.rev`. If `rev <= replica.rev`, drop it
  as a duplicate. Otherwise fetch the tail from `replica.rev`; if it is incomplete,
  re-bootstrap.
- **Entities in a delta.** Apply in this order: relationships out, elements out, elements in,
  relationships in. What goes out is every `deleted_*` and every `recreated_*` id; one the
  replica does not hold is skipped (an entity created and deleted within one commit). A
  changed entity the replica holds keeps its record and its place; one it does not hold — a
  recreated one, by then — is appended. A changed entity that arrives under another type, or
  other ends, than the replica's record WITHOUT being named in `recreated_*` does not fit the
  replica, which is then diverged (AD-12).
- Artifact, view and metamodel-layout changes stay header-only on the wire; their content is
  refetched as today.

## CT-3 · State digest

- 64 bits, the XOR over every entity of `h(id, rev)`; hex on the wire. Order-independent and
  maintainable in O(batch) by XOR-ing out the old pair and XOR-ing in the new one.
- `h(id, rev)` is the first 8 bytes of SHA-256 over `utf8(id) ‖ 0x00 ‖ ascii(decimal rev)`.
  Elements and relationships share one id namespace, so one XOR covers both. The engine
  implements SHA-256 synchronously (WebCrypto is asynchronous); Python uses `hashlib`. A
  linear checksum such as CRC32 MUST NOT be used: an XOR fold of it cannot see two
  same-length ids exchanging `rev`s.
- After applying a delta the replica MUST compare digests. After opening a snapshot it checks
  the header's entity counts, adopts the header's digest, and MUST verify the digest by full
  recomputation once `ready`, in the background. A mismatch discards the replica (AD-12).

## CT-4 · Engine interface

```
request   {id, method, params}
response  {id, ok: true, result} | {id, ok: false, error: {status, detail}}
cancel    {cancel: id}
event     {event, …}                     engine → client, unsolicited
```

- Transport-agnostic: a `MessagePort` in the browser; an in-process call in the headless host
  and in tests.
- For a migrated surface, `method` names map 1:1 to the exported `lib/api` functions, and
  `params` / `result` are those functions' existing zod-validated shapes. Paging parameters
  stay.
- `error.status` reuses the HTTP vocabulary callers already branch on (404, 409, 422), so
  `errorForStatus` and the `ApiError` subclasses keep working.
- Bytes (exports, downloads, snapshots) cross as transferable `ArrayBuffer`s, never strings.
- Events: `replica {state: opening|ready|diverged}`, `progress {task, done, total}`,
  `changed {rev, staged, element_ids, relationship_ids, deleted_element_ids,
  deleted_relationship_ids}`.
- Every request is cancellable. The engine client rejects a cancelled call with an
  `AbortError`, as an aborted `fetch` does.

## CT-5 · Working copy

1. Committed state changes only by opening a snapshot or applying a delta.
2. Staged ops use the op shapes of `src/data_rover/api/schemas.py`, are applied in place, and
   each records its inverse. The engine keeps the committed state of every entity a staged op
   touched, so committed reads need no rewind. A refused batch leaves no trace, and a rewind
   is exact: every touched entity goes back to its before-image — properties, `rev` and place
   in state order — which replaying inverse ops cannot give. The server's rollback
   (`routes/ops.py::_rollback`) is the same operation, pass for pass.
3. To apply a delta: rewind all staged ops in reverse order → apply the delta → drop the staged
   ops it committed → rewrite temp ids through `id_map` → replay the rest. An op that fails
   replay is parked as a conflict and surfaced; it is never dropped silently.
4. Reads default to the working copy; `committed: true` selects committed state.
5. The working copy covers the **model** and **artifact** families — the inputs of
   evaluation. References resolve against it, staged artifacts included. View and
   metamodel staged buffers stay in the frontend.
6. Temp ids (`tmp_` prefix) never leave the client except as an op's `temp_id`. The server
   mints every real id.

## CT-6 · Script bridge

- The Python facade and its single synchronous `_transport(req) -> dict` are unchanged.
- Browser transport: the script worker posts the request and blocks on shared memory; the
  engine answers asynchronously and wakes it. Headless transport: a direct call.
- The dispatcher is a port of `src/data_rover/core/script/bridge.py` and keeps trip-collapse;
  one trip carries one batched payload. Sub-project D MAY replace JSON with a binary layout
  behind the same `_transport`.
- Scripts only propose ops; the engine never applies a script's op without the user staging it.
- Runs are deterministic on both hosts: pinned clock, pinned randomness, `PYTHONHASHSEED=0`.
- Wall timeout via the interrupt buffer; terminating the worker (browser) or the child process
  (headless) is the hard stop. The replica survives either.
- Results are cached in the engine, keyed `(code, entry, element ids, inputs digest)`, with
  read-sets; deltas and staged ops evict by read-set.

## CT-7 · Fidelity to the oracle

The engine MUST reproduce the Python core's observable behaviour. Golden fixtures, generated
by the oracle, are the test; they stay in the repo as frozen regression data after the Python
core is deleted.

| Area | Rule |
|---|---|
| Numbers | The parser MUST keep Python's `int` / `float` distinction (`1` vs `1.0`: integer conformance is `isinstance(v, int)`) and integers beyond 2^53 (value model: AD-21). Bare `Infinity` / `-Infinity` / `NaN` literals load as those strings, as `parse_model_json` does. One formatter reproduces Python's float `repr`. Equality and uniqueness signatures follow Python equality (`True == 1 == 1.0`). |
| JSON output | One serializer reproduces `json.dumps` for the settings each writer uses: `ensure_ascii=False`, `allow_nan=False`, compact separators or `indent=2`, insertion key order. |
| Strings | Compare by code point, never UTF-16 code unit. `casefold` uses a table generated from Python's `str.casefold`. |
| Regex | Patterns are Python `re` dialect: `re.fullmatch` for pattern facets, `re.search` for search criteria, an invalid pattern never matches. A translator converts them; a pattern outside its supported subset is a lint warning, never a silent difference. |
| Dates | `date` values parse exactly as `datetime.date.fromisoformat` on Python 3.14. |
| Order | No `Intl`, no locale comparison, no dependence on hash order. `Map` insertion order stands in for `dict` order. Sorts are stable. A plain object stands in for a property `dict`; it lists a canonical array-index key (`"0"`, `"42"`) first whatever the insertion order, so the engine refuses an entity carrying one at any depth of its properties. |
| Arithmetic | `+ − × ÷` and comparisons only in evaluation paths; no transcendental `Math` functions. |
| Exports | `json`, `jsonl`, `csv` and `manifest.json` match the oracle byte for byte. `xlsx` matches by cell content, and is byte-identical across the engine's two hosts. |
