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

- `validation_error_count` is the client's own count, and null on a revert, which has no client preview.
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

- Transport-agnostic: a `MessagePort` in the browser; an in-process call in Node (tests, the
  export CLI).
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
  stands, its `model_rev` read as `rev`. An evaluation that reaches a script runs it, as CT-6
  says; there is no option, and a service whose host gave it no script host answers `ReadError`
  503 `no script host`, only when a pass needs a fill. A fill pins the replica its first scan
  starts on: one replaced between its slices answers 409 `replica closed`, it does not restart on
  the next replica. `progress {task: 'scripts', done, total}` counts the script calls the evaluations in
  flight have asked for and finished, summed, at each batch result, ending `done === total`
  when the last of them ends; a fill of a replica that was dropped posts nothing as it ends.
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
- A client that runs scripts itself sends `X-Data-Rover-Scripts: engine-only` on server requests;
  the server answers 409 `scripts need the engine` to tables evaluate, json-preview, export and
  script-errors, to exports run and preview-transform, and to navigations evaluate that reach a
  script. A run by name ignores the header.
- A result is the HTTP response body of the `lib/api` function the method is named after.
  Evaluations are reads over the working copy: `searchModel {target, criteria, limit,
  offset}`, `evaluateNavigation {definition | artifact_id, row_element_id, limit, offset}`,
  `evaluateTable {definition | artifact_id, offset, limit}`, `previewTableJson {definition |
  artifact_id}`, `tableScriptErrors {definition | artifact_id}` (`offset` and `limit` are read and ignored) and the exports `exportTable {definition | artifact_id, format, date, project}`,
  `runExporter` and `runExporterDraft` (one body: `{artifact_id | definition, name, date,
  project}`) and `previewTransform {entry, date, project}`, each resolving every artifact it names — staged ones included — before its first
  step, so an artifact call that lands between its slices changes the next call's answer, never
  its own. `evaluateTable` keeps the order of its last 16 tables while the replica's `rev` and
  `staged_version` stand: a later page of one evaluates its own cells alone. The engine reads no
  clock: an export's `date` (`YYYYMMDD`, the UTC day of the call) and `project` (the
  project's id, non-empty) are params, else a 422 `date must be YYYYMMDD` / `project must be a
  non-empty string`; its `${rev}` and a manifest's `model_rev` are the committed `rev`. An
  export answers `{parts, filename, content_type, truncated, script_errors}`: `script_errors`
  is `X-Table-Script-Errors`, a boolean, true when a script cell the export read was an error
  (an xlsx file then ends in the server's notice row); the file's
  bytes as `ArrayBuffer`s of at most 4 MiB, transferred with the answer rather than copied (the
  engine's own are detached once it is posted), and the filename and media type the route's
  `Content-Disposition` and `Content-Type` carry; `previewTableJson` answers `{sample,
  truncated}`; `previewTransform` answers `POST /exports/preview-transform`'s body without its
  `duration_ms`, `{files: [{filename, input, output, stdout, error}], split, truncated}`, `entry`
  the exporter entry as drafted and `date` and `project` the split filenames' template tokens,
  which the server reads off its clock and session. Where the replica evaluates scripts an export
  runs its table's or its entries' `transform(doc)` once a file is shaped, the snippet's failure
  a 422 of the export and a file's `error` of the preview, both held to the same size caps as the
  server (8 MiB of compact JSON each way) and the same entry-point checks. An export is a scan like any evaluation: a `stage` posted while it runs waits
  for it, so it answers the state it ran on; a `close` or a divergence under it sends it back to
  start over on the next replica; either way it is answered once, and never with part of a
  file. `downloadModel {}` (params ignored) answers `GET /model/download`'s file over the
  COMMITTED state, whatever is staged: `{parts, filename: 'model.json', content_type:
  'application/json'}`, the bytes in `ArrayBuffer`s of at most 4 MiB, transferred as an
  export's are. It is a scan as an export is: a `stage` or a delta posted while it runs waits
  for it, so it answers the committed state it began on; a `close` or a divergence sends it
  back to start over; `{cancel}` drops it unanswered. Where the server's stream breaks off
  mid-file, the engine refuses the whole file with 422: a non-finite float as `Out of range
  float values are not JSON compliant`, a lone surrogate in Python's encoder words, its
  position counted in code points from the start of the file. `validateView {view}` answers
  the view document's warnings, as `GET /views/{id}` sends them, over the WORKING model and the
  working artifacts (a staged artifact create is known, a staged delete is not): the six
  `view` warnings as `IssueOut`s with origin `on_server`, in the order the server gives them; a
  `view` that is not a view document is a 422 `view…`. `compareModel {file, created_at}`
  answers `POST /model/compare` over the WORKING model: `file` the uploaded bytes as a
  transferred `ArrayBuffer`, `created_at` the client's clock (`toISOString()`, the engine reads
  none), both read at arrival, else a 422 `file must be an ArrayBuffer` / `created_at must be a
  string`. It answers `{model_rev, cr, other_element_count, other_relationship_count}`:
  `model_rev` the committed `rev`, `cr` the working → file `datarover.cr/v1` document with the
  working counts as its baseline and `created_at` as its `createdAt`, a non-finite float `null`
  as pydantic writes it. The file must be UTF-8 (one byte order mark dropped) and JSON without
  a raw control character in a string; anything else is 501 `reaches an unreadable file`,
  which the client answers from the server. The file's shape is refused with the route's 422s,
  in its order and words. It is a scan as a download is: a `stage` or a delta posted while it
  runs waits for it; a `close` or a divergence sends it back to start over on the next
  replica, the file not parsed again; `{cancel}` drops it unanswered. `proposeCr {crs, created_at}`
  answers `POST /model/apply-cr` over the WORKING model: `crs` the request body's change
  requests as the client would send them, `created_at` as `compareModel`'s, both read at
  arrival. Change requests the engine does not read as pydantic would — not 1 to 20 of them,
  a wrong `format`, a missing `createdAt`, a `null` where a dict or a list goes, a `rev` that
  is not an integer (`"3"` and `true` included, which pydantic coerces) — are 501 `reaches an
  unreadable change request`, which the client answers from the server. The change requests
  apply in turn over an overlay of the working copy, which nothing writes to; the first that
  conflicts with the state its predecessors left answers, as an ok result, `{conflict:
  {cr_index, conflicts, model_rev}}`, the 409 body's shape, every conflict of its six buckets
  in order. Otherwise it answers `ProposeCrResponse` `{model_rev, cr, ops}`: `model_rev` the
  committed `rev`, `cr` the combined working → result `datarover.cr/v1` document (the working
  counts as its baseline, `created_at` as its `createdAt`), `ops` the batch that lands it in
  the route's order, temp ids `tmp_1`, `tmp_2`, …, values as pydantic writes them. The route's
  gate and its retype refusal are 422s in its words. A duplicate id among a change request's
  deletes is one delete, as on the server. It is a scan as a compare is: a `close` or a
  divergence sends it back to start over on the next replica, the change requests not read
  again; `{cancel}` drops it unanswered. `getModelIssues {}`,
  `validateModel {batch_ids}` and `previewCommit {base_rev, batch_ids, strict}` (the model
  half only — artifact, view and `metamodel.move_node` ops stay a server call the shell merges
  in) answer the one live issue store over the working
  copy (AD-32), custom rules included — the committed and staged rule sets for the list and
  `validateModel`, the committed ones for the preview, as the server's preview does (AD-33).
  The three wait for a rule-set change to be applied: an artifact method that changes the
  rules starts a background rescan of the rules' population, and an `issues` call that
  arrives meanwhile is answered once it ends.
  `candidateIssues {metamodel}` — a candidate document as `GET /metamodel` serves it — answers
  the model half of `POST /metamodel/diff`, `{now_failing, now_passing, unchanged_count,
  current_error_count, candidate_error_count}`: the store's issues against the whole working
  copy validated under the candidate as one run over the whole model does, with the working
  rule sets compiled under it, both keyed as the route keys them, every issue `on_server`.
  `previewCommit` takes an optional `rebind: {metamodel}`: the batch rebinds the metamodel,
  and it answers `{conformance_error_count, structural_blockers, issues, would_block: false}`
  over the whole working copy under the candidate with the committed rule sets — the staged
  model ops already in it, where the server hoists them. That is the server's rebind preview
  only for staged ops the candidate admits: the server applies them under the candidate, so a
  create of a type it lacks or has abstract, a create or update naming a property it does not
  give the type, or a delete while any relationship type's containment differs (the cascade
  may differ) is refused by the engine with 501 `reaches ops the candidate refuses`, checked
  when its scan begins, and the server answers — its own 422 included. Both read the document
  on arrival (a malformed one is a 422 `metamodel: …`, as `open`), then wait for the store's
  first sweep to have ended and for it to be settled, and scan in steps. The scan checks the
  call again and takes the store's state when it begins; a rule-set change between its slices,
  a replica closed under it, or a store not settled when it began sends the call back to wait
  and scan again: it is answered once, from one state and one pair of rule sets. A stage or a
  delta posted while it scans waits for it.
- An evaluation, an `issues` call or a candidate call the engine must not answer is refused
  with 501: `reaches an
  unsupported pattern` (a criterion or facet pattern the engine cannot match exactly as
  Python's `re` does, the candidate's included) or `reaches unreadable rules` (an `issues` or
  candidate call while a rule set in either layer arrived without its parse, or with a document
  the engine's reader refuses — only a shell and a sandbox bundle of different versions send
  one), and a rebind preview `reaches ops the candidate refuses` (above). Each is refused
  before any work but one: a pattern the host cannot run on a subject's value is found only
  when a validation reaches that value, so a sweep or a candidate scan can refuse it midway,
  having answered nothing. The client answers exactly those three from the server — a
  navigation's page marked with the reason (AD-31), an `issues` call's or a rebind preview's
  answer unmarked, exactly as the server always gave it; any other 501 is an error.
- Scripts: `scriptCalls {code, entry, console?, calls: [{element_ids, inputs_text?, doc_text?}]}` →
  `{results: [{text}], trips, ms, dispatch_ms, boot_ms, boot, ops?}` (`dispatch_ms` is the time
  the pool spent answering the run's bridge requests), one result per call in call order, each the
  harness's answer as the JSON text the script side wrote (handed on unparsed):
  `{payload, error, reads, stdout}`, where `error` is null or `{kind, message, traceback}`. `entry` is `value`, `step`,
  `transform` or `script`: `script` takes exactly one call (else a 422), is answered as a console
  run `{stdout, result_repr, truncated, error?}`, and adds `ops`, the ops its code proposed, as
  JSON text; `console: true` answers an embedded entry as a console run too; `boot` is
  `snapshot` or `cold`. `scriptWarm`, a bench and test aid the app does not call, is in CT-6.
  `inputs_text` and `doc_text` are JSON text, read by the exact parser
  (AD-26). Params are read at arrival, else a 422; then a 409 `replica is not ready` unless
  `ready`, and a 501 `scripts are not available` where the host gave the engine no script
  host (an evaluation is 503 `no script host`, above). The call is not a scheduler job and is not queued behind the model lane: it runs on
  the state as it stands, staged edits included. The script reaches the model only through
  the bridge, which reads the ready replica's working copy and is answered where the request
  arrives, synchronously, outside the scheduler; with no ready replica — never opened, opening,
  diverged, closed — its reply is `{"id": …, "error": "BridgeError: replica is not ready"}`,
  and it never waits. A call belongs to the replica it arrived on: calls run at once, each
  with a bridge of its own, and a run in flight reads that replica alone — once it is closed, replaced (by a replica
  already `ready` included) or diverged the bridge answers not-ready — and a call whose
  replica went before its run began or by the time it ended is answered 409 `replica
  closed` (`replica is not ready` after a divergence), never with results, and a replica
  dropped under a run stops it. `{cancel: id}` on a call stops its run and the call is never
  answered. When the artifacts hold a snippet and a replica is ready the engine starts the host's
  first worker ahead of the first call. A `stage`,
  `unstage` or delta on the same replica does not end a run. The host is made at the first
  call and disposed by `close`; a replica opened again boots another. `boot_ms` is the boot
  that serves the call: every call goes through the host's `boot()`, so a host that failed to
  boot or stopped mid-run starts over on the next call, and a failed boot (a 500 for every
  call waiting on it) is not remembered by the engine. A host answer that is not one result
  object per call is a 500.
- Console runs: `runSnippet {code | artifact_id, entry, element_ids, inputs?}` → `{stdout, result_repr, ops,
  error, truncated, duration_ms, stamp: {rev, staged}}`, one console run over the working copy
  (`entry` `script`, `value` or `step`, params as the server's `/snippets/run` read them; 404 `snippet
  not found`, 422 bad params, a snippet of another kind or `transform` with the console, 409 and 501 as
  `scriptCalls`). `ops` are read as a stage reads them: a non-model or malformed op empties it and
  answers a `runtime` error. `stamp` names the working-copy state the run read (the replica's `rev` and
  its staged version); a result is out of date once the current stamp differs. `{cancel: id}` stops it
  unanswered, and the client rejects locally. The server's `/snippets/run` and `/snippets/cancel` stay for
  F; the app does not call them.
- Reads, `stagedDiff`, `stage` and `unstage` that arrive while the replica is not `ready` wait
  for it — nothing is refused for arriving early. The shell holds a read for the revs it has
  been told of (AD-28): it posts it once the replica has reached every `rev` it was handed
  before the call. It holds a transition for the phase alone — until the replica is `ready`
  (or the shell has frozen it), never for a `rev` — and posts it before any read asked after
  it. Requests are served in arrival order: a transition waits for every read
  that arrived before it and holds everything behind it, and between the slices of a long
  read, reads that arrived later are answered.
- Events: `replica {state: opening|ready|diverged, rev}` (`rev` null while opening);
  `progress {task, done, total}` for the tasks `parse`, `index`, `tail`, `verify`, `sweep`
  (AD-32's background revalidation, resumable, one background slot each with the digest check)
  and `scripts` (below) — at most once per slice per task, plus a task's first and last, except
  `scripts`, posted at each batch result; `changed {rev,
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
   (AD-30). A script reads the working copy: the engine evaluates it over the model and the
   artifacts as staged (AD-34), and the server's script path reads committed state only for a
   client that sends no `engine-only` header.
6. Temp ids (`tmp_` prefix) never leave the client except as an op's `temp_id`. The server
   mints every real id.
7. `adoptStaged` replays staged batches, under their ids, on a freshly opened replica — what a
   re-bootstrap carries over — parking what no longer applies.

## CT-6 · Script bridge

- The Python facade and its single synchronous `_transport(req) -> dict` are unchanged.
- Browser transport: the script worker posts the request and blocks on shared memory; the
  engine answers asynchronously and wakes it. Headless transport: a direct call.
- Script workers belong to a pool (`engine/src/script/pool.ts`, the same code on both hosts; the
  host supplies spawning, `loadPyodide` and the global scope to pin). One worker runs one batch,
  then is ended; the next batch gets a fresh worker, so no interpreter or worker state outlives
  a batch. Workers boot from a memory image of Pyodide with the guest loaded (each its own copy),
  or cold when the image cannot be made or restored; a result reports which (`boot`). The cap is
  `max(1, min(4, hardwareConcurrency - 2))`. Once asked, the pool fills every free slot with a
  spare as soon as the image is ready, so `cap` workers are alive and the first runs of a burst
  start at once; spares beyond one end after 30 s without a queue, and stay ended until the next
  call asks. Runs of different batches proceed concurrently, each on its own worker and
  channel. The engine worker spawns, boots and ends workers (on `dispose`, a failure or an
  `error` event); a worker's channel is private to that pair. It alone blocks, on its own reply
  buffer: one `SharedArrayBuffer` of 1 MiB per worker, an Int32 header and the reply's UTF-8
  bytes, chunked when a reply is larger. The engine worker never blocks.
- The message set is the pool's: pool to worker `init` and `run`; worker to pool `ready`,
  `failed`, `snapshot {bytes}` (the image maker only), `call-start`, `call-end`, `bridge`, `more`,
  `done` and `csp-violation`. A worker's message is never trusted beyond its own batch: the pool
  validates shape and place, the first valid `done` wins and later messages are dropped, and a
  worker that breaks the protocol is ended.
- Limits: 10 s per call, 30 s per batch (a call's deadline is the lesser of 10 s and what
  remains of the batch). At the deadline the pool raises Pyodide's interrupt (the soft stop,
  repeated until the call ends because the flag can be lost): that call answers `timeout` and the
  batch continues. 1.5 s later, if the call has not ended, the pool ends the worker (the hard
  stop). The rest of the batch answers `timeout` only after a hard stop, a spent batch budget or
  a stopped module-level window. The replica survives either stop. On the Node host a worker
  shares the process, so that host runs trusted code only until E gives the export CLI a
  process boundary (`K-106`, AD-35).
