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
**Decision.** The same engine package runs in a browser worker and in Node; an export without a
browser runs on Node + Pyodide, the same Pyodide version as the browser (AD-35).
**Why.** An export without a browser MUST equal the browser's bytes. Products that split client
and server engines diverge.
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
**Consequences.** Built: head tables, `entity_refs`, set-based SQL checks for import and rebind
([system.md](system.md)). The server keeps per-project state over the head rows and the commit
journal (`api/project_state.py`) and holds no model.

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

## AD-15 · In the headless host the container is the security boundary — superseded by AD-35

## AD-16 · One dedicated engine worker per tab
**Deferred.** A `SharedWorker` replica across tabs, only if multi-tab memory proves a problem.

## AD-17 · No data migration
**Decision.** At sub-project F the thin server replaces the current one and projects are
re-imported from their JSON/YAML files.
**Why.** No production data exists (owner, 2026-09-18).

## AD-18 · Server calls go through `frontend/src/lib/api`
**Why.** Every server call already passes through `lib/api/client.ts`; no component builds a
URL or calls `fetch`. Swapping a module's transport leaves its callers untouched.
**Consequences.** The engine took over each surface by swapping its module's transport. The migration rules MR-1…MR-3 are retired ([program.md](program.md)): the server answers no model read, so there is no second side to compare with.

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

## AD-24 · The model store is a view over the engine's working copy
**Decision.** Staged edits live in the engine's working copy and
`frontend/src/lib/state/model.svelte.ts` is a view over it. There is no second store: the
fetched-subset cache, the optimistic overlay and the staged-delete guards are gone, along with
`model-legacy.svelte.ts`. `model-shared.svelte.ts` holds what the store and its callers agree on
(summary, `model_rev`, structure rev, issues); `model-caches.ts` holds the pure id-remap helpers
`applyDelta` uses.
**Why.** One staged state has to exist before evaluation reads it, and a server read is
committed-only, so it could not carry staged edits.
**Rejected.** *Transport swap only*: the engine's working copy and the store's overlay would be
two implementations of staged state.

## AD-25 · The workspace waits for the replica
**Decision.** In engine mode every engine-served read waits for `ready`; the open progress
shows download, parse, index and tail.
**Why.** One source of truth from first paint. CN-3's cold-open budget is what makes the wait
acceptable.
**Rejected.** Serving reads from the server until the replica is ready: two sources during
the hand-over, and code that F deletes.

## AD-26 · A delta crosses into the engine as JSON text
**Decision.** The shell hands the engine the text it received — a feed frame, a commit
response, a tail body — and the engine reads it with its exact parser (`applyDelta {text}`,
`applyTail {text}`).
**Why.** The host's `JSON.parse` loses `1` vs `1.0` and every integer past 2^53 (CT-7), and
the state digest, which folds `(id, rev)` only, cannot see a wrong value: it would stay until
the next re-bootstrap.
**Rejected.** Parsed objects: the loss. Transferred bytes: exact too, but a feed frame arrives
as a string.

## AD-27 · The replica changes metamodel when the UI does
**Decision.** A rebind, a peer's or the user's own, freezes the replica; it re-bootstraps onto
the new metamodel when the UI adopts it (the banner's Reload, the committer's in-place
refetch).
**Why.** The engine checks staged edits against ITS metamodel and the forms are drawn from the
UI's; while the two differ a refusal contradicts the form, and staged edits would be replayed —
and parked — under a schema the user has not seen. Nothing is lost by waiting: no delta can
cross a rebind anyway (CT-2).
**Rejected.** Re-bootstrapping on the event.

## AD-28 · A read waits for what the shell has been told
**Decision.** The shell posts a read only once the replica's `rev` has reached the highest
`rev` handed to it before the call — a feed delta, an own commit's response, a snapshot or
reset event.
**Why.** The shell applies deltas one at a time and holds them during a commit, so the
engine's arrival order cannot cover a delta not yet posted; the UI acts on a commit the moment
its response is parsed, and a read from before it would undo what the user just saw — or
write an older `model_rev` into the store.
**Rejected.** A `min_rev` parameter on every read (an engine change for a shell concern);
waiting for the pump to be idle (a commit in flight would stall every read).

