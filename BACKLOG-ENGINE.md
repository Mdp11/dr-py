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
both sides with a fixture.

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
and frontend seam) is designed — six plans, listed in `architecture/program.md`, the first built
(exact server state) — and inherits `K-32`. The freeze rule (`MR-3`)
covers `core/model`, `core/metamodel` and the model-op applier from the start of A's second
plan. Size: very large.

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

### K-32 · Two background operations must run in slices; the `ord` re-sort is watched · `open` · perf · *2026-09-18*
`architecture/system.md` rule 4 has evaluation and background work yield between chunks of
at most 16 ms; a transition — stage, unstage, rebase, delta apply — is atomic under its own
budget, 100 ms for up to 1,000 ops with the order repair included (CN-3, AD-23). Measured at
M by `pixi run engine-bench` (Node 22, medians of 3): `rebuildIndexes()` at the end of
`openSnapshot` is one 0.52 s task and `verifyDigest()` hashes 297,160 entities in 0.2 s. None
of it matters in Node; in the engine worker both must run in slices (sub-project B, the
engine service) — CT-3 already says the digest check runs in the background. The first
ordered iteration after a rewind that put an entity back at an old `ord` re-sorts the whole
entity map, 58 ms against 2 ms for a plain pass: behind a 39 ms unstage that is 97 ms of the
transition budget — inside it, and watched. If the browser benchmark misses, the fix is an
insert in place, or a sort kept to the entities that moved. The other transitions are well
inside: a 1,000-op batch stages in 44 ms, 100 staged batches rebase over a delta in 14 ms, a
149-entity delta applies in 8.9 ms.

---

## 3. Cleanups

| ID | Item | Source |
|---|---|---|
| C-20 | `core/metamodel/schema.py::_effective_props`' comment says definitions by closer types win; the code keeps the FIRST name seen walking root → leaf, so on a redeclared property the ancestor's definition stays (fixture `metamodel_caches`, type `Mid`). The engine mirrors the code. Decide which was meant; frozen under MR-3 until the metamodel surface defaults to the engine. | 2026-09-18 |