- Warm: `scriptWarm` (no params; a bench and test aid, which the app does not call) prewarms the
  host and answers `{spares}` once the pool holds `cap` ready spares. It is refused as
  `scriptCalls` is: 409 `replica is not ready` without a ready replica, 501 without a script
  host, 409 `replica closed` when the replica is dropped under it. It rejects with the boot error
  when a boot fails with none under way; a cancel (`{cancel: id}`) drops the wait. The idle
  shrink is held while it waits.
- Prewarm: the service can start the pool when a replica holds a snippet, before any call
  (`ServiceDeps.prewarmScripts`): the first worker, then spares up to `cap` once the image is
  ready. The sandbox turns it on, and the service scans the artifacts for snippets only when
  `artifacts.version` has moved.
- The dispatcher is a port of `src/data_rover/core/script/bridge.py` and keeps trip-collapse.
  One trip carries one op and one reply; a reply piggybacks the projections the collapse
  lets it (far endpoints, hop relationships), and a call's roots travel with the call. Sub-project D MAY
  replace JSON with a binary layout behind the same `_transport`.
- Scripts only propose ops; the engine never applies a script's op without the user staging it.
- Runs are deterministic on both hosts: `Date.now` pinned
  to `1750000000000` and `Date`'s local getters and `getTimezoneOffset` to UTC,
  `crypto.getRandomValues` filled with `0x42` (and `node:crypto`'s on the Node host),
  `PYTHONHASHSEED=0`, and `random.seed()` after every image restore.
- Evaluation: an evaluation is a loop of passes
  over the model lane and rounds of batches outside it. A pass answers a call from the
  evaluation's memo or the cell cache, else records it and answers it pending; a pass that
  recorded one is discarded, its calls run as one batch per `(code, entry)` through the pool
  and the pass runs again, until a pass records none. A `stage`, `unstage` or delta lands
  between passes, never within one, and a pass is read at the state its scan started in: a
  pass that records no call is answered whatever lands after it, so a `stage` posted behind
  an evaluation waits for it and the evaluation answers the state it ran on, as without scripts,
  and a stream of stages does not starve one. A round's settle runs in scheduler slices of 256
  calls, its stamp checked at the start and after every yield, so a transition waits at most one
  slice. A transition that changes the model
  and lands while a round runs drops that round, results and all, and the pass runs again from
  the state it ends in; one that changes nothing leaves it. The call belongs to the replica its
  first scan starts on, so one that arrives while the replica is diverged or not yet ready waits
  for the next, as any call does; that replica closed, replaced or diverged answers it 409
  (`replica closed`, `replica is not ready`), `{cancel}` stops its batches, soft then hard,
  and answers nothing.
- Results are cached in the engine, keyed `(code, entry, element ids, inputs, doc)` (the code is
  in the key, so an edited snippet is another call), with read-sets. Bounds: 50,000 entries,
  32 MiB of keys and result texts, a result over 64 KiB not stored, a read-set over 128 keys
  stored as "depends on everything"; a value, a `runtime` and a `syntax` error are stored, a
  `timeout`, `cancelled`, `memory`, `unavailable`, `pending` or `limit` is not. A
  transition evicts the entries that read a key it touched, the union over the state it
  leaves and the state it makes, and every entry that depends on everything; one that changed nothing evicts nothing. A cascade is in it:
  the contained elements and incident relationships a delete removed. A result is stored only
  if no transition moved since the pass that asked for it began, so nothing computed before a
  transition enters the cache after its eviction. The cache is dropped at `close`, a new
  `open` and a divergence.

## CT-7 · Fidelity to the golden fixtures

The engine MUST reproduce the Python core's observable behaviour. The golden fixtures, recorded
from the Python core, are the test; they are frozen regression data.

| Area | Rule |
|---|---|
| Numbers | The parser MUST keep Python's `int` / `float` distinction (`1` vs `1.0`: integer conformance is `isinstance(v, int)`) and integers beyond 2^53 (value model: AD-21). Bare `Infinity` / `-Infinity` / `NaN` literals load as those strings, as `parse_model_json` does. One formatter reproduces Python's float `repr`. Equality and uniqueness signatures follow Python equality (`True == 1 == 1.0`). |
| JSON output | One serializer reproduces `json.dumps` for the settings each writer uses: `ensure_ascii=False`, `allow_nan=False`, compact separators or `indent=2`, insertion key order. |
| Strings | Compare by code point, never UTF-16 code unit. `casefold` uses a table generated from Python's `str.casefold`. |
| Regex | Patterns are Python `re` dialect: `re.fullmatch` for pattern facets, `re.search` for search criteria, an invalid pattern never matches. A translator converts them; a pattern outside its supported subset is a lint warning, never a silent difference. |
| Dates | `date` values parse exactly as `datetime.date.fromisoformat` on Python 3.14. |
| Order | No `Intl`, no locale comparison, no dependence on hash order. `Map` insertion order stands in for `dict` order. Sorts are stable. A plain object stands in for a property `dict`; it lists a canonical array-index key (`"0"`, `"42"`) first whatever the insertion order, so the engine refuses an entity carrying one at any depth of its properties. |
| Arithmetic | `+ − × ÷` and comparisons only in evaluation paths; no transcendental `Math` functions. |
| Exports | `json`, `jsonl`, `csv` and `manifest.json` match the golden fixtures byte for byte. `xlsx` matches by cell content, and is byte-identical across the engine's two hosts: sub-project C holds that in Node only, and E's cross-host test (one export in Node and in Chromium, bytes compared) closes it. |