## AD-29 · Staged edits stay under the caret
**Decision.** The engine store writes an edit into its caches synchronously and lets no
engine answer regress a newer edit; the engine's staged list is mirrored, never predicted.
**Why.** The property form emits per keystroke and renders from the cache — it keeps no
draft of its own, so the cached value is what it shows; an answer that overwrote a later
keystroke would move the caret; predicting batch ids and versions would make the mirror
drift the first time an event and an answer crossed.
**Rejected.** A per-field draft (every emitter would need one); applying `stage` answers to
the mirror (the `changed` event, not the answer, is the engine's word on the staged list).

## AD-30 · The staged artifact buffer stays in the frontend; the engine mirrors it
**Decision.** Staged artifact edits stay in the frontend's buffer, which the commit posts.
The engine holds the committed payloads the shell hands in and a copy of the buffer, sent
again on every change (`setArtifacts`, `putArtifacts`, `setStagedArtifacts`: context methods,
CT-4); evaluation resolves references against both, staged entries first (CT-5).
**Why.** A payload is checked on the server at commit (its schema, the name clash, derived
metadata such as a snippet's entry points), and none of that is in the engine. An artifact
entry replaces its payload whole and meets no model op, so there is nothing to rebase: a copy
is exact. Checkout, leases and the commit path stay as they are.
**Rejected.** An engine-owned buffer: a second implementation of staging, checkout and the
commit's artifact ops for no reader that needs it. A closure per call (the frontend resolving
every artifact a call names and sending them with it): every caller would have to know what an
evaluation reaches.
**Consequences.** The shell follows the committed payloads by feed event and after each own
commit; while a commit's payloads are fetched, the entries it carried stay in the overlay, so
no evaluation reads a committed artifact as missing.

## AD-31 · Before scripts run in the browser, a call that reaches a script is the server's
**Superseded** by AD-34 for scripts and by the thin server for the rest: the server evaluates no
navigation, table or search, so there is no server side to fall back to. What follows is the
record of the rule.
**Decision.** (Narrowed for scripts by AD-34, which ended the script half.) Until sub-project D, the engine refuses a navigation that reaches a configured
script step — and a criterion pattern it cannot match exactly as Python's `re` does — with 501
before any work, and the client asks the server instead, whole.
**Why.** One table or navigation never mixes committed and working state: a result is either
all the engine's over the working copy or all the server's over committed state. Until the
shell's artifact follower has loaded the project's artifacts once, navigations are answered by
the server, over committed state and unmarked; a preview whose first page came from the server
before that load and whose "Load more" runs after it can mix the two sides, and with staged
model edits a chain can then be duplicated or skipped. The window is one payload fetch, plus
about 1 s after a failed fetch. When both the fetch and its one retry fail, the follower does
not try again on its own: the window stays open — navigations keep reading the server — until
the next feed `snapshot` event asks it to load once more.
**Rejected.** Forwarding each script call from the engine to the server: its inputs would be
working-copy elements the server has never seen. Placeholder cells for script results: a
result that is neither side's.
**Consequences.** The 501 (`reaches a script`, `reaches an unsupported pattern`) and the
fallback marker (`fallback: 'script' | 'pattern'` on a navigation page, a note in the results
dock) say that a result reads committed state. D deleted both for scripts (AD-34); the pattern
refusal stays while the engine's regex translator covers a subset of Python's syntax.

## AD-32 · One live issue store over the working copy; origins by rewind probe
**Decision.** The engine keeps one `IssueStore` over the replica's working copy — a resumable
background sweep once `ready`, incremental revalidation inside every transition — and answers
`getModelIssues`, `validateModel` and the model half of `previewCommit` from it. An issue's
origin (`uncommitted` / `on_server` / `resolved`) is read off a rewind probe: every staged
batch is rewound, replayed once to find the dirty set a server preview of the same ops would
see, and validated on both the working and the committed state either side of the rewind.
**Why.** The panel must read a staged edit's issues before any commit, and the tree and the
commit preview must agree with it — one store, not three answers that can drift. The probe
never walks the whole model: it costs O(staged + the neighbourhoods the staged ops touch,
uniqueness groups included), so it stays within CN-3's transition budget unless the staged
set, or a duplicate group it reaches, is itself large.
**Rejected.** An engine overlay layered on the server's committed issue store: two sources to
reconcile, and the server's store still lags a staged edit. Validating on demand only, with no
resident store: every panel read would cost a full scoped run, and the tree's live badges would
have nothing to poll. A second store that mirrors only committed issues, separate from the
working one: the exact drift this decision avoids, moved one level down.
**Consequences.** The sweep holds no iterator, so it resumes across a stage, an unstage and a
delta; a re-bootstrap builds a new store whose sweep starts over, and the gate closes until it
ends. A re-sweep (`validateModel`) revalidates in place and never empties the store. Three dirty
rules keep it exact: a stage fires the Python hooks the applier already runs; a rebase (unstage,
`applyDelta`) takes the neighbourhood of every id it may touch, before and after, and carries
the ends of every relationship it touches on both sides, since it has no Python counterpart to
mirror exactly; a coalesced edit takes its trial run's hooks plus the rebase rule over the
batches a merge replays. The `issues` surface is gated on `staging: engine`, the replica's first
sweep completing and the artifact follower's first load (until then the engine cannot know a
`validation_rules` artifact exists); a re-sweep (`validateModel`) does not close the gate again
— it closes only when the replica leaves `ready` or a new replica starts, and stays open across
a frozen replica. Before the gate opens, for a project the engine cannot validate (an
unsupported facet pattern, a rule set it cannot read), or when the engine answers 409
(`stale staged batches`, `stale base_rev`, `replica is not ready`), the whole request falls back
to the server, as CT-4's refusals say; a rule-set change moves `issues_version`, so the list is
fetched again from the side that now answers. The gate no longer reads rules as unsupported:
since AD-33 the engine compiles and evaluates the project's rule sets itself, and only an
unreadable one sends an `issues` call to the server.

