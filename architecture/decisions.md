# Decisions

Each entry: the decision, why, what was rejected, and what follows from it. Evidence numbers
are in [constraints.md](constraints.md). Do not reopen a decision without new evidence.

## AD-1 · Computation runs in the browser; the server is thin
**Why.** The server-heavy design holds ≈ 1.4 GB per hot 80 MB project *(measured)*, is pinned
to one process by in-memory sessions and the GIL, and its cost exceeds the budget at 20 users
and grows with every hot project (CN-6, CN-8). It also causes two user-facing defects:
evaluation sees only committed state ("commit first"), and script sweeps exhaust the server's
sandbox pool.
**Rejected.** Scaling the current server up or sharding it by project.
**Consequences.** The browser needs a full replica and a sync protocol (CT-1…CT-3); the server
stops loading models (AD-7).

## AD-2 · The engine is TypeScript
**Why.** Engine language does not move the GCP bill (CN-8). JS and Rust replicas both clear
every budget by ≈ 10× at 170k elements (CN-4). TypeScript shares types with the frontend,
sits one hop from Pyodide, needs no third toolchain, and ports the dynamic Python core
near-mechanically (≈ 1.5–2× less effort than Rust, *estimate*).
**Rejected.** *Rust → wasm*: 1.2–3.8× faster and more compact, exact `i64`, code-point string
order, bit-identical hosts — real advantages that nothing here needs yet. *Python core under
Pyodide*: no headroom (CN-22).
**Consequences.** CT-7 carries the fidelity work Rust would have eased. If models grow far past
320k elements, hot kernels MAY move to wasm behind CT-4 without changing any contract.

## AD-3 · One engine, two hosts
**Decision.** The same engine package runs in a browser worker and in Node; the headless host
is Node + Pyodide, the same Pyodide version as the browser.
**Why.** CI exports (`GET /exports/run-by-name`) are essential and MUST equal the browser's
bytes. Products that split client and server engines diverge.
**Rejected.** A native or Python server-side engine; the wasmtime CPython-WASI sandbox for
headless scripts (a second script bridge).

## AD-4 · User scripts stay Python, in Pyodide; the facade is unchanged
**Why.** Owner preference and existing snippets. JS-language scripts would be ≈ 250× faster
(CN-4) and were declined knowingly.
**Consequences.** Pyodide boot (≈ 5 s, ≈ 90 MB) is paid before the first script and SHOULD be
prewarmed; the bridge needs batching (CT-6).

## AD-5 · The engine lives in the sandbox origin; the shell does all networking
**Why.** The facade needs a synchronous read. Blocking on shared memory is the only portable
way, and shared memory cannot cross origins (CN-15). Proven in the spike: zero CSP violations,
cross-origin isolated, runaway script interrupted with the model intact.
**Rejected.** *Engine in the app origin*: needs a replica per script worker or JSPI (CN-16).
*Engine and Pyodide in one worker*: a runaway script stalls every read, a Pyodide crash takes
the replica, and user code shares the engine's realm.

## AD-6 · Keep pessimistic locks, explicit commits, the journal, `model_rev` and the feed
**Why.** They already form a correct sync protocol (server-ordered revisions plus deltas).
**Rejected.** Zero, ElectricSQL, PowerSync, LiveStore, CRDTs: none fits leases plus explicit
commits, and each adds an always-on service.
**Consequences.** Op shapes and lock semantics do not change in this program.

## AD-7 · The server never loads a model
**Decision.** The commit check reads head rows for the batch only, runs the existing Python op
applier on that partial model, and derives inverse ops and `entity_states` itself.
**Why.** Undo, revert and per-commit diff depend on inverses and `entity_states`; they cannot
be client-supplied (CN-19). Reusing the applier keeps one implementation of mutation rules
on the server.
**Consequences.** Head tables, `entity_refs`, set-based SQL checks for import and rebind
([system.md](system.md)).

## AD-8 · Conformance validation and strict mode are enforced by the client
**Decision.** The server enforces structural integrity, declared types and property names,
and leases. Conformance (type, multiplicity, facets, endpoints, uniqueness, rules) runs in the
engine; in strict mode the client refuses to commit with errors. The validation count and
issues stored on a `Commit` row are client-reported.
**Why.** Members are authenticated colleagues; conformance is already non-blocking outside
strict mode; server verification would reintroduce a loaded model.
**Rejected.** Headless verification per commit (seconds of latency, or warm RAM per project).
**Deferred, addable without contract change.** A periodic headless audit.

## AD-9 · The server stays Python / FastAPI
**Why.** Auth, tenancy, locks, feed, journal, artifact/view/metamodel persistence are kept
as they are. A rewrite buys at most ≈ $25/month *(estimate)*.

## AD-10 · No offline mode
**Why.** Leases and explicit commits need the server. The IndexedDB snapshot cache is a
disposable accelerator; losing it costs one download.

## AD-11 · Snapshots are line-delimited (CT-1)
**Why.** Parse while bytes arrive, bounded peak memory, progress, cancellation; natural to
stream from head rows. It is also what makes exact values (AD-21) affordable: only the lines
that need the exact parser pay for it. At M, 18.5 % of lines do — line-routed parse 1.49 s,
whole-document exact parse 2.50 s, whole-document native (inexact) parse 0.59 s *(measured,
one pass, Node 22, 2026-09-18)*. Sub-project A confirmed that open stays within CN-3: from
inflated bytes to indexed replica 2.30 s — 1.73 s to decode, split, parse and load, 0.52 s to
index — against 3.14 s for the same model as one document, 2.26 s of it the exact parse
*(measured, medians of 3 in one pass, Node 22, `pixi run engine-bench`, 2026-09-18)*.
**Rejected.** One JSON document (needs the whole text and one blocking parse); a binary format
(no evidence it is needed).

