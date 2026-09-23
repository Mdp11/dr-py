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
five read surfaces defaulted to the engine — they land in TypeScript only now; a bug there
still lands on both sides with a fixture while the server path lives (MR-1, until F).

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
The freeze rule (`MR-3`) covers `core/model`, `core/metamodel` and the model-op applier from
the start of A's second plan; `routes/read.py`'s route functions and
`routes/elements.py::get_element` left it for features once B's fifth plan flipped the
surfaces' defaults. C (evaluation) is next. Size: very large.

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

### K-41 · A rebind's re-bootstrap does not remap later batches' temp ids · `open` · *2026-09-22*
`sync.ts`'s `dropStagedBatches` unstages a rebound commit's own batches by id, but a later
staged batch that named one of THOSE batches' temp ids (an update or a connect referring to
an element the dropped batch created) is not remapped — the create is gone, so after the
re-bootstrap the later batch parks as a conflict instead of being fixed up or dropped with it.
Decide whether `dropStagedBatches` should walk dependents transitively.

### K-42 · An edit that survives a commit flight loses its lease · `open` · *2026-09-22*
`POST /commits` releases every lease the caller held (`routes/commits.py`). An edit staged
DURING the POST (a batch of its own, per CT-2) is not part of that commit, so its element's
lease is released along with the committed batch's; the next commit of that edit may 409
"required lock not held" until the element is edited again (which re-acquires it). The same
happens to a proposal (a snippet or CR Stage) that took its locks before a commit landed and
staged its ops after. Decide whether the checkout store should re-acquire locks for what is
still staged after a commit, or whether this stays a known limit.

### K-43 · A property update staged during a commit can be dropped with it · `open` · *2026-09-22*
The engine always coalesces a single property update (`emit`, or `emitMany` with ONE op) into
the first staged batch already holding an update of the same id — including a batch that is
mid-commit. The frontend narrows the window (the DiffDrawer cannot be dismissed while a commit
is in flight, and `stageProposedOps` waits for `commitsLanded()`), but a plain `emit` from the
property form is not gated the same way. Decide whether the engine should refuse to coalesce
into a batch already sent, or whether the frontend's narrowing is enough.

---

## 3. Cleanups

| ID | Item | Source |
|---|---|---|
| C-20 | `core/metamodel/schema.py::_effective_props`' comment says definitions by closer types win; the code keeps the FIRST name seen walking root → leaf, so on a redeclared property the ancestor's definition stays (fixture `metamodel_caches`, type `Mid`). The engine mirrors the code. Decide which was meant; frozen under MR-3 until the metamodel surface defaults to the engine. | 2026-09-18 |
| C-21 | `api/routes/commits.py:785` and `:923` list "apply-cr baseline reset" among what bumps `model_rev` opaquely; apply-CR is a dry run that stages a batch and never resets the baseline. Drop it from both comments (C-12 applies: reword only, no reshaping). | 2026-09-19 |
