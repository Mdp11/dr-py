# Backlog — client-engine program

Everything known but not done in the client-engine program: the move of computation into the
browser against a full model replica, with a thin server and a headless export host. The
target, its decisions and its build order live in `architecture/` (`program.md` for status);
this file holds only what is open. Everything else — the app as it runs today — stays in
`BACKLOG.md`.

**How to use it.** The rules of `BACKLOG.md` apply: stable ids, the same status vocabulary
(`open`, `in progress`, `done`, `won't do`), and an item closes in the commit that fixes it.
Ids are unique across both files — a new item takes the next free number of its letter in
either — so an id never needs to say which file it is in. The Python core is under the MR-3
freeze: a fix that touches `core/model`, `core/metamodel` or the model-op applier lands on
both sides with a fixture. `routes/read.py`'s route functions and
`routes/elements.py::get_element` left the freeze for FEATURES with B's fifth plan, when the
five read surfaces defaulted to the engine. `core/search`, `core/navigation`, `api/search.py`,
`routes/read.py::search_model` and `routes/artifacts.py::evaluate_navigation` stay frozen past
C's first plan flipping navigation and criteria search to the engine until C's plan 5, which
flipped `exports` to the engine: `core/table`'s evaluator and `api/routes/{tables,exports}.py`
read them only as the `tables` and `exports` surfaces' server paths now, and `api/search.py` and
the route functions are also the 501 fallback's server side (AD-31); `api/artifact_kinds.py`
validates every committed navigation payload against them. The freeze has lifted for FEATURES in
all of them and in the export writers (`core/table/{csv_export,json_export,export_layout,exporter,naming,split,cell_text}.py`,
`api/table_export*.py`, `api/export_manifest.py`), a table that reaches a script included since D's third
plan (a feature there lands in TypeScript only; the server's script path answers 409 to a client that
sends `X-Data-Rover-Scripts: engine-only`); a bug found in any of them still lands on both sides with a
fixture until F (MR-1) regardless. `core/table/resolve.py` (ref resolution and script reach) is frozen from C's
first plan on. `core/validation` minus `rules/`, `api/validation_sweep.py` and the preview's
conformance half (`routes/commits.py::preview_commit`'s model half,
`api/rules.py::attributable_issues`) are frozen for behaviour from C's plan 2 on and stay so
past its flip of `issues` to the engine: until F a feature there lands on both sides with a
fixture step, as a bug does, since the server pipeline still decides strict commits
(`attributable_issues`) and `validation_error_count`, and answers every fallback: an unreadable
rule set, an unsupported pattern, `staging: legacy` and the window before the replica's first
sweep. Two bugs landed on both sides under it: `value_conforms`'s float branch, which raised
`TypeError` on an unhashable value and now answers `False`, and the dirty hooks, which missed a
key relationship's endpoints' uniqueness groups on connect, disconnect and cascade delete until
6b3cdb6. The second widens strict mode's `base_dirty`: connecting, disconnecting or cascading
away a relationship named in a key now makes the keyed ends' old and new group members
attributable, so a strict commit that used to land can get a 422, as a key-property edit already
could. `core/validation/rules` and `api/rules.py` are frozen from C's plan 3 on, which ports them
to the engine: a bug or a feature there lands on both sides with a fixture until F.

---

## 1. Program