## AD-12 · Divergence is detected by digest and healed by re-bootstrap
**Decision.** CT-3 digest plus `prev_rev` continuity; on any mismatch the replica is discarded.
**Why.** Committed state always arrives whole from the server, so a replica can diverge only
by missing or misordering deltas — which `(id, rev)` pairs fully detect. No repair protocol.
**Rejected.** Hashing property values (needs byte-identical canonical JSON across Python and JS).

## AD-13 · No client-side trigram index
**Why.** A full name scan over 170k elements is 51 ms in JS *(measured)*. The server index
costs ≈ 0.9 GB per project *(measured)* and is the dominant bulk-load cost.

## AD-14 · The working copy is staged ops applied in place, with rewind and replay (CT-5)
**Why.** One data structure serves every read; evaluation sees staged state with no overlay
lookups; leases make replay conflicts rare.
**Rejected.** A copy-on-write overlay consulted on every read.

## AD-15 · In the headless host the container is the security boundary (CN-20)
**Why.** Headless runs untrusted Python with no browser origin around it, and Pyodide is not
a boundary (CN-18).

## AD-16 · One dedicated engine worker per tab
**Deferred.** A `SharedWorker` replica across tabs, only if multi-tab memory proves a problem.

## AD-17 · No data migration
**Decision.** At sub-project F the thin server replaces the current one and projects are
re-imported from their JSON/YAML files.
**Why.** No production data exists (owner, 2026-09-18).

## AD-18 · Migration goes through `frontend/src/lib/api`; the current server is the oracle until F
**Why.** Every server call already passes through `lib/api/client.ts`; no component builds a
URL or calls `fetch`. Swapping a module's transport leaves its callers untouched.
**Consequences.** Migration rules MR-1…MR-5 ([program.md](program.md)).

## AD-19 · Baseline is evergreen desktop browsers
**Decision.** No dependency on a Chromium-only API. Development and CI measure on Chromium.

## AD-20 · The store is a record graph
**Decision.** One fixed-shape class instance per entity; adjacency and containment parents
are arrays of direct record references on the record; global indexes exist only where a
global lookup is needed (by id, by type, uniqueness, references, root order). The store sits
behind an interface.
**Why.** A field-by-field port of `IndexSet` (`Map<string, Set<string>>`) allocates hundreds
of thousands of small collections — 300–450 MB at M *(estimate)* — and makes every hop a
string lookup. The record graph is 150–250 MB *(estimate)* and hops are pointer chasing,
while the port stays near-mechanical.
**Rejected.** A columnar layout (typed arrays, interned strings, CSR): most compact, but
in-place staged edits with rewind and replay fight it and properties are schemaless. It
remains the escape hatch behind the store interface.
**Consequences.** Adjacency order is unspecified, as in Python; anything observable MUST
sort, and tests shuffle adjacency. Entity order is restored through a per-record insertion
sequence (CT-1).

## AD-21 · Values: `number` is a Python int, `PyFloat` is a Python float
**Decision.** `int` within ±(2^53 − 1) → `number`; larger → `bigint`; every `float` →
`PyFloat`, integral or not; the strings `"Infinity"`, `"-Infinity"`, `"NaN"` stay strings.
Lines that can contain a float, a big integer or a bare non-finite literal go through an
exact parser; all others through native `JSON.parse`.
**Why.** Integer conformance, exports and uniqueness depend on the distinction, and JSON
text is the only place it survives. Every float Python writes contains `.`, `e` or `E`, so a
text pre-scan routes lines exactly while keeping native parse speed for the rest.
**Rejected.** A reviver with source-text access on every value (slows the whole parse); a
side table of float-typed keys (two sources of truth per value).

## AD-22 · The engine takes a validated metamodel as JSON
**Decision.** The engine consumes the `GET /metamodel` document and builds its caches from it.
YAML parsing and `check_metamodel` stay on the server.
**Why.** The server must validate a metamodel anyway before accepting it (AD-7); a second
validator in the engine would be a second implementation to keep identical.

## AD-23 · A transition is atomic; the chunk rule binds evaluation and background work
**Decision.** Stage, unstage, rebase and delta apply run to completion without yielding,
under their own budget (CN-3). Opening, the index build, the digest check and every
evaluation yield in chunks ([system.md](system.md) rule 4).
**Why.** A half-applied batch is not a consistent state, and rule 4 demands consistency at
every yield. The engine runs in a worker, so a transition delays the reads queued behind it
and never the UI; 100 ms is where a discrete action stops feeling instant. Measurements:
`BACKLOG-ENGINE.md`, `K-32`.
**Rejected.** Resumable staging, with reads blocked or served from committed state mid-batch.

## AD-24 · The model store forks; the legacy half lives until F
**Decision.** In engine mode staged edits live in the engine's working copy and
`frontend/src/lib/state/model.svelte.ts` is a view over it. Today's store — fetched-subset
cache, optimistic overlay, staged-delete guards — stays behind the switch as the server-mode
implementation and is deleted in F. The engine-backed store is built last in sub-project B,
after the read surfaces have moved as a plain transport swap.
**Why.** A server read is committed-only, so server mode cannot work without the overlay
(MR-1); and one staged state has to exist before evaluation reads it (sub-project C).
**Rejected.** *Transport swap only*: from C on, the engine's working copy and the store's
overlay would be two implementations of staged state. *No fallback*: MR-1.

## AD-25 · The workspace waits for the replica
**Decision.** In engine mode every engine-served read waits for `ready`; the open progress
shows download, parse, index and tail.
**Why.** One source of truth from first paint. CN-3's cold-open budget is what makes the wait
acceptable.
**Rejected.** Serving reads from the server until the replica is ready: two sources during
the hand-over, and code that F deletes.
