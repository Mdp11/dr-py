# Issues panel live refresh (F-4 + U-8) — design

Date: 2026-08-12 · Status: approved · Scope: backend `api` + frontend state/components
Backlog: **F-4** (issue list never refreshes after a commit), **U-8** (Issues tab empty
after project creation until Validate). **F-3** rides along as a separate commit.

## Problem

The Issues panel's list and the StatusBar's error count read from different stores:

- The panel reads `validation.svelte.ts`'s `_issues`, set ONLY by the Validate button
  (`validate-action.ts`) and the MetamodelTab rebind handler. Nothing sets it on project
  open or when a commit lands — so the panel is empty after open (U-8) and stale after
  every commit (F-4).
- The StatusBar reads `model.svelte.ts`'s `_issueCounts`, which IS kept fresh from
  `GET /open`, every own-commit delta, and `validateAll()`.
- A third store already exists and is the key to the fix: `model.svelte.ts`'s
  `_issuesByOwner` (SvelteMap) is incrementally spliced on every own commit — the
  `CommitResponse` (extending `OpsResponse`) already carries
  `issues_removed_owner_ids`/`issues_added` and `applyDelta` applies them
  (`model.svelte.ts:410-411`). Its getter `getIssuesByOwner()` has zero consumers, and
  the map is never seeded on open.

Adjacent instances of the same root cause, confirmed in this session:

- **Peer commits over the realtime feed carry no issue delta** —
  `realtime.svelte.ts` synthesizes empty `issues_added/removed` and re-uses the *stale*
  local `issue_counts`, so on a peer commit even the StatusBar goes stale.
- **The background validation sweep** grows the backend issue store chunk-by-chunk
  after a cold open; the client only ever sees the counts `/open` returned.

Constraint (the reason this design exists): do NOT re-run full-model validation per
commit/open. `POST /model/validate` with no ops runs the whole pipeline
(`routes/validation.py`, path 3); the model can be ~80 MB. The backend already
maintains the answer incrementally in `session.validation` (`ValidationState`) —
seeded at load/hydrate, streamed into by the sweep, spliced by every commit.
`state.all_issues()` is a cheap read; it just isn't exposed as a GET.

## Decisions (with the owner, 2026-08-12)

1. **Scope: all of it** — open, own commits, peer commits (feed), sweep completion,
   and feed-reconnect resync.
2. **Panel UX: live base + Validate overlay** — the panel always renders live
   committed issues; an explicit Validate overlays the origin-tagged staged snapshot;
   any commit/refetch clears the overlay.
3. **Transport: Approach A** — one new cheap read route `GET /model/issues` +
   refetch-driven resync. Rejected: issue deltas on the feed commit event (fatter
   broadcasts, drift on missed events, and the refetch path must exist anyway for
   reconnect); fattening `GET /open` (semantics abuse, bloats every open).
4. **F-3 rides along** on the same branch as its own commit.

## Backend

**One new route: `GET /model/issues`** in `routes/validation.py`, mounted under the
project prefix like its siblings.

- Response `IssueListOut` (new schema in `schemas.py`):
  - `model_rev: int` — lets the client drop a response that lost a race with a commit.
  - `issues: list[IssueOut]` — origin `on_server` (the store holds committed facts only).
  - `counts: dict[str, int]` — exact severity counts from `state.counts()`, never capped.
  - `truncated: bool` — see size guard.
- Implementation: `require_model(session)` → `_ensure_validation_seeded(session, model)`
  (import from `routes/ops.py`, same as `/open` uses — full pipeline only when
  `session.validation is None`, which real flows never hit because hydrate/load always
  installs a store) → snapshot `all_issues()` + `counts()` + `session.model_rev`
  **under `session.write_mutex`**. The mutex is load-bearing: this route is called
  *during* the background sweep by design (project open), and the sweep splices chunks
  into `issues_by_owner` under the mutex — an unguarded dict iteration mid-splice is a
  concurrent-mutation race. The guarded section is a list copy (microseconds).
- Size guard, not paging: `issues` capped at `ISSUES_RESPONSE_MAX = 5000`,
  `truncated=True` past it. The panel renders one flat list; the payload is
  issue-count-bound, not model-size-bound.
- Authz: GET ⇒ read-only under the existing method-based write detection; viewers
  allowed; `require_membership` 403/404 semantics come with `get_request_session`.
- Explicitly unchanged: `POST /model/validate` (all three paths), the commit-time
  splice, the sweep, feed event shapes, `/open`. No Alembic, no settings, no deps.

## Frontend — data flow