### R-3 · Client-engine program · `in progress`
Computation moves into the browser against a full model replica, with a thin server and a
headless export host. Source of truth: `architecture/` — decisions `AD-n`, contracts `CT-n`,
constraints `CN-n`, build order and status in `architecture/program.md`. Six sub-projects
A → F. A (engine foundation) has landed: package, value layer and golden-fixture pipeline;
Python snapshot v2 and state digest; metamodel, record-graph store, indexes and mutation
boundary; op applier and working copy; snapshot reader, the engine's own SHA-256 digest and
the benchmark at model M (`pixi run engine-bench`: open 2.3 s of the 3 s budget). B (replica
and frontend seam) is done — six plans, listed in `architecture/program.md` (exact server
state; v2 snapshot writers and the replica routes; the engine service; the sandbox site and
the shell, the replica opening and following in the background; the transport swap — the five
read surfaces default to the engine behind per-surface switches, the wait for `ready`, the
fallback notice and the retry overlay, shadow comparison in dev and e2e, and the browser
benchmark; the forked store — `staging` defaults to `engine`, the user's edits stage in the
replica's working copy, the legacy store lives behind `staging: legacy`) — and watches `K-32`.
C (evaluation) is done, its eight plans built (this paragraph tells plans 1–3): the engine holds the project's artifacts —
the committed payloads the shell fetches and follows, the staged entries mirrored from the
frontend's buffer (AD-30) — and serves navigation and criteria search over the working copy,
by default (`navigation` and `criteria` surfaces, held to the routes by fixture and by shadow
comparison); a call that reaches a pattern the regex translator cannot vouch
for is refused with 501 and answered by the server, a navigation's page marked so (AD-31); a script was
the server's too until D's fourth plan (AD-34).
C's plan 2 adds one live issue store over the working copy (AD-32) — a resumable background
sweep, incremental revalidation inside every transition, origins by a rewind probe — and
serves `getModelIssues`, `validateModel` and the model half of `previewCommit` from it, behind
the `issues` surface, which now defaults to the engine too, gated on the replica's first sweep
completing and the artifact follower's first load. C's plan 3 evaluates custom validation rules in
that store (AD-33): the server parses each rule set's YAML for the engine (`POST /rules/parse`,
`rules` beside each rule set on `GET /artifacts/payloads`), and the engine compiles, reaches and
evaluates the committed and the staged rule sets, so a staged rule set's issues show in the Issues
panel and in Validate before any commit, while the preview reads the committed rules, as the
server's does (`K-65`); an `issues` call waits for a rule-set change's rescan, and only a rule set
the engine cannot read sends it to the server (501 `reaches unreadable rules`). The plan also
lists the sweep in steps (`K-59`), caches uniqueness key texts in the engine (`K-60`'s engine
half) and tags the panel's list without a probe per keystroke (`K-61`).
The freeze rule (`MR-3`) covers `core/model`, `core/metamodel` and the model-op applier from
the start of A's second plan; `routes/read.py`'s route functions and
`routes/elements.py::get_element` left it for features once B's fifth plan flipped the
surfaces' defaults. `core/search`, `core/navigation`, `api/search.py` and the `search_model`
and `evaluate_navigation` route functions stay frozen past C's first plan's flip of navigation
and criteria search until C's plan 5 flipped `exports` to the engine, when they left the
feature freeze (`core/table`'s evaluator and `api/routes/{tables,exports}.py` read them only as
the server paths of the `tables` and `exports` surfaces now, and the export writers left it too, a script
table included since D's third plan); `api/search.py` and the route functions are also the 501
fallback's server side; `api/artifact_kinds.py` validates every committed navigation payload
against them; `core/table/resolve.py` (ref resolution and
script reach) is frozen from C's first plan on too. `core/validation` minus `rules/`,
`api/validation_sweep.py` and the preview's conformance half
(`routes/commits.py::preview_commit`'s model half, `api/rules.py::attributable_issues`) are
frozen for behaviour from C's plan 2 on and stay so past its flip of `issues` to the engine:
until F a feature there lands on both sides with a fixture step, since the server pipeline still
decides strict commits (`attributable_issues`) and `validation_error_count`, and answers every
fallback: an unreadable rule set, an unsupported pattern, `staging: legacy` and the window
before the replica's first sweep. A bug fixed during a port, or found in any of these areas
afterward, lands on both sides with a fixture until F (MR-1), whether or not the feature freeze
has lifted for that area. Two landed by C's plan 2: `value_conforms`'s float branch, which raised
`TypeError` on an unhashable value and now answers `False`, and the dirty hooks, which missed a
key relationship's endpoints' uniqueness groups on connect, disconnect and cascade delete until
6b3cdb6. The second widens strict mode's `base_dirty`: connecting, disconnecting or cascading
away a relationship named in a key now makes the keyed ends' old and new group members
attributable, so a strict commit that used to land can get a 422, as a key-property edit already
could. `core/validation/rules` and `api/rules.py` are frozen from C's plan 3 on: a bug or a
feature there lands on both sides with a fixture until F. The diff route's model half
(`api/metamodel_candidate.py`) and `build_rebind_view` are frozen for behaviour from C's plan 7 on;
`diff_metamodels` is not.
`api/serialize.py::iter_model_json` and the download route (`GET /model/download`), and
`core/view/validation.py` and the `GET /views/{id}` route that serves its warnings, are frozen for
behaviour from C's plan 6a on; the engine replays them from the `model_download` and
`view_warnings` fixtures.
D (scripts in the browser) is done, its fourth plan built: `scriptCalls` runs user Python
in Pyodide on a pool of script workers, one batch per worker, booted from a memory image; the engine
evaluates navigation script steps, table script columns, export transforms and the script-error
recap through a cell cache evicted by read-set (AD-34), with no option, and runs the console's
snippets (`runSnippet`, CT-4); a client with an engine sends `X-Data-Rover-Scripts: engine-only` and
the server answers 409 `scripts need the engine` instead of running scripts.
At M, in Chromium, 10,000 script cells take 2,284 ms prewarmed through `scriptCalls` and 2,765 ms as table
columns exported as csv, against CN-3's 3 s (`K-100`) *(measured, Chromium 148, Ryzen 9 3900X under WSL2,
median of 3, 2026-10-01 and 2026-10-02)*. Findings of those plans still open: `K-102`, `K-103`, `K-104`,
`K-106`, `K-107`, `K-108`, `K-110`, `K-111`, `K-112`, `K-113`, `K-114`, `K-115`, `T-12` to `T-15`.
Open: `K-29`, `K-32`, `K-35`, `K-36`, `K-38`, `K-41`, `K-42`, `K-45`, `K-46`, `K-47`, `K-48`,
`K-49`, `K-50`, `K-51`, `K-52`, `K-53`, `K-54`, `K-55`, `K-56`, `K-57`, `K-58`, `K-60`, `K-62`,
`K-63`, `K-65`, `K-66`, `K-67`, `K-68`, `K-69`, `K-70`, `K-71`, `K-72`, `K-73`, `K-75`,
`K-76`, `K-77`, `K-78`, `K-79`, `K-80`, `K-81`, `K-82`, `K-83`, `K-84`, `K-85`, `K-86`, `K-87`,
`K-88`, `K-89`, `K-90`, `K-91`, `K-92`, `K-93`, `K-102`, `K-103`, `K-104`, `K-106`, `K-107`, `K-108`, `K-110`, `K-111`, `K-112`, `K-113`, `K-114`, `K-115`, `T-12`, `T-13`, `T-14`, `T-15`, `C-21`, `C-22`, `C-23` in this file; `K-33`, `K-34`, `T-10` in `BACKLOG.md`.
Size: very large.

---

## 2. Diagnosed issues

### K-29 · The bulk loader accepts a relationship whose id an element already holds · `open` · *2026-09-18*
`routes/_snapshot.py`'s guards keep one `seen_ids` set per kind, so `build_model_from_dicts`
loads an element and a relationship sharing an id, while the mutation boundary
(`restore_element` / `restore_relationship`) refuses exactly that and the state digest (CT-3)
folds both kinds into one namespace — a same-`rev` pair cancels out of it. The engine's
loader refuses such a snapshot (`Relationship id 'x' is already an element id`), so a project
imported with one would open on the server and not in the browser. Fix: check the other
kind's ids in `_guard_relationship`; the file is outside the MR-3 freeze.

### K-32 · The `ord` re-sort after a rewind is watched · `open` · perf · *2026-09-18*
The first ordered iteration after a rewind that put an entity back at an old `ord` re-sorts
the whole entity map: 58 ms at M against 2 ms for a plain pass, and behind a 39 ms unstage that
is 97 ms of a transition's 100 ms budget (CN-3, AD-23) — inside it, and watched. If the browser
benchmark misses, the fix is an insert in place, or a sort kept to the entities that moved.
The rest of what this item held is done: the index build, the digest check, the roots sort
and the search now run in steps, and their longest step at M is 12, 3.8 and 5.2 ms
(`pixi run engine-bench`, Node 22, medians of 3; the index build's is 8–13 ms across passes)
*(measured)* — under the 16 ms chunk, with the index build over the 8 ms slice target.
In the browser (`pixi run engine-bench-browser`, Chromium 148, WSL2, medians of 3, round
trips through the port) a 1,000-op update batch is staged in 58 ms and unstaged in 52 ms, and
the first read after it takes 0.2 ms — an update is rewound in place; the first read after
unstaging one deleted element re-sorts in 20 ms; 100 single-op batches stage in 22 ms and a
delta rebases over them in 12 ms *(measured, 2026-09-22)*.

### K-35 · The server's v2 decoder accepts a line holding two documents; the engine refuses it · `open` · *2026-09-19*
`api/snapshot_codec.py::_decode_v2` joins the entity lines with `,` and parses the lot as one
JSON array, so a line holding `{…},{…}` parses as two entities — shifting every entity after
it, and the element/relationship split with them — while only the line count is checked. The
engine's `parseLines` refuses such a line. No writer emits one, so
nothing breaks today; a hand-made or corrupted blob could hydrate on the server and fail in the
browser. Decide whether the server should refuse it too (cost: `K-34`'s decode path, the
place to change) or whether the engine's stricter reading is enough.

### K-36 · The tail's "no entity states" test is unverified on Postgres · `open` · *2026-09-19*
`content.commit_tail_marks` treats a row as lacking `entity_states` when the column is SQL NULL
OR `CAST(entity_states AS VARCHAR) = 'null'` — a Python `None` in a JSON column is stored as
JSON `null`. The hermetic suite runs it on SQLite only; on Postgres it rests on `json → varchar`
being an I/O cast that yields the stored text. Not checked: no dev database was running when
plan 2 landed. Check once against the dev stack:
`select cast('null'::json as varchar) = 'null', cast(null::json as varchar) is null;` must
answer `t, t`. If it does not, the descriptor and the tail would call an over-cap commit
expressible and serve a delta with no entities.

### K-37 · A `model_rev` bump with no journal row is silent to a replica · `done` · *2026-09-22*
`POST /model/upload`, `POST /metamodel`, `DELETE /metamodel` and the legacy element routes
bump `model_rev` and broadcast nothing. A replica hears of them at the next delta — a gap, an
incomplete tail, a re-bootstrap — or at a reconnect. Harmless while nothing reads the replica;
once a surface does, a read between the bump and the next delta answers from before it.
Decide before a surface defaults to the engine: broadcast a header-only event from
`touch_model` and `set_model`, or have the shell re-bootstrap after its own such calls.
**Done:** the server broadcasts `{"type":"reset","model_rev"}` from `Session.announce_reset()` —
`set_model`, `touch_model` and `set_metamodel` by default, the model upload and `POST /metamodel`
after their durable writes (CT-2's **Reset**).

### K-38 · `DELETE /metamodel` writes nothing durable · `open` · *2026-09-22*
The route clears the session (`set_metamodel(None)`) and touches no row, so `ModelRow` keeps its
`metamodel_id` and `model_rev`, and an evict + rehydrate brings back what was deleted *(read from
the code, not reproduced)*. Decide whether the route should clear the rows or go.

### K-39 · A peer's rebind never refetches the structure · `done` · *2026-09-22*
A peer's commit that carries `metamodel.rebind` reaches this tab as a `rebind_event`, not a
`commit_event`, so `realtime.svelte.ts` applies no delta and bumps no structure rev, and
`onReloadRebind` (`routes/p/[projectId]/+page.svelte`) calls `replicaMetamodelAdopted()` but never
`markStructureChanged()`. When the peer's batch also created or deleted elements, the tree keeps
its old shape until the next structural delta or a reload — on the server path as well as the
replica's *(read from the code, not reproduced)*. The committer's own path bumps after
adoption (`adoptReboundMetamodel`); the likely fix is the same one-line bump in `onReloadRebind`.
**Done:** `onReloadRebind` calls `markStructureChanged()` after `replicaMetamodelAdopted()`, the
same bump `adoptReboundMetamodel` already made on the committer's own path.

### K-40 · A successful Retry does not refetch the structure · `done` · *2026-09-22*
Reads posted while the replica is `failed` are answered by the failed replica; `retryReplica()`
re-bootstraps it but bumps no structure rev, so a tree read answered before the Retry stays stale
until the next structural change. The overlay blocks the workspace while `failed`, so few such
reads exist. **Done:** `replica.svelte.ts`'s `onStatus` calls `markStructureChanged()` whenever the
previous phase was `resyncing` and the new one is `ready` — a retried `failed` replica and one the
replica re-bootstraps on its own (a diverged digest check) both cross that transition; a plain
first open (`opening` to `ready`) does not.

### K-41 · A rebind's dropped batches leave their dependents parked, unremapped · `open` · *2026-09-22*
`checkout.svelte.ts` (:589) calls the facade's `dropStagedBatches` (`model.svelte.ts:114` →
`model-engine.svelte.ts`'s `dropBatches`) to unstage a rebound commit's own batches by id,
since the frozen replica never applies its delta. Each `unstage {batch}` is a rebase: a LATER
staged batch that named one of the dropped batches' temp ids (an update or a connect referring
to an element the dropped batch created) parks as a conflict right there, in the frozen
replica, and stays parked through the re-bootstrap — a plain commit's `applyDelta` would have
remapped it through `id_map` (`engine/src/working/working-copy.ts:596`), but a rebound commit's
delta is never applied, so that remap never runs. Fix: remap the dependents' temp ids through
the rebound response's `id_map` before (or instead of) dropping the batches that minted them.

### K-42 · An edit that survives a commit flight can lose its lease · `open` · *2026-09-22*
Two ways a lease outlives the POST wrongly:
(i) **Sent, and a later edit rides on it.** `checkout.svelte.ts`'s token partition
(:549-555) keeps back only a token whose resources are all `art:` ones the batch does not
need; every other token — every element and folder token — is sent unconditionally, whether
or not the batch needs it (an element is typically leased because the committed batch edits
it), and the server releases exactly what it is sent (`routes/commits.py:1376-1379`). The gap
is an edit staged DURING the POST on an element whose token is sent (a batch of its own, per
CT-2): it rides on a lease the commit gives up, so once the release lands, the still-staged
edit is left without one, and its next commit may 409 "required lock not held" until the
element is touched again (which re-acquires it). The same happens to a proposal (a snippet
or CR Stage) that took its locks before a commit landed and staged its ops after.
(ii) **Acquired during the POST, forgotten anyway.** A lease taken out WHILE the POST is in
flight is in neither `sent` nor `kept` (both computed from `getHeldTokens()` before the POST);
the answer handler's cleanup (`checkout.svelte.ts:611-613`) deletes every registry entry whose
token is not in `kept` — including that one — so the client forgets a lease the SERVER still
holds. The next commit omits the token, `verify_held` (`routes/commits.py:978`) 409s "required
lock not held", and the heartbeat (which only renews registered tokens) may let the lease
expire on the server too.
Fix direction that covers both: after a commit lands, re-acquire leases for whatever is still
staged (case i) and never forget a token the cleanup didn't itself send (case ii).

### K-43 · A property update always coalesces into the first staged batch of that id · `done` · *2026-09-22*
The engine always merges a single property update (`emit`, or `emitMany` with ONE op) into the
first staged batch already holding an update of the same id, including a batch that is
mid-commit — by design (AD-29: predicting a new batch id would drift the mirror), which would
otherwise let a keystroke land inside a batch already sent and be dropped with it if refused.
**Done:** the DiffDrawer stays undismissable — no Escape, no outside click, no close button
(`DiffDrawer.svelte`) — through the POST and, once it lands, until `commitApplied()` resolves
(`checkout.svelte.ts`), not just until the POST answers: `commitApplied()` now waits for the
replica to have actually APPLIED the commit's own delta (`commitsLanded()`), so an edit typed
while the drawer is still open can no longer land in a batch that is committed but not yet
drained (10bfc0c). A `failed` replica used to drop the user's own commit answer along with
everything else on its queue and refuse new ones, so a retry's re-bootstrap re-adopted the
committed batches and nothing dropped them (a committed create staged again); going `failed`
now keeps the user's own answer and accepts new commits, and the rebuilt replica applies the
kept answer on its first drain, so `commitApplied()` no longer needs to wait through a retry
(6a5fa93). `stageProposedOps` still waits for `commitsLanded()` before staging a proposal.
Two residual windows remain — `K-44`.

### K-44 · Two windows still let a coalesced edit merge into a committed batch · `done` · *2026-09-23*
Left after `K-43`'s fix (`commitApplied()`, `checkout.svelte.ts`): (a) a rebind that freezes
the replica between the POST answering and the replica applying it ends `commitApplied()`'s
wait early — the drawer closes — and keeps the answer queued until the new metamodel is
adopted; an update staged in that window can still merge into the committed batch and be
dropped when the queued answer finally applies. (b) At a Retry, a transition is HELD while
`failed` (`sync.ts:331`'s `admits()` is true only for `ready`/`frozen`, matching `frontend/src/lib/engine/README.md`), so
nothing reaches the engine while the overlay is up — but `sync.ts`'s `set({phase: 'ready', …})`
(:602) calls `examine()` (:312-316), which releases every held transition, BEFORE the same
function calls `pump(r)` to drain the kept own answer: a held edit that COALESCES into the
adopted committed batch (an edit staging as its own new batch survives) reaches the engine
first and is dropped when the answer drains right after it. The failed overlay being non-inert
(nothing stops a keystroke reaching a still-mounted property field behind it) is what lets an
edit queue up to be released this way, not `admits()` itself. Candidate fixes: drain the kept
own answer before releasing held transitions at `ready`; hold transitions while an own answer
is still queued; or make the failed overlay inert. Decide whether either window is worth
closing or stays a known limit.
**Done:** the model store marks a landed commit's batches COMMITTED the moment the POST
answers (`markLanded`, `model-engine.svelte.ts`) and DEFERS a single property update the engine
would merge into one of them (the first staged batch holding an update of that entity): cached
and shown at once, it is posted — with every edit made after it, in order — only once a mirror
read shows the replica has dropped that batch. Both windows are closed for an edit made after
the answer settled: (a) the frozen replica drops the batch at adoption and the deferred edit
stages after; (b) a deferred edit is never handed to the sync, so `ready`'s `examine()` has
nothing of it to release before the drain. While the answer waits, a new commit is refused
(`CommitPendingError`, the sync's `ownPending()`), and `Cmd/Ctrl+S` opens no drawer while the
replica blocks the workspace.

### K-45 · A worker that dies while a commit's answer waits leaves its dependents unremapped · `open` · *2026-09-23*
A re-bootstrap that finds the worker gone adopts the model store's copy of the staged batches
(`handOverStaged`, `model-engine.svelte.ts`), which leaves out the batches of a landed commit
whose answer the replica has not applied yet — correctly, since the engine is gone and the
store cannot tell whether it had applied the answer. The answer, applied later, is then a
`duplicate` naming no batch the new replica holds, so it remaps nothing
(`engine/src/working/working-copy.ts:471`): a later staged batch naming a temp id that commit
minted (an update of, or a connect to, an element it created) parks as a conflict instead of
being rewritten to the server id. The window is a worker death between a commit landing and
the replica applying its answer — a moment while `ready`, until adoption or `retry()` while
`frozen` or `failed`. Fix direction: have the sync hand back the committed batches whose own
answers it still holds (it knows the queue) instead of the store leaving them all out.

### K-46 · A dropped own answer posts a deferred edit into the batch it drops · `open` · *2026-09-23*
When the replica's drain fails twice on the user's own `applyDelta` with an error other than
`EngineGoneError`, `sync.ts` (:1013) calls `forget(r, [input])` (:417), whose `onAbandoned`
reaches `forgetBatches` (`model-engine.svelte.ts:934`). That takes the commit's batch B out of
the mirror and calls `postDeferred()` (:949): an update deferred because it would merge into B
no longer finds B in `_batches` (`mergesIntoCommitted`, :1116) and is posted at once — while
the replica is still `ready` and still holds B. The engine merges the update into B, the
`ask()` right after re-bootstraps, and the re-bootstrap leaves B out through `r.abandoned`,
so the update is lost with it. Reached only through an own delta failing twice with a
non-`EngineGoneError` error while an edit is deferred. Fix direction: `forgetBatches` does not
post the deferred edits while the replica may still hold the forgotten batches; they go at the
next `ready`, as `onStatus` already reads the mirror there.

### K-47 · Two paths drop an own answer without forgetting its batches · `open` · *2026-09-23*
`sync.ts` drops the user's own commit answer without `forget` in two places: `handle`'s
retried-gap branch (:1039-1042, `ask()` and return) and `requeue`'s silent return when
`waits(input)` is false (:969), reachable when the replica goes `off` while an own delta is
being handled. The commit's batches stay in `r.held`, the next replica adopts them, the model
store keeps them out of its readers through `_landed` — and nothing ever drops them from the
replica. A same-entity property update then stays DEFERRED for good (`mergesIntoCommitted`
keeps finding the committed batch): shown in the Inspector, absent from the engine's diff, and
left out of every commit, which `stagedSettled()` no longer waits for. Fix direction:
`forget(r, [input])` on both paths, as the drain's second failure does.

### K-48 · Three rare windows around a landed commit's batches · `open` · *2026-09-23*
(a) **A keystroke during the POST behind the failed overlay.** An edit made while the commit's
POST is in flight and the replica is `failed` is handed to the sync before the store knows the
batch is committed (`markLanded` runs when the POST answers), so it is held, not deferred; at
`retry()` the held transition is released at `ready` before the kept own answer drains, merges
into the committed batch and is dropped with it — `K-44`(b)'s mechanism, narrowed to the
POST's own duration. The modal DiffDrawer and the `Cmd/Ctrl+S` gate make it very hard to
reach. (b) **`unstage {entity}` can strip a committed batch.** While `frozen` or `failed`, the
drawer's per-element discard of a newer edit on an element a committed batch also touches
posts `unstage {entity}`, which takes that element's ops out of the committed batch in the
engine too; the commit already landed, so nothing is lost on the server, but the replica's
batch no longer matches what its answer drops. (c) **The committed-diff filter follows
containment source → target only.** `committedOnly` (`model-engine.svelte.ts:881`) derives a
committed delete's cascade along containment from source to target and keeps back only what a
newer staged op NAMES; an element that both a committed delete and a newer staged delete
cascade into is named by neither, so it can be hidden from the drawer. The commit still
carries exact ops. Decide per window whether it is worth closing or stays a
known limit.

### K-49 · A peer's new navigation can be named before its payload reaches the engine · `open` · *2026-09-24*
The shell's artifact follower (`frontend/src/lib/engine/artifacts.ts`) fetches a peer's
created or updated artifact when its `artifact` feed event arrives, and the artifact list the
editors offer takes the same event at once. A navigation that names the new artifact in the
moment between the two is answered 422 `unknown navigation artifact 'x'` by the engine where
the server finds it; the preview shows a failed run until the next edit re-runs it. The
startup window is closed: the `navigation` surface is the server's until the follower's
first `load()` lands (`loaded()`, a gate on the engine seam), a failed load is asked once
more after a second, and a shadow re-test waits for the follower's fetches (a quiet probe),
so this window cannot log a false `[shadow]` line. Decide whether an evaluation should wait
for the fetches out, or the window stays a known limit. It is also AD-31's known gap: a
preview whose first page came from the server before the follower's load and whose "Load
more" runs after it can mix committed and working state, and with staged model edits a chain
can then be duplicated or skipped.

### K-50 · A staged artifact edit can miss a read issued in the same synchronous run · `open` · *2026-09-24*
`stagedChanged()` defers its push of the composed overlay to the engine by a microtask
(`frontend/src/lib/engine/artifacts.ts:183`), while `sync.call` posts a read to the engine at
once whenever it is ready. During a commit's refresh, an artifact staged meanwhile reaches the
engine only when the refresh lands. Now that a commit's creates are aliased under their real
ids during that refresh (`bcae61e`), the hold may no longer be needed. Fix direction: push the
composed overlay during the hold too, and add a test that a read issued right after
`stageArtifactUpdate` sees the staged update.

### K-51 · `setArtifacts` in a `now` handler can exceed the chunk budget · `open` · *2026-09-24*
`engine/src/artifacts/artifact-set.ts:70-82` stringifies and parses the whole artifact list at
once, and `now` handlers run inside one host turn (CN-3's ≤16 ms). Measured cost is about
5 ms/MB without floats, and 30–50 ms/MB once any payload holds a float, because the whole list
then goes through the exact parser: 2.8 MB of snippets plus one `1.5` took 74–102 ms. Every
project open pays this twice — `startReplica`'s `load()` and the first feed `snapshot`'s
`load()` both fetch and set all payloads. Fix direction: read and set per artifact, and drop
the duplicate initial load.

### K-52 · Superseded navigation previews are never cancelled · `open` · *2026-09-24*
`evaluateNavigation` passes no `AbortSignal` (`frontend/src/lib/api/artifacts.ts:72`), so each
debounced auto-run while editing a definition queues a full model-lane scan that runs to
completion even after a newer edit supersedes it. Fix direction: abort on the editor's
generation bump, as B's scans do.

### K-53 · The artifact follower's fetch chain has no timeout · `open` · *2026-09-24*
`frontend/src/lib/engine/artifacts.ts:125-134` awaits `/artifacts/payloads` with no timeout.
One hung request stalls every later feed event and refresh, and the staged mirror with them if
a commit's hold sits behind it. Fix direction: a fetch timeout, or a way for a later fetch not
to wait on a stuck one holding the staged mirror.

### K-54 · A pattern fallback in Advanced Search reads committed state silently · `open` · *2026-09-24*
`frontend/src/lib/api/model-read.ts:134-150` falls back to the server for a pattern the engine
cannot vouch for, with no mark on the result. A user with a staged rename gets different
results depending only on the regex syntax used, with nothing telling them the run read
committed state. Fix direction: a one-line note like the navigation dock's `nav-fallback`.

### K-55 · The criteria warm-up can freeze the worker on a catastrophic pattern · `open` · *2026-09-24*
`compileCriteria`'s warm-up (`engine/src/search/criteria.ts:244-245`) runs every translated
pattern before the first step. A catastrophic-backtracking pattern (e.g. `'(?:a?|b?)'` repeated
22 times plus `'x'`) freezes the worker for about 4.5 s, and the scheduler has no way to
interrupt a warm-up run. Fix direction: bound or step the warm-up.

### K-56 · `sendArtifacts` swallows an engine refusal silently · `open` · *2026-09-24*
`frontend/src/lib/engine/sync.ts`'s `sendArtifacts` drops an engine refusal without surfacing
it, so an engine holding no artifacts can still look "loaded". Fix direction: a dev-mode
`console.error` on refusal.

### K-57 · `py_coerce`'s `to_number` rows miss several `toNumber` branches · `open` · *2026-09-24*
The fixture's `to_number` rows lack a plain int, a finite bigint, a float, a dict, `""` and
`"   "`, so those branches of `toNumber` (`engine/src/value/coerce.ts:110-128`) have no oracle
row. Fix direction: add the inputs to `tests/golden/scenarios/py_coerce.py` and regenerate.

### K-58 · `change_request_dirty_ids` is dead outside tests and shares the key-relationship dirty gap · `open` · *2026-09-24*
`change_request_dirty_ids` (`src/data_rover/core/validation/dirty.py:355-434`) has no
production caller at HEAD: apply-CR has proposed an op batch since `be3bcb9` (pre-dating this
branch), translated by `api/change_request_ops.py::ops_for_change` and staged and committed
like a manual edit, through the ops route's hooks — the same ones 6b3cdb6 fixed. Only
`tests/validation/test_dirty.py:246` and `tests/validation/rules/test_reach.py:363` still call
it, and it still adds a relationship's endpoints' uniqueness groups only when the relationship
type is containment (the same gap `after_connect`/`before_disconnect`/`after_element_delete`
had before 6b3cdb6 fixed them for staged ops), so any caller that appeared would leave the
issue store holding a duplicate that is gone, or missing one that appeared, after a CR built
through it applies. Fix direction: fix it — mirror 6b3cdb6's hooks, adding the keyed other
ends' old and new groups for every added, modified or deleted relationship of a keyed type —
or delete it with its two tests. Either way, `dirty.py:41-44`'s module docstring, which still
calls it the CR-apply path, goes with it.

### K-59 · The sweep's first step, and a browser slice while sweeping, exceed their budgets · `done` · perf · *2026-09-24*
`LiveIssues.sweepSteps()`'s first step lists every element id then every relationship id in
one unit: 13 ms at M (`pixi run engine-bench`, 15 ms on the first pass) against the
scheduler's 8 ms slice target, and up to 8 ms of other units can precede it in the same slice.
In the browser (`pixi run engine-bench-browser`) the longest slice while sweeping is 21 ms
(21, 23, 21), past CN-3's 16 ms chunk; the bench's two ping loops overlap
(`frontend/bench/main.ts:521-532`), so that row may also count digest-check slices. Every
other sweep step is 5.8 ms at most once warm (11 ms on the first pass). The whole sweep, ready
to seeded, is 767 ms in the browser. Fix direction: list the ids in steps too (an
`ord`-ordered walk that resumes), then separate the bench's two ping loops before reading the
row again. Not optimized yet: the owner's rule is to report before optimizing.
**Done:** the sweep walks the model in steps: its first step only takes the total, and each
later one pulls the next 512 entities it has not validated yet from a live iterator per map,
passing over those it has (a set of the ids it validated), at most 16 × 512 a step; the
iterator is taken again when a re-sort moves `Model.orderEpoch`. `done` stays short of the
total until the last step. The bench's two ping loops are separated:
one until the digest check ends, a second from then until the sweep ends. At M (`pixi run
engine-bench`, medians of three passes, before → after): the first step 13 → 0.0 ms, the longest
step after it 6.0 → 10–14 and the whole sweep 843 → 986–1,035 (two runs on a loaded machine).
The set of validated ids costs that: growing a `Set` to 300,000 ids alone takes 40–80 ms, and
the rehash near 262,144 ids 8–20 ms in one step, which puts the longest step past the 8 ms
slice target; not optimized. In the browser, before the set was added: the longest slice while
sweeping, the check ended, 9.7 → 9.7 ms; the longest during the check, the sweep's first steps
among them, 12 → 11, and its moment 26 → 151 ms after ready. The walk ends as long as each
step's 8,192 skips outrun what lands behind the iterator between two steps: a probe's or a
rebase's replay appends one entry per staged create, a re-sort the whole map again. With the
set, in the browser (a cloud container, Chromium 141's headless shell, so not comparable to the
rows above, 2026-09-25): the longest slice while sweeping 13 ms (16, 13, 11), inside CN-3's
16 ms chunk, the digest check's 15, and the sweep 1,219 ms from ready to seeded. The browser
bench holds no rule set; in Node on the same machine the sweep with the bench's five rules is
1,163 ms, its longest step after the first 12 (16, 12, 11).

### K-60 · The server walks a whole duplicate group per call · `open` · perf · *2026-09-24*
The Python core keeps each element's key (`uniq_key_of`) and groups by it, so it serializes
nothing per call, but it still walks the whole group: the scoped uniqueness validator finds
each scoped member's primary by a `min` over the group (`validators/uniqueness.py:54`), so a
scoped run over k members of a group pays O(k × group) — the server's sweep once per chunk —
and `DirtyCollector.add_uniqueness_group_of` sorts the group on every call, so a commit or an
ops batch that touches one member pays O(group log group) inside its write. Fix direction: the
primary once per group and run, as the engine's validator finds it; `core/validation` and
`core/model` are frozen (MR-3), so it waits for the freeze to lift.
**Done for the engine,** whose `uniqGroupOf` re-keyed every member of the bucket on each call
(a `pyKey` serialization each, about 27 ms per sweep step over a 20,000-member group):
`IndexSet.keyText` caches the text of every member of a bucket of two or more, written as an
element is filed and refreshed by every rekey, and `verifyConsistent` holds it to a rebuild's.
At M, with 20,000 copies of one element staged: `uniqGroupOf` over the group 23 → 1.7 ms, the
sweep's longest step 39 → 7.9 ms and the sweep 1,956 → 989 ms (12–13 and 1,170–1,205 once the
sweep tracks its validated ids, K-59); a 1,000-op stage through the
store 82 → 54 ms (with the bench rules' reach 81 → 58).

### K-61 · Every issue refetch with a large staged set runs a probe · `done` · perf · *2026-09-24*
`getModelIssues` and `previewCommit` read `origins()`, which probes (rewinds and replays every
staged batch) once per `(rev, stagedVersion)`. Each staged edit moves `stagedVersion` and
then `issues_version`, so each 300 ms refetch probes again: about 27 ms per 100 staged batches
at M, inside a model-lane transition that holds reads behind it. Fine at today's staged sizes;
a user holding thousands of batches pays it on every keystroke's refetch. Fix direction: a
probe incremental in the batches that moved (the top ones, for an edit that coalesces or
stages on top), or a refetch that skips the probe when only the list, not the origins, is
read.
**Done:** `getModelIssues` tags through `LiveIssues.tagScope()`: the owners an exact probe
dirtied, with their committed issues, then every id a transition dirties, with the store's
issues from just before it revalidates them, kept while the store is seeded and settled, the
rev and the rule sets hold and the working rules are the committed ones; otherwise it probes.
`previewCommit` and `validateModel` keep the exact probe. At M, the list read after a keystroke
merged into the latest staged batch: 100 batches 7.6 → 0.0 ms, 1,000 batches 258 → 0.0 ms.

### K-62 · A server issue list fetched with the gate closed can land after the engine's · `open` · *2026-09-24*
`refetchIssues()` issued while the `issues` gate was closed goes to `GET /model/issues`; when
the gate opens meanwhile, the refetch it schedules is answered by the engine, and a slower
server answer can land after it. `adoptIssues` accepts an equal `model_rev` (the server's own
sweep grows its store without moving the rev), so the server's committed list overwrites the
engine's — a staged edit's `uncommitted` issues vanish — until the next `issues_version` move
refetches. Fix direction: a refetch sequence number in `model-shared.svelte.ts`, adopting only
the answer of the latest refetch asked.

### K-63 · Past the 5,000-issue cap a staged edit's own issues can fall off the list · `open` · *2026-09-24*
`issueListBody` truncates at `ISSUES_RESPONSE_MAX` (5,000) in store order, and every
transition re-files its dirty owners last, so on a store past the cap the staged edit just
made lists its issues past the cut: `counts` has them, the panel does not. The server
truncates its own store's order, a different subset, which is why the dev shadow skips a
`truncated` list's `issues`. Fix direction: when truncating, list the probe's `S` owners (the
staged edits' dirty set) first, then the rest in store order.

### K-65 · The preview ignores a staged rule set that a strict commit enforces · `open` · *2026-09-25*
`POST /commits/preview` validates with the session's COMMITTED rules: a staged rules artifact
contributes nothing to it (`routes/commits.py:595-598`), while `POST /commits` recompiles with
the batch's rule sets before it validates and its strict gate counts every `rule:` issue in
the scope. So on a strict project, staging a rule set that fails on existing elements, the
preview says the batch lands and the commit answers 422. The engine mirrors the server's
preview on purpose (AD-33), so both sides give the same wrong promise. Fix on both sides with a
fixture: the preview compiles the staged rule sets, and its dirty set adds their
`applies_population` over the old and new compiles, as the commit's does.

### K-66 · A peer's rules commit reaches the engine as a model delta first, its payload after · `open` · *2026-09-25*
The commit's delta arrives on the feed and is applied at once; the changed rule set arrives
later, through the follower's payload fetch for the artifact event. In between, the engine
answers issue reads with the old rules while the server already has the new ones, so a
dev-shadow `[shadow]` line is possible in that window. An own commit whose parses have landed
does not open it: the follower puts the rule sets the commit created or updated into the
engine's committed layer when the commit is announced. One committed while its parse is still
out does — Save, then commit within one `/rules/parse` round trip: the rule set goes into
neither layer until the payload refresh lands, so a create shows no rules and an update keeps
the old committed ones meanwhile — and so does a follower load in flight at the commit, whose
answer drops the committed rule set until the refresh. A single user can reach both, an e2e
too. `/model/undo` of a rules commit reaches the engine as a peer's does (a delta, then an
artifact event). Fix direction: hold the delta until the payloads of the artifacts its commit
names have landed, or have the feed's commit event carry the changed rule sets' parses.

### K-67 · A YAML scalar PyYAML cannot construct escapes `parse_rule_set` as a bare `ValueError` · `open` · *2026-09-25*
`core/validation/rules/schema.py::parse_rule_set` catches `yaml.YAMLError` and `RecursionError`
only, but PyYAML's constructors raise a plain `ValueError` for a scalar their tag cannot build
— an impossible date (`x: 2001-13-45`), an explicit `!!float abc`. It escapes unwrapped, the
app's `ValueError` handler answers 422, and `POST /rules/lint` and `POST /rules/parse` both 422
where they should answer 200 with `ok: false` and one error. The rules editor reads lint's 422
as "Rule set is too large to lint" (the only 422 it expects) and blocks Save; a staged rule set
holding such YAML (saved inside the lint's debounce) stays `'pending'` in the engine, since the
shell counts a failed parse as not landed and asks again only at the next staged push. Fix:
catch the constructor's `ValueError` in `parse_rule_set` as a `RuleSetError`, with a test on both
routes; a bug fix, so the freeze allows it, and the engine, which reads no YAML, does not change.

### K-68 · A legacy `PUT`/`DELETE /artifacts/{id}` on a rule set splits the engine from the server · `open` · *2026-09-25*
The legacy artifact routes leave `session.compiled_rules` alone on a `validation_rules` write
(`routes/artifacts.py`'s module note): the server keeps the old rules until the session is
evicted and rehydrated. They emit the same `artifact` feed event as a commit, though, and the
follower fetches the payload with its parse and hands it to the engine, which recompiles and
rescans at once. From then until the rehydrate the engine's issue list, `rules_status` and the
model half of its preview use the new rules while the server's use the old, so the two answer
differently and a dev-shadow `[shadow]` line is possible. The frontend never calls those routes;
only a script or a second client does. Fix direction: the routes recompile and re-splice as
`POST /commits` does (the module note says why recompiling alone is worse than neither), or
the event marks the write so the follower leaves the committed rules alone until a load.

### K-69 · A table sort compares numbers through `float()` · `open` · *2026-09-25*
`core/table/evaluate.py::_script_sort_atom` ranks a number or bool by `float(item)`. An int past
≈ 1.8e308 raises `OverflowError`, so sorting a column that holds one answers 500. An int past 2^53
rounds, so two distinct ints can tie. A `NaN` compares false with everything, so a column that
holds one has no defined order. C's plan 4 ports the table sort mirroring all three rather than
fixing them on one side (`Number(bigint)` rounds the same way and throws past `Number.MAX_VALUE`),
and keeps `NaN` atoms out of the golden fixtures. Fix direction, on both sides with a fixture:
compare ints exactly, never through a float, and sort a `NaN` atom last.

### K-70 · With the `tables` surface itself on the server, an artifact-only commit that changes a referenced navigation does not re-page an open table · `open` · *2026-09-25*
`table-editor.svelte.ts`'s `onCommitEvent` handler only calls `handleTableModelRevChanged` when
the feed event's `scope` includes `'model'`, on the premise that "an artifact-only commit
changes no model content and invalidates none of the server's cell-evaluation caches." True for
the server's per-cell cache, but not for a table whose row source or a column navigates through
a REFERENCED navigation artifact (a `ref`, not an inline definition): a peer's commit that only
updates that navigation changes what the table computes, yet moves no `model_rev`, so an open
table keeps showing the old rows until an unrelated model-moving commit or a reload happens to
refresh it. `handleTableModelRevChanged` itself only runs when `engineSide('tables') ===
'server'` — the `tables` SURFACE switch, not a per-table thing: a table the engine has refused
(a script column, say) still re-pages correctly, because `followTables`/`scheduleTablesRepage`
re-page every open table on any `artifacts_version` move through `changed`, and that runs
whenever the surface itself is on the engine, independent of which individual tables happen to
fall back. So the gap is narrower than "server-served tables": it exists only with the `tables`
switch itself set to `server`, or with no engine at all (the sandbox refused to start — the
workspace's dismissible fallback notice, and every surface reads from the server). Fix
direction: re-page on an artifact-scoped commit too, or narrow the server path's cache
invalidation to cover a referenced artifact's navigation ids the way the engine's `ArtifactSet`
already does.

### K-71 · Installing rules is one unsliced `now` unit · `open` · perf · *2026-09-25*
`Service.moveArtifacts` compiles the working and committed rule sets and, on a change, calls
`live.setRules`, which walks `appliesPopulation` over every element of the old and new rules'
applicable types to seed the rescan queue — all inline, in the one `now` call `moveArtifacts`
runs from (artifact methods never slice). Measured at M in the browser (2026-09-25,
Chromium 141): rules install + rescan 372 ms, its longest slice 50 ms — over CN-3's 16 ms step
budget, on a project whose rules happen to change on load or on a peer's rules commit. Not
optimized here; the owner schedules it.

### K-72 · An element-typed property column reading a dict or list item raises, expand or collapse · `open` · *2026-09-25*
`core/table/cells.py::_element_ids` does `dict.fromkeys(items)` to de-duplicate the reached
references; `items` is the raw property value itself, or its list unwrapped. Three call sites
reach it: `expand_property_values` (an `expand` element-typed property column, `:170`), the
single-element collapse branch when the value is a list (`:247`), and the many-element collapse
branch's joined values (`:255`) — so a property declared element-typed whose actual value is a
`dict`, or a list holding a `dict` or another `list`, raises whether the column is `expand` or
`collapse`, over one element or many. `dict.fromkeys` hits the unhashable key and raises a bare
`TypeError`, which the route turns into a 500. The engine's `elementIds` (`table/rows.ts`)
mirrors it on purpose, throwing the same `unhashable type: 'list'`/`'dict'` message — an
unrefused 500 there too. Fix direction, on both sides with a fixture covering all three call
sites: treat a non-string, non-id item as a plain value (through `cellText`) instead of assuming
every element-typed item is an id.

### K-73 · Every open table tab re-pages on each staged change, hidden ones included · `open` · perf · *2026-09-25*
`table-editor.svelte.ts::repageOpenTables` re-pages every table tab that has evaluated once the
replica's staged state moves, whether or not the tab is the one on screen. A staged edit moves
the order cache's stamp (`rev`, `staged_version`), so each re-page misses it and rebuilds and
sorts the table: at M, the gate's table costs ~190 ms of model-lane work per tab on a miss, and N
open tabs queue N of those behind every pause in the user's typing, delaying every read and
transition behind them. Fix direction: re-page only the visible tabs and mark the others stale,
as a suspended tab already is (`_suspendedStale`), re-paging a stale tab when it is shown.

### K-74 · The degraded export path is unreachable in the engine · `done` · *2026-09-28*
The server's export writers have a degraded path: a script cell that is not computed writes a
notice row, the text `#ERROR: not computed` (xlsx and CSV) or `{"$error": …}` (JSON), and an
exporter run's manifest says `degraded: true`. The engine refuses a table that reaches a script
(`501`, answered by the server behind the `export-fallback` marker), so it never has an
uncomputed cell to write. The engine does not port the degraded path itself: it has no notice
row and no `not computed` text, and `degraded` is fixed at `false` (`engine/src/export/run.ts`);
only the generic per-cell error text exists (`#ERROR: <message>` in `engine/src/table/cell-text.ts`,
`$error` in `engine/src/export/json.ts`). Closed by D's fourth plan without a port: the engine
evaluates a script table's cells to values or errors before it writes, so it never has an uncomputed
cell, and the 501 that sent such an export to the server is gone. The server's degraded path serves
only a run by name with no engine.

### K-75 · `/tables/export` sends its `Content-Disposition` name as the artifact's own · `open` · *2026-09-28*
Server only, and older than the engine path. `routes/tables.py::export_table` names a
single-file download after the table artifact (`name`, or `table` for a draft) and
`table_export_engine.content_disposition` puts an ASCII name between quotes as it is. Commit
5060552 made a name outside ASCII travel as RFC 5987 `filename*` beside a Latin-1 fallback, so
the non-ASCII case no longer fails, but neither path sanitizes the name: an ASCII name's `"`
ends the quoted value early and its control characters, path separators and `;` reach the header
as they are, and the non-ASCII path's Latin-1 fallback keeps `"` and control characters too. Exporter runs pass their zip stem
through the naming sanitizer; this route does not. Fix direction: run the artifact's name through
`sanitize_stem` (or escape the quoted value) before it reaches `content_disposition`; the engine
mirrors whichever the server does, with a fixture.

### K-76 · The server's xlsx writes two kinds of string as markup, not text · `open` · *2026-09-28*
`api/table_export.py` writes (through xlsxwriter) a string cell that starts with `{=` and ends with `}` as an array
formula, and one that starts with `<r>` and ends with `</r>` as unescaped rich-string markup, which corrupts the workbook. The
engine's writer writes both as plain strings, so on such a cell the two sides differ; xlsx bytes
are not compared (the shadow compares an xlsx by name and type alone), and the parity fixtures
hold no such cell. Two-sided bug: the owner decides whether the server writes plain strings, after
which a fixture holds one cell of each kind.

### K-77 · The engine's zip writer refuses what needs zip64 · `open` · *2026-09-28*
`engine/src/export/zip.ts` writes the classic layout only, so `zipSteps` refuses with 422 an
archive of more than 65,535 members (`export too large for a zip: N files (at most 65,535)`,
before its first step) or one where a member, the members' local part or the central directory
passes `0xFFFFFFFE` bytes (`export too large for a zip: over 4 GiB`, once deflated), where
Python's `zipfile` writes zip64 records and the server answers the file. A single split export
cannot reach the count (at most 50,000 partitions), but an exporter run with several split
entries can. Fix direction: write the zip64 end-of-central-directory records and extra fields
past the limits, and fixture a run over 65,535 members.

### K-78 · A 50,000-partition split export spends about 145 ms in one step · `open` · perf · *2026-09-28*
`exportFilesSteps`'s split branch (`engine/src/export/route.ts`) partitions the rows
(`splitPartitions`), labels every partition (`partitionLabel`) and names them
(`renderFilenames`, `engine/src/export/split.ts`) in one step: the split zip's longest step at
M, 146 ms (median of 142–176) with 50,000 uniquely named partitions. The dedupe inside is linear
(`TakenNames`); `renderFilenames` alone takes about 70–80 ms at 50,000 partitions, unique or
all of one name. Fix direction: slice the partitioning and naming, as the row rendering and
the zip writing are.

### K-79 · One engine service test is flaky under load · `open` · *2026-09-28*
`engine/test/service/issues.test.ts` "restarts a digest check in flight…" timed out at its 5 s
limit in 1 of 4 full `engine-test` runs at a load average of about 25, and passed alone and in
the other three. Fix direction: find what the test waits on that a loaded host stretches, and wait
on that signal instead of the clock.

### K-80 · The server's `/metamodel/diff` stays O(model) under the write mutex, open to viewers · `open` · perf · *2026-09-29*
With the `metamodel` surface on the engine, the editor's Preview no longer reaches
`POST /metamodel/diff` and a rebound commit's preview no longer reaches `POST /commits/preview`
with the rebind, but both routes stay: they are the fallback (a `gone` engine, a lint that gives no
document, the 501 pattern and rules answers, the moved 409s) and the shadow's oracle. The diff
route still validates the whole model under the candidate (`candidate_issues`) inside the write
mutex, so it is O(model) there, and a viewer may call it (`model_half` itself runs after the
mutex). Fix direction: none before F, which retires the server's evaluation; until then a caller
outside the shell (a script, a peer) can hold the mutex for seconds, and a role check or a
whole-model budget on the route is the stopgap.

### K-81 · "Includes staged changes" can show over a preview the engine did not answer from the working copy · `open` · *2026-09-29*
The editor records `metamodelIncludesStaged()` with the preview when its answer lands
(`previewIncludesStaged`), so a stage or an unstage after it no longer moves the note
(`metamodel-staged-note`). The flag still reads the side the `metamodel` surface has, not the
side that answered: it shows over a preview that fell back to the server (a `gone` engine, a
moved 409, the rules 501), whose `/metamodel/diff` reads committed state only.
`exportsIncludeStaged()` reads the state now for the export note, so it has both gaps. Fix
direction: stamp the answer with the side and the `staged_version` it was computed at, and show
the note from the stamp for both notes.

### K-82 · The candidate scan's last block runs the whole diff, and its browser slice is 27 ms · `open` · perf · *2026-09-29*
`engine-bench-browser` at M (Chromium 148, WSL2, 2026-09-29): `candidateIssues` 775 ms with a
longest slice, bounded from outside by the ping loop, of 27 ms; the open (51 ms) and the rescan
(36 ms) rows exceed 16 ms too, so the candidate is not the only row over. In Node
(`engine-bench`, 2026-09-29) the longest scan step is 9.3 ms, but the service answers from the
scan's last block, which runs `candidateDiff` (or `rebindPreviewBody`) whole after the last
step: O(store + candidate issues). Over M's issue-free store the diff is 9.3 ms (the rebind body
1.2 ms) and the longest block 9.5 ms; over `engine-parity-large`'s violated store (18,523 issues,
26,096 under the candidate) the diff alone is 60–69 ms over two runs (the rebind body 5 ms), one
block with the last step. So the true longest block of a preview over a store with issues is the
diff, not a step, and the browser row over M's empty store does not show it. Fix direction: once the owner has seen the numbers, step
the diff (both maps are built in passes that can yield) or move it after the scan's last
comparison into its own steps, and measure the browser row over a store with issues.

### K-83 · A server answer returned inside an engine call is shadow-probed with an empty method · `open` · dev · *2026-09-29*
When an engine body answers with the server's own preview (a rebind blob the lint refuses, an ok
lint without a document), the shadow is handed the server's value as the engine's and asks the
server again, with `method: ''`. Only dev with `dr.shadow` sees it, as a duplicate server call.
Fix direction: return a marker from the engine body that the answer was the server's, and run no
probe for it, as the 501 fallbacks do.

### K-84 · `POST /metamodel/structural-diff` answers 422 where `/metamodel/diff` answers 500 on a YAML constructor error · `open` · *2026-09-29*
A YAML document whose tags raise a `ValueError` in a constructor is a 422 on the new route and a
500 on the old one; the lint that gates both never lets one through, so only a direct caller sees
it. Fix direction: pick 422 on both, in the same commit as the route's own fixture.

### K-86 · The rebind preview can render a cycle or a duplicate key differently from the server's with staged ops · `open` · *2026-09-29*
The engine scans the working copy as one fresh run, its structure built from the state it holds.
The server rebuilds the committed state under the candidate and applies the staged ops to it one
by one, so its containment parents and its uniqueness groups carry that history: a containment
cycle is reported from the element the server's walk reaches first, and `duplicate_keys`
renders the key of whichever member arrived second, both of which staged ops that move a group
or a cycle can change. The difference is only in the rendering: the same values reach the
message only for `1` / `1.0` / `True` (which Python holds equal and renders as it met them), and
the cycle start only for a model with more than one cycle. The golden
`preview_rebind` steps, which stage no such op, match exactly. Fix direction: record a fixture
whose staged ops move a group with `1` and `1.0` members and join two cycles, and port the
server's history into the rendering if the owner wants that exactness.

### K-87 · A bug in the candidate's preparation reads as "The candidate metamodel is invalid." · `open` · *2026-09-29*
The service maps anything `prepareCandidate` throws but `PatternUnusable` and `RulesUnreadable`
to 422 `metamodel: …`, on arrival and again at the scan's first step when the rule sources moved.
`Metamodel.fromJSON` does not validate its input and throws a plain `TypeError` on a malformed
document, so the 422 cannot be narrowed to its throws without a validating reader; a JS bug in
`FacetPatterns`, `Validators` or the rules compile therefore answers 422 as well. The shell takes
no 422 to the server: the editor says "The candidate metamodel is invalid." and a rebind preview
fails, with no server fallback, over a document the server's lint accepted. Fix direction: give
`Metamodel.fromJSON` (or the candidate path) a reader that refuses a malformed document with its
own error, map only that to 422, and let anything else reach the client as a 500 the route
probes and rethrows.

### K-85 · One e2e spec, `dnd.spec.ts`, timed out once under a full run · `open` · *2026-09-29*
`dnd.spec.ts` "drag a placed element to the view root unplaces it" hit its 2 minute timeout in 1
of 4 full e2e runs (the first one of C's plan 7, task 9) and passed alone and in the other three.
Nothing in that run had touched drag and drop. Fix direction: find what the spec waits on that a
loaded host stretches, and wait on that signal instead of the clock.

### K-88 · The two sides can name different winners for an element placed in two folders · `open` · *2026-09-29*
The frontend's `elementHomeFolderId` (`lib/state/view-ops.ts`, which the view
store's placement ops use) checks a folder's own elements before its descendants, while
`validate_view` and its engine port check descendants first. For an element listed in a folder
and in one of that folder's descendants, the two name different folders as the one that "wins",
so a move op and the warning's "first placement wins" can disagree about where the element is.
Fix direction: pick one order, in the oracle first, with a fixture, and follow it in the
frontend's helper.

### K-89 · The model download's longest step and slice are over the 16 ms bound · `open` · perf · *2026-09-29*
`modelFileSteps` at M (118,076,420 bytes), medians of 3 on DESKTOP-5QK3FA5 (Ryzen 9 3900X),
2026-09-29: 2,493 ms in Node with a 27 ms longest step, 1,944 ms in Chromium 148 with a 20 ms
longest slice; the export, table, rescan and candidate slices are over the bound too. Node's
peak heap, 21.6 MB above baseline, leaves out the roughly 118 MB of `ArrayBuffer` parts, which
sit off the heap until the transfer. Fix direction: find what the longest step holds (the
`Meter`'s 1,024-entity step over large entities, or the part writer's encode and copy at a part
boundary) and make it end sooner; the heap row wants an `arrayBuffers` figure beside it.

### K-90 · The server's download is buffered into a Blob before the save starts · `open` · *2026-09-29*
`downloadModel()` answers a `Blob` on both sides so the `always` digest shadow can read one
value; on the server side that buffers `GET /model/download`'s whole body (about 120 MB at M)
in the browser before the save picker's writable receives any of it, where the raw `Response`
used to stream into it. The engine side builds its Blob from the 4 MiB parts the same way.
Fix direction: on the server side, tee the body into the save while the digest reads the other
branch, or drop the server side when the engine's is the only one left (F).

### K-91 · The download route's tests time out under a loaded full run · `open` · *2026-09-29*
`frontend/src/lib/api/__tests__/download-route.test.ts` "answers the engine's committed bytes as
an application/json Blob and asks the server nothing", the first test of its file, hit its 5 s
limit in 1 of 2 full `dr-test` runs and passed in the rerun. On 2026-09-30 two of its tests
timed out in one full run and one test in another; the file passes alone, 7 of 7. The cause is a
loaded host (its cold worker start and a 4 MiB-part file share the clock). Fix direction: find what the test waits on that a
loaded host stretches, and wait on that signal instead of the clock.

### K-92 · Compare's parse block, apply-CR's last step and the parsed file's heap miss the bounds · `open` · perf · *2026-09-30*
At M, medians of 3 on DESKTOP-5QK3FA5 (Ryzen 9 3900X, near-idle host), 2026-09-30. Three misses:
(1) compare's first step decodes, parses and shapes the 76,772,875-byte file in one block: 2,746 ms in Node, and in Chromium 148 the longest staged round trip during `compareModel` is 2,086 ms (the whole call 2,371 ms), far past the 16 ms slice bound; the diff after it is sliced, but its longest step, 44 ms in Node (whole compare 3,142 ms), misses the bound too.
(2) The parsed file's peak heap above baseline is 285 MB beside the replica's 240 MB, about 525 MB against CN-3's 400 MB.
(3) `proposeCr` reads the change requests synchronously at arrival, and its last step runs the gate, `opsForChange` and the change-request document unmetered: at M with a whole-model CR (6,974 ops) the longest step is 62 ms in Node (whole call 104 ms) and 138 ms as the longest staged round trip in Chromium (277 ms).
Fix direction: parse the file incrementally (a streaming or chunked reader that yields between entities) and shape it as it goes, or diff it entity by entity without holding the whole parse; meter the gate and the ops in `proposeCr`'s last step.

### K-93 · An integral float in a change request stages as an int · `open` · *2026-09-30*
A CR crosses the frontend as parsed JSON (the dialog reads the file with `JSON.parse`, and a compare's answer is parsed as it arrives), so a float such as `1.0` in an added or modified entity becomes `1` before it is sent back or staged, on the engine path and the server path alike. Wire text reaches the engine untouched elsewhere (AD-26); a CR does not. Fix direction: read and keep a CR as text with `parseExact`'s float-preserving values on both sides, or send the file's bytes to the engine and let it read them.

### K-100 · 10,000 script cells took 4.9 s in the browser against a 2 s budget · `done` · perf · *2026-09-30*
**Closed 2026-10-01.** The owner decided: a fresh worker per batch stays (K-105's isolation),
CN-3's script-cell budget is now **≤ 3 s, measured prewarmed** (image and spares ready at the
timer), the cold first use after the open is reported, not gated, and the pool keeps hot spares.
What bounded the run, Chromium, cap 4, medians of 3 on a throwaway probe: as benched it took
4.8 to 4.9 s, about 2 s of it a cold boot inside the timer (the warm-up call ended before the
maker's image existed, so the timed run found no spare). Prewarmed with the image and one spare
ready it took 2,686 ms; with four hot spares 2,364 / 2,547 / 2,616 / 2,464 ms across sessions (two
spares: 2,673). What did not help: dropping `call-start` / `call-end` (noise); booting ahead past
the cap (+3%, eight interpreters contend); splitting batches across workers (chunks of 500: 3.1 s,
250: 7.4 s, work-stealing about the control), the lost memo negligible. The split of one run
(batch 5, cap 4): Python `json` 27%, FFI 7%, post, queue and wake 45%, the engine core 2%, the
Python facade 20%; a zero-cost codec would project to 1.86 s at best. Reusing workers across
batches measured 1.73 to 1.77 s (no boots, 374 against 450 µs per trip) but breaks K-105's
fresh-worker-per-batch isolation, so it is not taken; an idea for later that keeps K-105's
cross-member guarantee: reuse a worker only across batches of the same author (the last editor).
The change: once asked (`run`, `boot`, `prewarm`, `warmed`) the pool fills every free slot with a
spare as soon as the image is ready, starts none while the maker works, refills a finished
batch's slot, and keeps the idle shrink (spares beyond one end after `spareIdleMs` and stay ended
until the next ask); `scriptWarm` (a service route over `ScriptHost.warmed()`) lets the bench wait
until `cap` spares are ready. Closing measurement (`engine-bench-browser`, 2026-10-01, median of 3):
**2,284 ms** [2,284 2,283 2,360] against 3,000, within budget, with four spares ready at the timer;
the first use's cold boot 2,102 ms [2,044 2,102 2,125] is its own row. Cost: `cap` interpreters
stay resident (about 90 MB each) while the pool is hot.

The same ten scripts as table columns over those 1,000 rows, exported as csv through the engine
(`engine-bench-browser`, 2026-10-02, median of 3, one round): **2,765 ms** [2,735 2,775 2,765]
against 3,000, within budget (`script table export (10,000 cells)`, gated). Cached, not gated: the
same export again 34 ms, the first page of 500 rows 28 ms.

Attribution of the slice rows (2026-10-02, medians of 3, same HEAD): once as benched (`scripts:
'evaluate'`, the table export before `transitions()`, ~10,000 cells in the cache) and once with the
option off and the table export skipped. Open slice 55 / 49; digest check 11 / 11; sweep 12 / 10; table
16 / 29; exports 32 / 23 (passes 32 23 36 / 23 22 24); download 19 / 21; rescan 38 / 39; candidateIssues
29 / 28; stage 1,000 ops 69 / 66; unstage all 96 / 92; applyDelta 17 / 16; `exportTable: csv` 407 / 347 ms;
`evaluateTable` first page 167 / 248 ms. Only the exports' slice and csv time moved the same way in two
of three passes beyond the other rows' spread (about +9 ms and +60 ms); the table row moved the other way
and the rest are within noise. The exports' slice is `K-113`.

The record below is the earlier measurement and its split.

The first measurement, on one warm script worker (Chromium 148, Ryzen 9 3900X under WSL2, load 1.4,
median of 3): ten scripts over 1,000 `Microservice` ids each through `scriptCalls` on one warm script
worker: 3,276 ms [4,481 3,276 3,139] against CN-3's 2,000, in 10,850 trips at 289 µs
[397 289 277]. The boot (2,110 ms) is paid by the warm-up call before the timer; `script µs
per trip` is `guest.run`'s time, so about 3.1 s of the 3.3 s lies inside the script worker's
run and the host's own post and clone of batch and results is about 0.14 s. Nothing was tuned.

The four components the spec names, each with where it was measured:
- **Dispatch**, Node (`engine/bench/script-split.ts`, medians of 3): the dispatcher 375 ms
  (35 µs per trip) of a real in-process run of 1,648 ms. In Chromium, timed around
  `bridge.dispatch` in the engine worker: 402 ms (37 µs), 402 ms and 342 ms in the three
  passes, so dispatch is the same in both and is not where the browser is slower.
- **Python-side JSON**, Node: `json` over the texts of one pass, timed inside Pyodide (request
  dumped from its dict, reply, roots and result texts loaded or dumped): 404 ms (reply loads
  185, roots loads 107, result dumps 64, request dumps 46); a Python timer pair costs about
  0.9 µs. Chromium, timed around each `json` call in the guest: 849 ms (reply loads 354,
  request dumps 165, roots loads 142, result dumps 149, calls loads 26, result list dumps 13),
  761 and 938 ms in the other passes: about twice Node's.
- **Post**, Chromium: the script worker's `postMessage` call 412 ms (38 µs per trip), and the
  time from that post to the engine worker's handler starting 885 ms (82 µs), the call
  included.
- **Wake**, Chromium: what remains of the script worker's transport (arm, post, block, read,
  decode: 1,983 ms) after the post-to-handler time, the engine's dispatch, encode and reply
  write (402 + 124 + 293 ms) and the decode (57 ms) is 222 ms (20 µs), 288 and 181 ms in the
  other passes. Node's proxy, a no-op round trip between two `worker_threads` over a shared
  flag, is 754 ms (70 µs), medians of 3.

The Chromium figures come from a scratch build (not committed) that timed those calls with
`performance.now` and Python's `perf_counter`; that run's wall was 4,080 ms [4,080 4,277 3,568]
at 362 µs per trip and its boot 2,563 ms, slower than the 3,276 ms run above, so the parts are
of the 4,080 ms run and do not add up to 3,276. Inside its median pass's 3,930 ms of run:
Python's side of the transport calls 2,291 ms (of which the JS transport 1,983 ms, the other
308 ms the call and string conversion across the FFI), JSON 849 ms, and 790 ms that is neither
(the facade's own code and Pyodide). Unattributed: why that run was 25% slower than the
uninstrumented one (instrumentation or the session's drift, CN-5), the 308 ms FFI crossing,
and the 790 ms. Node's parts are from separate runs and leave 123 ms of its 1,648 ms
(1,648 − 375 − 1,150 canned Python side; the canned side holds the 404 ms of JSON).
Chromium's per-trip time is thus about the dispatcher, the JSON and the transport; nothing in
the data points to chunked replies (no reply nears 1 MiB) or to the structured clone.

**Measured again on the pool (2026-10-01, same machine and model, load 1.1, median of 3).** Each
batch has a fresh worker and the ten scripts run concurrently on up to four (`hardwareConcurrency`
less 2, at most 4). Measured: 10,000 cells take **4,888 ms** wall [4,710 4,888 5,016] against 2,000
(an earlier run of the same build: 4,654 ms); verdict over budget, 2.4x, and slower than the
single warm worker's 3,276 ms. The ten batches' own times (boot excluded) sum to 5,341 ms
[4,759 5,341 5,386], min 116, median 571, max 1,450 ms each; the pool's bridge handling (dispatch,
encode, reply write) was busy 750 ms [700 771 750]; 10,850 trips at 492 µs [439 492 496] of batch
time; boots: first cold 2,065 ms, later ones from the image 318 ms [299 332 318]. Nothing was
tuned. The run sum is close to the wall, so the four workers bought little overlap.

Hypotheses, not measured: the four interpreters and the engine worker compete for cores (WSL2);
the engine worker's thread serializes message handling beyond what the 750 ms shows; nine image
boots (three waves) add about 1 s. **Open, unaccounted:** what bounds the wall, why a trip costs
more (289 to 492 µs) with four workers, the queue and post time between a worker's request and the
pool's handler, and the time between the pool's reply and the worker waking. Next step: time
those in a scratch build, and run the batches with the cap at 1, 2 and 4 to see whether wall
falls with workers at all. `script dispatch busy` is `dispatch_ms`, the pool's own timing.
Fewer trips or a binary layout gets its own design with the owner.

**What the pool's per-call bookkeeping adds (code, counts only; not measured).** `worker-main.ts`
posts `call-start {i}` and `call-end {i, text}` around every call (and the module-level window),
and the pool handles each on the engine thread, arming a timer at `call-start` and clearing three
at `call-end` (`pool.ts`, `case 'call-start'` / `'call-end'`). For the bench's 10,000 cells in ten
batches that is 10,010 windows, about 20,000 extra messages beside the 10,850 bridge trips, and
each result's text is cloned twice, in its `call-end` and again in `done`. The 492 µs per trip
above divides batch time by trips, so it includes this work and plan 1's 289 µs does not (that
run predates the pool and its windows). Unmeasured candidate: these messages are part of what the engine thread
serializes and of the per-trip rise, next to the 750 ms the busy figure shows. Direction, if
a measurement puts weight on it: the worker already writes the window word into the shared
buffer (`beginWindow` / `endWindow`), so the pool could read that word at the trips and at its
deadline timer instead of receiving `call-start` / `call-end`, and send each text once, in
`done`.

Fix directions: fewer trips (project more with the roots, batch reads in the facade), a cheaper
codec for the reply (the largest JSON part) and a leaner post path, a binary layout behind
`_transport` (CT-6 allows it). The bench prints the verdict and never fails.

### K-101 · A failed script-host boot is memoized, and a stuck run holds the queue · `done` · *2026-09-30*
The Node host keeps a rejected boot (`booting ??= start()`), so a host whose boot failed
cannot be retried (the service keeps no boot of its own); `ScriptHost` does not
document the `boot()` contract the service relies on (idempotent on a live host, a restart
after failure). Runs are serialized, so a run that never settles blocks every later call: a
host's `dispose()` must reject its run in flight. A `close()` during a Node host boot holds
the run queue until the boot ends (a delay, not a stall). Fix: drop a rejected boot from the
memo, state the contract on the type, and hold each host to it in a test.
Closed by the pool: a failed boot rejects the run that waited on it, nothing respawns on its own and the next run boots once more; the `boot()` contract is stated on `ScriptHost` (`host.ts:50-54`).

### K-102 · Integer-like object keys are reordered by the value layer · `open` · *2026-09-30*
A request or a nested property value with a key such as `"10"` is held as a plain object,
which JS orders integer-like keys first, so a bridge reply or an op text can differ from the
oracle's insertion order. Fix: a
`Map`-backed object in the value layer, or ordered key lists beside the object.

### K-103 · Script worker and bridge hardening and small divergences · `open` (items 6 and 8 done) · *2026-09-30*
(1) A user script can post `done`, `failed` or `csp-violation` as the worker through
Pyodide's `js` module; the script worker is not a trust boundary for those messages, which
the README should say (`sandbox/README.md` now does). (2) Neither side listens for `messageerror`, so a failed deserialize
leaves a boot or run pending until close. (3) A reply of 2 GiB or more wraps the Int32
header's `[2]`; `ReplyWriter.begin` could refuse it. (4) `wire`/`unwire` recurse without a
depth bound; a `worker.booting !== null` branch is unreachable. (5) A violation during the
script worker's own load is never relayed, which `sandbox/README.md` does not say, and
`architecture/contracts.md` (CT-4's port hand-over) does not name that worker violations are
relayed. (6) *(done)* The Node host does not project input elements (`inputs.e.ids`) with the roots as
`trusted_runner.py` does: trips differ, results do not; the host counts trips and the browser
host duplicates that wrapper; `'[]'` for `transform` is written in host and guest. (7)
`opOutgoing` and `opIncoming` are near-duplicates with their helpers defined below the class, `bridgeWorkingCopy`'s getter mutates
`bridged`, `close()` disposes the host last (a throwing `dispose` leaves `close` failed after
the reset), `ScriptCallsParams` is exported and unused. (8) *(done: per-call `BaseException` answers as that call's `runtime` error)* A `BaseException` subclass
raised in one call fails the whole batch: the per-call handler in `guest.ts` catches
`(Exception, SystemExit)`, the setup path `BaseException`; in the browser the worker then
posts `failed` and the next call pays a new boot (about 2.1 s). The server guest also catches
only `Exception` (parity). The interrupt design decides how `KeyboardInterrupt` interacts.

### K-104 · The sandbox's `/pyodide/` dev middleware has no error handling · `open` · *2026-09-30*
A `statSync` throw answers 500 and a stream error is unhandled, which could end the dev
server; nothing tests a non-GET/HEAD request or a HEAD on `/pyodide/<file>`.

### K-105 · Interpreter and worker state are shared across script batches · `done` · security · *2026-09-30*
`guest.ts`: `GUEST_BOOTSTRAP` puts `_dr_run` in `__main__` and `run` looks it up again from
`py.globals` on every batch. Each batch gets a fresh `ns` dict, but the interpreter is shared:
`__main__`, `sys.modules` (`json`, which `_transport` uses) and `builtins` persist. The
browser script worker keeps one Pyodide warm across batches of different scripts and across
replica replacement. Reproduced: batch 1 runs `import __main__; __main__._dr_run = _hijack`;
batch 2, an honest `def transform(doc): return 42`, returned `{"payload": "FORGED", "reads":
[]}`. Monkeypatching `json.loads`/`json.dumps` or `builtins` persists the same way. Scripts
are project artifacts, so one member's script runs in other members' browsers; there is no
exfiltration path (`connect-src 'self'`), but results can be silently falsified. The server
guarantees a fresh interpreter per snippet (`script_runner.py`). Not yet reachable: nothing
user-facing calls `scriptCalls`.
The worker's JS global scope is shared the same way: a script can reach it through Pyodide's
`js` module, replace `self.postMessage` (`post()` in `script-worker.ts` calls
`scope.postMessage` at call time) or add a capture-phase `message` listener. Both persist
across batches like the Python state, so a script can forge the `done` of every later batch
and see or alter later `run` messages.
Options: keep the `_dr_run` proxy from boot rather than re-reading `py.globals` (closes the
hijack, not `json` or `builtins`); a fresh interpreter per script; a fresh worker per script;
capture `postMessage` and the message listener when the worker starts (closes replacing
`self.postMessage`; whether a script can still reach the original or read later `run`
messages is not settled); snapshot and restore `sys.modules`, `__main__` and `builtins`
around each batch; or accept the risk explicitly in CT-6. Closed in the browser by the pool: one batch per worker, so no interpreter or worker scope outlives a
batch (K-100's 4,888 ms is measured on it). The Node host shares the process: `K-106`.

### K-106 · A script on the Node host reaches the host process · `open` · security · *2026-10-01*
The pool's one-batch-per-worker isolation closes K-105 where the worker is a browser Web Worker
in a cross-origin sandbox: a script there reaches only its own worker's scope. On the Node
port (`engine/node/`, `worker_threads`) a worker shares the host's process, and Pyodide's `js`
module hands a script the worker's `process`. Reproduction: `import js;
js.process.getBuiltinModule('node:fs')` inside a script works, so batch 1 can rewrite files
later workers load (`engine/src/script/harness.generated.ts` through the facade and harness
text, Pyodide's `python_stdlib.zip`), read the host's environment or call `js.process.kill`
on the host. `test/script/pool.test.ts` forges through the real `parentPort` the same way,
and shows the pool keeps that to the batch's own answer, but nothing stops file or process
access. Until sub-project E gives the headless service a process boundary the Node host runs
trusted code only (tests, benches). Fix direction: run the Node host's workers in a child
process under Node's `--permission` model (no file writes, no child processes, no network),
which is also what CT-6 and CN-20 already say the headless transport ends with.

### K-107 · The script harness and its trusted copy carry small gaps · `open` · *2026-10-01*
(1) Done (the engine refuses `transform` with the console, 422). (2) A stop that
lands between the harness's `finally` and `session["carry"] = ""` (`harness_src.py:253-254`) leaks
module-level stdout into the next call: clear `carry` inside the `try`/`finally` (a core harness change, so
golden fixtures regenerate). (3) The bootstrap's `except KeyboardInterrupt` body (`guest.ts:90-91,116-117`)
has a check point, so a second interrupt there fails the batch as `runtime`: build the killed texts before
the loop. (4) `trusted_runner.pin_determinism` leaves `gmtime`, `localtime`, `strftime`, `ctime` and
`utcnow` unpinned and shows a private subclass in `datetime.now`'s repr, and mutates modules
irreversibly; `js.Date` shows UTC in user scripts. (5) No WASM-guest test of a console run or boot that
raises `SystemExit`; `test_wasm_script_parity_hash_constants` spawns the whole scenario to read code and
its fixture-vs-constant assertion is tautological. (6) `harness_src.py`'s docstring cites
`tests/golden/scenarios/script_harness.py`, which is `tests/golden/script_harness.py`; cosmetic re-wraps in
`trusted_runner.py` and `core/script/README.md`. Items (2) to (6) are hardening and test gaps in
the harness and its fixtures; none changes an answer a user sees, and (2) needs a core harness
change with regenerated goldens, so none blocks the plan.

### K-108 · The script pool and its hosts carry small gaps · `open` · *2026-10-01*
(1) Done: the pool relays at most 16 reports per batch per worker, spares counted too. (2) The
batch-budget checks at call-start receipt and the watchdog ignore a pool-thread stall of at least
`graceMs` near the budget edge. (3) Done: the sandbox prewarms, and the service skips the snippet scan while `artifacts.version` has not
moved; the "< 8 s" timing bounds in tests could still flake on slow CI. (4) The maker allocates an
unused `ReplyWriter`; `serve-worker`'s `randomFillSync` ignores offset and size; `nodeScriptHost` passes no
`onWarning`; `batchToWire` throwing wastes a spare. (5) The isolation probe's comment
(`frontend/bench/scripts.ts:353`) says "after its batch", but the error now fires during it, so the
ended-slot error case is no longer exercised; the concurrent K-105 test does not assert overlap; a
describe title overclaims on Node (`K-106`). (6) `service.ts:454`'s `one?.text` runtime guard wants a
comment; `DEFAULT_HARNESS_LIMITS` and `Interpreter` are exported without a user; `engines` allows Node
20.19 where native type stripping needs 22.18. (7) The soft stop can re-interrupt a script's own
`KeyboardInterrupt` cleanup (documented in `engine/README.md`). (8) A throw from `onViolation` becomes an uncaught error, and a running worker's violations are forgeable.
Items (2) and (4) to (8) are small and off the steady state: none changes an answer or a budget, so none
blocks the plan.

### K-109 · The runaway "soft stop on a snapshot worker" test sometimes booted cold · `done` · *2026-10-01*
`engine/test/script/runaway.test.ts` "ends a runaway loop at the call's deadline on a snapshot worker"
failed in two full `dr-test` runs of this plan with `expected 'cold' to be 'snapshot'`, and passed alone.
The test's `warmed()` stopped at the first run that reported `'snapshot'`, while a spare spawned before
the image was ready (cold boots take about 2 s, image boots about 0.2 s) could still be booting and become
the next run's worker. Closed in the test: `warmed()` now runs passes until every live worker was handed the
image (`Seen.snapshot` in `test/script/fixtures/instrumented.ts`) and then waits on `boot()`. The cause is
read from the code, not reproduced: the file passed five of five runs alone before and after, and the failure
only showed under a full run's load. If it appears again with every live worker handed the image, the pool
gave up on the image (`giveUp`), and that is a new item.

### K-110 · Small code-comment and test gaps from the scripts plan · `open` · *2026-10-01*
(1) A worker `error` event whose message is not an `Error` is not turned into one in
`engine/node/script-host.ts`. (2) The service's `boot_ms` test cannot tell which source its figure comes
from. (3) Forward-looking comments, which RC-6 forbids, at `engine/test/script/pool.test.ts:240` and in
`engine/README.md`. (4) A comment over 100 columns at `engine/src/script/pool.ts:115`. (5) The Scripts
bullet in `architecture/contracts.md` is over-long. Not logged, judged not worth an item: the
`harness_src.py` docstring path and cosmetic re-wraps (in K-107), which cost nothing to leave.

### K-111 · Where the engine's exports differ from the server's when scripts run · `open` · *2026-10-02*
(1) A script step in a navigation column: the server's export reads every cell cache-only and its sweep
runs script columns, row sources and expand items, never a display navigation's step, so the cell is
shipped empty and the export flagged `script_errors`; the engine runs the step and answers its values. The
goldens avoid such tables. (2) A transform's syntax error the scan of `entryArities` cannot see: the oracle
refuses it before anything runs (`ast.parse`), the engine on the call, as the same 422 (`does not parse` for
inline code, `does not define ...` for a saved snippet). A run lists every entry it finds this way after
running the entries before them, so one that also has an entry on a non-JSON format, or whose table fails
first, is answered with that entry's refusal alone; a preview refuses after its other 422s. Code that
`ast.parse` accepts and `compile` refuses (`return` outside a function) is the oracle's `failed to load` and
the engine's `does not parse`. (3) A transform that times out, or whose module loops, ends the oracle's
session, so every later file reports `failed to load`; the engine reports `timeout` for each call. (4) A
malformed saved snippet payload: the engine's 422 text approximates pydantic's. The fix for (2) is a parser
or a compile-only harness mode.
None blocks: each is a difference on a path the app's engine does not exercise through the console, and the goldens avoid them.

### K-112 · The trusted runner's print capture races on threads · `open` · *2026-10-02*
The harness swaps `sys.stdout` around each call without a lock, so the sweep threads of a scripted oracle run
can leave a `_CappedStdout` installed and the child answered nothing; `tests/golden/scripted.py` writes its
answer through `sys.__stdout__` to get past it. A real fix is a lock or a per-thread stream in
`core/script/harness_src.py` (frozen: lands on both sides with a fixture).
It does not block: the engine's own scripts run one call per worker batch and the race needs the oracle's sweep threads.

### K-113 · The exports' longest slice is 32 ms with the option on, 23 ms with it off · `open` · perf · *2026-10-02*
`engine-bench-browser` with the engine evaluating scripts and ~10,000 cached script cells ahead of
`transitions()` shows `longest staged round trip during the exports` at 32 ms [32 23 36], against 23 ms
[23 22 24] without them (the README's 2026-09-28 figure is 23 ms), and `exportTable: csv` at 407 against
347 ms. Both are over CN-3's 16 ms either way; the delta suggests the cache's bookkeeping or the filled
path runs in a slice. Not analysed, nothing tuned. Plan 4 slices the settle and `put` (`K-114` (4)); the
re-measure after it is recorded with the plan's bench run.

### K-114 · What the scripts evaluation leaves open · `open` · *2026-10-02*
(1) The fill memo has no byte bound. It lives for one evaluation and is bounded by its scope; a bound that
stops memoizing is not scheduled. (2) The cell cache's code-id map (`CodeIds`) has no bound until the cache
clears and is not counted in the 32 MB. (3) `hopScript`'s per-node work in a navigation script step is
unmetered and never yields (CN-3 risk). (4) Fixed for the settle and `CellCache.put` of a round (about 65 ms per 10,000 calls and
280 ms per 50,000, Node 22), which run as a model-lane scan in steps of 256 calls (`SETTLE_STEP`). Still
synchronous: a round's batching (`batchesOf`, one `parseExact` per call, outside the scheduler) and
eviction's key computation (`touchedKeys`, `deletedKeys` in `transit`, inside the transition's slice, CN-3);
nothing meters either.
`window.bench.scriptTable()` is to ping during the export so that the bench sees a slice
(`longest staged round trip during the script table (slice bound)`); it gated wall time only before that.
(5) `entryArities` (`src/script/arity.ts`) refuses valid transforms the oracle accepts:
`def transform(doc): return f"{doc:'>10}"` scans `null` and is a 422 `does not parse`; a form feed before
`def` scans `[]` and is a 422 `does not define ...`; `ast.parse` gives `[1]` for both. The other direction,
code the scan reads as fine that the oracle refuses, is `K-111` (2). (6) With a script sort, pass 1 orders by
build order (a pending sort key sorts as empty) and collects that page's other script-column cells beside the
sort's calls for every row; the real order then moves the page, so those calls are wasted and the real page
costs another round. It falls short of the design's "a script-dependent sort fills the whole scope in one
round" (spec §3). If only the sort column is a script there is no extra round. (7) A transform call's key
holds the document's text, up to 8 MiB, and the key and the join that builds it are made inside one slice
(CN-3). (8) A transform that does not parse, over a table that yields no partition or file, answers 200
where the oracle refuses it with 422: the guest reports a syntax error only when a call runs. (9) The recap
(`tableScriptErrors`) materializes the whole grid, every row by every column, before it lists the first 200
errors. (10) Accepted. An evaluation whose script cells are cold and that a stream of transitions keeps moving is run
again for every transition that lands within a round: results computed before a transition are dropped, never
patched, so it answers only once a round fits between two transitions. The visible table re-pages after an
edit anyway, and exports and long fills wait for edits to pause. Admitting results whose read-set no transition
touched would change the stamping invariant (AD-34) for a case a user meets only while typing through a cold
evaluation.
Items (1) to (3) and (5) to (9) do not block: each is a bound or a cost on a path no budget measures, or a
refusal that errs toward the oracle's own 422.

### K-115 · Test and comment gaps left by the console-removal plan · `open` · *2026-10-02*
(1) The exports/run refusal test cannot detect an in-loop regression (its plain first entry never calls the
runner): spy `run_table_export`. (2) The run-by-name test does not assert that scripts ran; no test covers a
nested script (navigation column or row source) or a draft run under the header, and the pre-pass resolves
tables twice under it. (3) The first CSP cap test's "counts again on the next" half runs on a fresh worker, so
only the second test proves the reset; dropped reports are counted nowhere. (4) The removed "lives with the
replica" test also pinned the cell cache empty after a reopen, with no replacement; the 503 is pinned only
for `evaluateTable`; `NO_SCRIPTS` widens the public `index.ts`. (5) `readInputs` (`engine/src/script/console.ts`)
accepts `null` ids and values that pydantic refuses with a 422. (6) No component test for the stale banner
suppressed after Stage. (7) `TableView.test`'s 409 path goes through a mocked state barrel; the real 409 to
`{kind: 'scripts'}` is covered in `table-editor-script-errors.test.ts`. (8) The drop test in
`script-eval.test.ts` does not isolate the settle's own epoch guard. None changes an answer; none blocks.

### T-15 · Full-run flakes in e2e and the frontend's download-route test · `open` · *2026-10-01*
In the full `pixi run frontend-test-e2e` run of the scripts plan's last task, `e2e/eval-exports.spec.ts:176`
("an exporter with two entries and a manifest downloads a zip") and `e2e/table.spec.ts:290` ("inline
navigation column and inline row source") failed beside `T-9` and `T-11`, and both passed when run
alone (8 of 8). `src/lib/api/__tests__/download-route.test.ts` flaked in Task 8's full run and passed in
Task 9's (`K-91` is the same test's timeouts). In the full run after the final fixes,
`e2e/smoke.spec.ts:28` and `e2e/snippet-flow.spec.ts:57` failed instead, and both passed when run alone.
Load-sensitive, not looked into. The final run of the console-removal plan added `e2e/eval-compare.spec.ts:231`,
`e2e/replica.spec.ts:64`, `e2e/script-embedding.spec.ts:114`, `e2e/strict-mode.spec.ts:41` and
`e2e/view.spec.ts:85`, each green alone.

### T-12 · `replica.spec` "a silent bump is healed by the next delta" flakes · `open` · *2026-09-30*
Failed 1 run in 3 of the full e2e run during the scripts plan (engine rev 5 against server
rev 6 on a background `getModelIssues`); not proven to predate the branch, and not the same
as `T-11` (`view.spec.ts`). Not analysed.

### T-13 · The script host and service have thin tests · `open` · *2026-09-30*
`script-worker.ts` has no automated test (proof was by hand in Chromium; a >1 MiB reply and a
replace mid-run belong in the bench or an e2e spec). No test runs the service over the real
browser host's reboot; the boot-retry tests wrap the Node host with fault injection, and the
concurrent-failure test assumes three calls arrive within a 50 ms delay. The divergence path
of `stillReady` (409 `replica is not ready`) is untested, and the "no scheduler job" test
calls `bridge.dispatch` from the test, not from inside a handler. Nothing tests non-ASCII or
astral characters in the code string; the `transform` "no roots sent" check holds via
`trips === 0` either way.

### T-14 · The bridge's oracle tests are partial · `open` · *2026-09-30*
The golden test runs only the `{ascii, spaced, allowNan}` combination of `pyDumps`' options;
`serialize.golden.test.ts` mixes two fixture shapes in one `it` with `continue`;
`bridge.test.ts` (53 cases) pins oracle quirks with hand-carried texts, not regenerated from
the oracle, so they are not staleness-checked; `pyIntOf` and `PyIntLimitError` have no direct
test; the 1e300 offset/limit cases show "does not throw", not "clamped". In the script-bridge
fixture generator, the request id 90 collides with an auto-numbered 90 in group reads,
`_model()` aliases module-level property dicts into each group's model (deepcopy would isolate
them), and there is no dangling-far-endpoint case nor a write dict missing `type_name`/`id`.

### Considered by the exports plan and deferred

Left out of C's plan 5, each on purpose:

| Items | Reason |
|---|---|
| `K-69`, `K-72` | Table sort and cell bugs that fail identically on both sides; exports inherit parity, so a fix with fixtures on both sides belongs to a bug-fix pass |
| `K-70` | Re-paging with the `tables` surface on the server, not exports |
| `K-71` | Installing rules; the owner schedules it |
| `K-73` | Table-tab perf, unrelated to exports |
| `K-65`, `K-66`, `K-68`, `K-60`'s server half, `C-23`, `K-58`, `K-62`, `K-63`, `T-10`, R13 | Rules, validation or the sweep: not on the exports path |
| `T-9` | A `snippet-flow` locator bug in a spec, not on the exports path (closed by the console-removal plan) |

---

## 3. Cleanups

| ID | Item | Source |
|---|---|---|
| C-20 | `done` (2026-09-24, feat/eval-navigation) — `check_metamodel` refuses a property that redeclares an ancestor's, so the two readings never differ on a metamodel that reaches the engine; `_effective_props`' comment now says so. | 2026-09-18 |
| C-21 | `api/routes/commits.py:785` and `:923` list "apply-cr baseline reset" among what bumps `model_rev` opaquely; apply-CR is a dry run that stages a batch and never resets the baseline. Drop it from both comments (C-12 applies: reword only, no reshaping). | 2026-09-19 |
| C-22 | `api/routes/artifacts.py::evaluate_navigation`'s `except LookupError` also catches the evaluator's `KeyError`: an unknown `row_element_id` behind a filter or a property step answers 422 `unknown navigation artifact 'x'`, and with no steps the page's `_tree_item` answers 404 `x`. The top-level `artifact_id` refusal names the id unquoted (`unknown navigation artifact n1`, `LookupError` formatted with `str`) where a nested ref's is quoted. The engine mirrors all three (fixture `nav_eval`). Fix on both sides with a fixture. | 2026-09-24 |
| C-23 | A containment cycle has two readings. `POST /model/validate` with nothing staged runs `Scope.all()` on the server, which names ONE representative of a cycle; the engine ports scoped runs only, so its store (the sweep's, as the server's own store is) reports every element whose first-parent chain reaches the cycle, those hanging below it included, and the engine's `validateModel` answers that store. The server already disagrees with itself the same way (its sweep and its full branch). Pick one reading on both sides when the candidate validation is decided. The candidate validation (C's plan 7) is decided for its own side: it runs the `Scope.all()` reading, one representative per cycle, and reports uniqueness group by group; the live store keeps the first-parent-chain reading. | 2026-09-24 |
