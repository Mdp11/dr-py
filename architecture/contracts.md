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
- Tail response: `{"from_rev","head_rev","complete","deltas":[…]}`. `complete` is `false`, and
  `deltas` empty, when any revision in range cannot be expressed as a delta — a baseline, a
  commit whose `entity_states` or `state_digest` is missing, a metamodel rebind, a `model_rev`
  bump with no journal row — when more than 1,000 revisions separate `from_rev` from head, or
  when `from_rev` is beyond head. `head_rev` is the session's `model_rev`, the one the feed
  reports.
- **Apply rule.** Apply a delta iff `prev_rev == replica.rev`. If `rev <= replica.rev`, drop it
  as a duplicate. Otherwise fetch the tail from `replica.rev`; if it is incomplete,
  re-bootstrap.
- **Commit in flight.** From a `POST /commits` (or `/commits/revert`) to its response the shell
  holds the feed's deltas; then everything is applied in `rev` order, the response in its
  place with the user's own commit named, the echo dropping as a duplicate. A response that
  says `rebound` is no delta.
- **Entities in a delta.** Apply in this order: relationships out, elements out, elements in,
  relationships in. What goes out is every `deleted_*` and every `recreated_*` id; one the
  replica does not hold is skipped (an entity created and deleted within one commit). A
  changed entity the replica holds keeps its record and its place; one it does not hold — a
  recreated one, by then — is appended. A changed entity that arrives under another type, or
  other ends, than the replica's record WITHOUT being named in `recreated_*` does not fit the
  replica, which is then diverged (AD-12).
- Artifact, view and metamodel-layout changes stay header-only on the wire; their content is
  refetched as today.
- **Reset.** A `model_rev` bump that writes no journal row (a model or metamodel upload or
  delete, the legacy element and relationship routes) is broadcast as
  `{"type":"reset","model_rev"}`. It carries no delta, the tail across it is incomplete, and a
  replica re-bootstraps.

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
- Port hand-over. Four handshake messages over `window.postMessage`: the sandbox page posts
  `{type: 'sandbox-ready', crossOriginIsolated}` once its worker exists, and
  `{type: 'csp-violation', directive, blocked}` / `{type: 'worker-error', message}` as they
  happen, each with the app's origin as target; the shell answers `{type: 'connect'}` carrying
  ONE transferred `MessagePort`, with the sandbox's origin as target. Each side checks both
  origin and source: the shell takes a message only from the sandbox's origin and its own
  frame's window, the page a `connect` only from the app's origin, from `window.parent` and
  with exactly one port. The page accepts one `connect` per page life, hands the port to the
  worker and keeps no reference to it — from then on it is outside the data path, and every
  CT-4 message runs over that port between the shell and the worker.
- For a migrated surface, `method` names map 1:1 to the exported `lib/api` functions, and
  `params` / `result` are those functions' existing zod-validated shapes. Paging parameters
  stay.
- `error.status` reuses the HTTP vocabulary callers already branch on (404, 409, 422), so
  `errorForStatus` and the `ApiError` subclasses keep working.