`model.svelte.ts`'s `_issuesByOwner` becomes the single live store; `_issueCounts`
stays as its count projection (StatusBar keeps reading it).

- **New store function `adoptIssues(issues, counts, modelRev)`** in `model.svelte.ts`:
  clears and refills `_issuesByOwner`, sets `_issueCounts` (and syncs
  `_summary.issue_counts`), and **ignores the call when `modelRev < _modelRev`**
  (stale read; the next delta or refetch heals). Also clears the Validate overlay
  (below) — adopting committed truth invalidates any staged snapshot.
- **Open**: `boot()` (`routes/p/[projectId]/+page.svelte`) fetches `GET /model/issues`
  alongside its existing loads and calls `adoptIssues`. Fixes U-8.
- **Own commits**: unchanged — `applyDelta` splices the response delta. Fixes F-4.
  `applyDelta` additionally clears the overlay (committed reality moved).
- **Peer commits**: `realtime.svelte.ts` commit case: after `applyDelta`, schedule a
  **debounced (~300 ms) refetch** of `GET /model/issues` → `adoptIssues`, replacing
  today's fabricated stale `issue_counts` (the synthesized delta keeps its empty issue
  arrays; the refetch is the correction). The same hook fires on feed **reconnect** —
  that is where dropped-behind (4408) clients resync.
- **Sweep completion**: `trackOpenProgress` (`open-progress.svelte.ts`) already calls
  `refreshSummary()` when the poll loop saw hydration/validation work; add the issues
  refetch there.
- **Rebind**: `MetamodelTab.svelte`'s `onRebind` calls `adoptIssues(res.issues …)`
  instead of `setIssues` — the rebind response is a full committed issue list, same
  semantics as the GET.

## Frontend — panel UX and the overlay store

`validation.svelte.ts` becomes the **overlay store**: keeps `running`/`lastError`/
`lastRunAt`; its issue list is reinterpreted as `_overlay: Issue[] | null` — the
origin-tagged snapshot of the last explicit Validate. Cleared by: any commit (own or
peer), any `adoptIssues`, and project reset. `setIssues` is renamed to `setOverlay`
(both former callers are touched by this design anyway).

`IssuesPanel.svelte` derives one of two modes:

- **Live mode** (`_overlay === null`, the default): renders the flattened
  `_issuesByOwner`. Origin filter row and badges are hidden (everything is
  `on_server`). The "Not validated yet" empty state is gone — after open the panel
  always has content; zero issues renders "No issues". When the last adopt was
  `truncated`, show "showing first 5000 of N" (N from exact counts).
- **Overlay mode** (after explicit Validate): today's UI unchanged — origin filter,
  new/fixed badges, struck-through resolved rows, "last run Xs ago". `runValidation()`
  and the Validate button keep working; view warnings (`getViewWarnings()`) keep being
  appended in both modes.

**Deliberate behavior change**: `validateAll()` stops mutating
`_issuesByOwner`/`_issueCounts`. The StatusBar therefore always shows **committed**
truth (consistent with `/open`, commit deltas, and the sweep); staged-preview counts
live only in the panel overlay header. One source, two projections — the
count-vs-list disagreement is closed structurally.

## Error handling

- Every refetch is best-effort: a failed GET keeps the current map; the next commit
  delta or refetch heals. Boot tolerates an issues-fetch failure like it tolerates
  status-poll failures.
- `adoptIssues` drops stale responses by `model_rev`.
- Explicit Validate keeps its existing error strip (`lastError`).

## Testing

- **Backend** (`tests/api/`, hermetic SQLite fixtures): GET returns the seeded store,
  exact counts, `model_rev`; reflects the post-commit splice; truncation flag and
  exact counts past the cap; 404 unknown project / 403 non-member; viewer allowed.
- **Frontend** (vitest + MSW): `adoptIssues` refill + stale-rev drop + overlay clear;
  boot seeding; peer-commit feed event triggers the debounced refetch; overlay set by
  Validate, cleared by commit and by adopt; IssuesPanel live vs overlay rendering and
  truncation notice; StatusBar committed-counts after Validate (changed behavior);
  MetamodelTab rebind adoption.
- **F-3** (separate commit): `quiet.ts` includes `getStagedViewDepth()`; test that a
  staged-view-only project is not quiet.

## Delivery

Branch off `main`, TDD per component, one commit per concern; flip BACKLOG.md statuses
(F-4, U-8, F-3) in the same commit as each fix (BACKLOG's own rule). Local merge, no
push to origin. `docs/superpowers/specs|plans` are gitignored — the spec is not
committed.