## AD-33 · Rules reach the engine as parsed text; the engine compiles, reaches and evaluates them
**Decision.** The server parses a rule set's YAML (`POST /rules/parse`, and `rules` beside each
rule set on `GET /artifacts/payloads`) and hands the engine the validated rule set as JSON text,
which the engine reads with its exact parser and a strict reader (CT-4). The engine compiles,
reaches and evaluates the rules itself, as the seventh validator of its live issue store
(AD-32): a committed compile over the committed rule sets and a working one over the staged
overlay laid on them, each in name order, then id.
**Why.** AD-22 extended: YAML, the grammar and its caps stay on the server, which must check a
rule set at commit anyway; a second parser would be a second grammar to keep identical. Exactness
(AD-26): a document sent as a string keeps `1.0` and integers past 2^53, which the shell's
`JSON.parse` would lose, and a rule's operand compares exactly. The store sees staged rule sets:
the panel and Validate show a staged rule set's issues before any commit, which the server,
knowing only committed rules, cannot.
**Rejected.** A YAML parser in the engine: the second grammar. A server compile per candidate:
a round trip per staged change, and the compile apart from the reach and evaluation that read
it. The document as a JSON object: the shell's parse and the engine's re-serialization lose
exactness. Answering reads mid-rescan: a half-rescanned store mixes two rule sets' verdicts.
**Consequences.** Two compiles and the rescan: a rule-set change swaps both at once and, when
the working set's ordered rule identities changed, queues the population of every rule of the
old and the new working set, as the server's commit does, for a background rescan in the
sweep's slot; `getModelIssues`, `validateModel` and `previewCommit`
wait for it to end, and typing never does. Reach joins every dirty set — stage, rebase,
coalesced edit, probe — on the state after the transition, with the working rules' paths; its
premise (an owner whose verdict flips has a path that first meets an element that moved, and
every dirty set holds such elements) is held by seeded invariants against a fresh sweep. The
preview reads the committed rules, as the server's does, until `K-65`: on a strict project a
staged rule set that fails on existing elements shows in the panel and in Validate, the preview
says the batch lands, and the commit answers 422. Origins stay exact across a staged rule set:
the probe also validates the changed rules' population on both states, and caches the part the
staged model edits do not reach per `rev` and rule-set change, so a keystroke does not pay it
again. A document the engine's reader refuses, or a rule set that arrives without its parse, is
refused (`reaches unreadable rules`), never guessed at; `rules_status` comes from the working
compile, which with nothing staged equals the server's.