- Bytes (exports, downloads, snapshots) cross as transferable `ArrayBuffer`s, never strings.
- Errors: `OpError` and a read's refusal keep their status; a `KeyError` of the model is 404
  with the server's quote-stripped text (`No element with id 'x`), a `ValueError` 422; a
  snapshot or delta the engine cannot read is 422; an unknown method is 404
  `No method 'x'`; anything else is 500 with its message.
- Replica methods, answered in any state, in this order: `open {project_id, metamodel}` →
  `chunk {bytes}` … (the gzip bytes as received, in transferred buffers) → `end` (answers the
  snapshot header once the replica is read and indexed; the replica stays `opening`) →
  `adoptStaged {batches}` (a re-bootstrap only: the staged batches carried over, under their
  ids) → `applyTail {text}`, which makes the replica `ready` — the tail ends opening, an empty
  one included. Then `applyDelta {text, own?}` → `applied | duplicate | gap`, a 409 unless
  `ready` (the shell buffers). `close` drops the replica, and any open in flight. A delta and
  a tail cross as the text the shell received (AD-26); a commit response is a delta as it
  stands, its `model_rev` read as `rev`.
- Staging: `stage {ops}` → `{batch, coalesced, changes, elements, relationships}` — the
  post-state of what it changed, both lists `null` past 500 entities; a single property update
  merges into the first staged update of the same entity (CT-5). `unstage {what}` (`'all'`,
  `{batch}`, `{entity, incident?}`) → `{changes}`; `stagedDiff` → before / after pairs from the
  committed images; `staged` and `conflicts` → the batches, answered in any state. Context,
  in any state: `setViewPlacement {view_id, element_ids}`, `dropViewPlacement {view_id}` —
  each loaded view's committed placements, which the excluded pool reads; `setArtifacts
  {artifacts}`, `putArtifacts {changed, deleted_ids, staged?}`, `setStagedArtifacts
  {entries}` — the project's committed artifacts with their payloads, and the staged entries
  mirrored from the frontend's buffer (AD-30). The shell remembers both and sends them again
  to every new worker, before any read; the engine keeps them across `close` and `open`. A
  `validation_rules` artifact carries its YAML's parse in `rules`, the body of `POST
  /rules/parse` — `{ok, document, errors}`, `document` the rule set as JSON text, read by the
  engine's exact parser (AD-33): a committed one `RulesParse | null` (`null` or absent: no
  parse), a staged create or update with a payload `RulesParse | 'pending'` (`'pending'` while
  the shell's parse is out: the set stands on the last parse the engine received for that id,
  and a create with none contributes nothing yet).
- A result is the HTTP response body of the `lib/api` function the method is named after.
  Evaluations are reads over the working copy: `searchModel {target, criteria, limit,
  offset}`, `evaluateNavigation {definition | artifact_id, row_element_id, limit, offset}` and
  `evaluateTable {definition | artifact_id, offset, limit}`, each resolving every artifact it
  names — staged ones included — before its first step, so an artifact call that lands between
  its slices changes the next call's answer, never its own. `evaluateTable` keeps the order of
  its last 16 tables while the replica's `rev` and `staged_version` stand: a later page of one
  evaluates its own cells alone. `getModelIssues {}`, `validateModel {batch_ids}` and `previewCommit {base_rev,
  batch_ids, strict}` (the model half only — artifact, view and `metamodel.move_node` ops
  stay a server call the shell merges in) answer the one live issue store over the working
  copy (AD-32), custom rules included — the committed and staged rule sets for the list and
  `validateModel`, the committed ones for the preview, as the server's preview does (AD-33).
  The three wait for a rule-set change to be applied: an artifact method that changes the
  rules starts a background rescan of the rules' population, and an `issues` call that
  arrives meanwhile is answered once it ends.
- An evaluation, or an `issues` call, the engine must not answer is refused with 501 before any
  work: `reaches a script` (a navigation that reaches a configured script step, or a table
  with a configured script column or such a navigation), `reaches an
  unsupported pattern` (a criterion or facet pattern the engine cannot match exactly as
  Python's `re` does) or `reaches unreadable rules` (an `issues` call while a rule set in
  either layer arrived without its parse, or with a document the engine's reader refuses —
  only a shell and a sandbox bundle of different versions send one). The client answers exactly
  those three from the server — a navigation's page marked with the reason (AD-31), an
  `issues` call's answer unmarked, exactly as the server always gave it; any other 501 is an
  error.
- Reads, `stagedDiff`, `stage` and `unstage` that arrive while the replica is not `ready` wait
  for it — nothing is refused for arriving early. The shell holds a read for the revs it has
  been told of (AD-28): it posts it once the replica has reached every `rev` it was handed
  before the call. It holds a transition for the phase alone — until the replica is `ready`
  (or the shell has frozen it), never for a `rev` — and posts it before any read asked after
  it. Requests are served in arrival order: a transition waits for every read
  that arrived before it and holds everything behind it, and between the slices of a long
  read, reads that arrived later are answered.
- Events: `replica {state: opening|ready|diverged, rev}` (`rev` null while opening);
  `progress {task, done, total}` for the tasks `parse`, `index`, `tail`, `verify` and `sweep`
  (AD-32's background revalidation, resumable, one background slot each with the digest check)
  — at most once per slice per task, plus a task's first and last; `changed {rev,
  staged_version, issues_version, artifacts_version, element_ids, relationship_ids,
  deleted_element_ids, deleted_relationship_ids, structural}` after every transition of a
  `ready` replica that changed something. `structural` says the element set or a relationship may have moved;
  `staged_version` moves whenever the staged batches do; `issues_version` moves whenever the
  issue store's content changes or `rev` does (origins can change under it), and whenever a
  rule set changes — its compile, `rules_status` or the tags may have moved, or the 501
  `reaches unreadable rules` come or go. `artifacts_version` moves whenever an artifact call
  adds, removes or replaces an entry of either layer with one that differs; handed the same
  entries again, it stays. The sweep, the rules rescan and an artifact call post it bare — no
  ids, `structural: false` — the sweep and the rescan at most once per slice, an artifact call
  once when either version moved, and never before `ready`: the first `changed` after carries
  the moves made meanwhile.
- Every request is cancellable. The engine client rejects a cancelled call with an
  `AbortError`, as an aborted `fetch` does.

## CT-5 · Working copy

1. Committed state changes only by opening a snapshot or applying a delta.
2. Staged ops use the op shapes of `src/data_rover/api/schemas.py`, are applied in place, and
   each records its inverse. The engine keeps the committed state of every entity a staged op
   touched, so committed reads need no rewind. A refused batch leaves no trace, and a rewind
   is exact: every touched entity goes back to its before-image — properties, `rev` and place
   in state order — which replaying inverse ops cannot give. The server's rollback
   (`routes/ops.py::_rollback`) is the same operation, pass for pass. A property update staged
   alone merges into the first staged update of the same entity, which keeps its place and its
   first before-image; the result is the state a replay of the staged ops gives. A client
   keeps the edit under the caret while the engine answers — written into what it shows at
   once — and never lets the engine's answer to an older edit regress a newer one.
3. To apply a delta: rewind all staged ops in reverse order → apply the delta → drop the staged
   ops it committed → rewrite temp ids through `id_map` → replay the rest. An op that fails
   replay is parked as a conflict and surfaced; it is never dropped silently. With the user's
   own commit named, a delta that arrives as a duplicate still drops the batches it committed.
4. Reads default to the working copy; `committed: true` selects committed state. *Not built
   in B: no read takes `committed: true`; the committed image crosses through `stagedDiff`
   instead.*
5. The working copy covers the **model** and **artifact** families — the inputs of
   evaluation. The artifact family is the committed payloads the shell hands in plus the
   staged entries mirrored from the frontend's buffer, each rule set carrying its parse
   (`rules`) beside its payload; references resolve against it,
   staged artifacts included. View and metamodel staged buffers stay in the frontend
   (AD-30). A call that reaches a script reads committed state on the server until scripts
   run in the browser (AD-31).
6. Temp ids (`tmp_` prefix) never leave the client except as an op's `temp_id`. The server
   mints every real id.
7. `adoptStaged` replays staged batches, under their ids, on a freshly opened replica — what a
   re-bootstrap carries over — parking what no longer applies.

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