## AD-34 · Scripts evaluate in the engine by collect, fill, re-run
**Decision.** An evaluation that reaches a script runs as a fill in the service loop: a pass scans
the model lane with the cell cache as its reader and collects the calls it could not answer; the
fill runs them as batches on the script pool, enters the results in the cache and runs the pass
again, until a pass asks for nothing. Cells are keyed by the code's id, the entry, the element ids,
the inputs' text and the document's text, and evicted by the keys a transition touches (the
read-set). There is no option: a service with a script host always evaluates scripts, and one
without answers `ReadError(503, 'no script host')` only when a pass needs a fill. A client that
runs scripts itself sends `X-Data-Rover-Scripts: engine-only`, and the server answers 409 `scripts
need the engine` where a request reaches a script instead of running it on committed state;
the server runs no scripts.
This ends AD-31's 501 fallback for scripts: a call that reaches one is the engine's, over the
working copy, and with no engine the app shows the state, not script results.
**Why.** The Python evaluators the engine was ported from were synchronous and the script host is not: a pass that records
what it lacks and an engine that fills between passes keep the evaluators single-sourced
and leave the model lane free of awaits. A round's batches run outside the scheduler
and its settle, which enters the results in the cache, runs in scheduler slices of 256 calls, so a
stage or a delta lands between passes, or at most one slice into a settle, and the answer reflects
it; a counter of transitions that change the model, read when a pass's scan starts and checked at
the start of the settle and after every yield, stops a result computed before a transition from
entering the cache after that transition's eviction, and a pass is answered as the state its scan
ran on, as an evaluation without scripts is. The console's snippets run on the same machinery
(`runSnippet`, CT-4) and read the working copy.
**Rejected.** Awaiting inside the evaluators: a second, asynchronous copy of each one. Dropping
the cache at every transition: a keystroke would rerun every script. A service option: it kept two
answers for one call, and the server's could not see the working copy. Admitting a result whose
read-set no transition touched when other transitions moved the stamp: it changes the stamping
invariant that keeps a stale result out of the cache.
**Consequences.** Every evaluation is a pinned fill: a call belongs to the replica its first scan
starts on, and one whose replica is closed, replaced or diverged under it, between slices
included, answers 409 (`replica closed` or `replica is not ready`) instead of restarting on the next replica; one that
arrives while no replica is ready waits for the next, as any call does. A cold evaluation that a
steady stream of transitions keeps moving is run again for every transition that lands within a
round, and answers once a round fits between two transitions: accepted, since the visible table
re-pages after an edit anyway and exports and long fills wait for edits to pause (`K-114` (10)).
The fill memo and the code-id map are unbounded within their lifetimes (`K-114`). The script-cell budget is measured through an engine export
(`K-100`).

## AD-35 · Exports without a browser run in a CLI on the caller; deferred until there is a caller
**Decision.** An export with no browser (CI, a scheduled job) runs in a Node CLI on the caller's
own machine: it authenticates with an API token, fetches the snapshot, tail, metamodel and
artifact payloads through the replica routes the shell already uses, and runs the export on the
same engine and Pyodide as the browser, its scripts in a child process under Node's permission
model. Sub-project E builds it, and only once a real caller exists; today there is no CI and no
headless use, and the former route that ran an exporter by name had no known caller.
**Why.** It needs no second deployed service and runs no untrusted Python in our infrastructure:
the server only serves the bytes a browser already downloads, and the caller pays the CPU. API
tokens, its one new server feature, are wanted for other automation anyway. Bytes equal the
browser's for the same reason as AD-3.
**Rejected.** *A headless Node service behind the server* (the former E: the server gathers the
inputs and proxies the by-name run and `/exports/run` to it, one fresh child process per run
inside a container with no network and no credentials): a second service to deploy, isolate
and pay for, and a server-side proxy, for a caller that does not exist yet. *Spawning Node from
the API process*: user code beside the database credentials.
**Consequences.** The CLI must check its version against the server's wire contracts (CT-1,
CT-2) and refuse clearly when stale, since a CLI pinned in a CI job can fall behind the server;
its releases are versioned. Its script isolation protects the caller, not us: a script written by
any project member runs next to the caller's secrets, so the child process gets no file writes,
no child processes, read access to the engine and Pyodide only, and an empty environment.
Node 22's permission model does not block the network, and Emscripten's `NODEFS` calls
`process.binding("constants")`, which that model refuses, so Pyodide does not boot under it
unshimmed *(measured, Node 22.22.3)*. The server runs no scripts and has no route that runs an exporter by name.
