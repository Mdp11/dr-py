/**
 * Per-tab validation-rule-set drafts, keyed by workspace tab id
 * (`rules:draft:<n>` / `rules:<artifactId>`) — the `validation_rules` sibling
 * of snippet-editor.svelte.ts. The YAML text is carried VERBATIM in both
 * directions (payload `{schema_version, yaml}`): it is never parsed and
 * re-serialized here, so the author's comments and formatting survive a
 * round trip exactly as the metamodel blob does.
 *
 * Saving STAGES, it does not POST: `saveRulesDraft` pushes a
 * `create_artifact`/`update_artifact` op onto the staged-artifact buffer
 * (`artifact-edits.svelte.ts`), and nothing reaches the server until the
 * DiffDrawer's Commit sends the batch. Opening a SAVED rule set first checks
 * the artifact out (`art:<id>` exclusive lease); a denial does not refuse the
 * tab — it opens UNSAVEABLE behind the holder banner (`_lockDenied`), mirroring
 * every other artifact editor (see `navigation-editor.svelte.ts`'s
 * `ensureDraft` docstring for the canonical statement of what a denial gates).
 * The tab is deliberately NOT re-keyed when a create is staged: the draft keeps
 * living in its `rules:draft:N` tab and is rebound to `rules:<id>` only when the
 * commit's `id_map` supplies a canonical id (see the module-scope listeners at
 * the bottom of this file).
 */
import { SvelteMap } from 'svelte/reactivity';
import * as artifactsApi from '$lib/api/artifacts';
import * as rulesApi from '$lib/api/rules';
import type { RulesLintError, RulesLintWarning } from '$lib/api/rules';
import { ApiError } from '$lib/api/errors';
import { assertNoNameClash } from './artifacts.svelte';
import {
	onArtifactCommit,
	onArtifactStageDiscarded,
	onArtifactStagedDelete,
	stageArtifactCreate,
	stageArtifactUpdate
} from './artifact-edits.svelte';
import { canEdit, releaseArtifactIfUnneeded } from './checkout.svelte';
import { acquireArtifactLease, lockHolderLabel } from './edit-gate';
import { isTempId } from './ops';
import { bindTabToArtifact, closeTab, repointTabArtifact, retitleTab } from './workspace.svelte';

export interface RulesDraft {
	name: string;
	artifactId: string | null;
	yaml: string;
	dirty: boolean;
	/** Parse/schema failures: the document is unusable as a rule set. */
	lintErrors: RulesLintError[];
	/** Drift: rules the metamodel cannot satisfy. Reported alongside `ok`,
	 * so a drifted set is degraded, never presented as broken. */
	lintWarnings: RulesLintWarning[];
}

// A comment-only starter: it parses to an empty rule set, so a new tab opens
// lint-clean while still showing the shape a rule takes.
const DEFAULT_YAML = `# Validation rules. Uncomment and adapt:
#
# rules:
#   - name: sensor-has-owner
#     applies_to: Sensor
#     severity: error
#     message: every sensor needs an owner
#     then:
#       relationship:
#         type: Owns
#         direction: incoming
#         exists: true
`;

const _drafts = new SvelteMap<string, RulesDraft>();
/**
 * tabId -> the peer holding the `art:` lease this tab was refused, as a display
 * label. Present == the tab is UNSAVEABLE: the payload loaded (a denial never
 * refuses the tab), but the name field, the editor and Save are disabled — see
 * `_lockDenied`'s counterpart in `snippet-editor.svelte.ts` for the full
 * statement of what a denial gates. Absent for a VIEWER too: the whole
 * workspace is already read-only for them.
 */
const _lockDenied = new SvelteMap<string, string>();

export const RULES_LINT_DEBOUNCE_MS = 500;

// Control state — never read from templates.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _lintTimers = new Map<string, ReturnType<typeof setTimeout>>();
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _lintGenerations = new Map<string, number>();

function bump(tabId: string): number {
	const next = (_lintGenerations.get(tabId) ?? 0) + 1;
	_lintGenerations.set(tabId, next);
	return next;
}

function setLint(tabId: string, errors: RulesLintError[], warnings: RulesLintWarning[]): void {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	_drafts.set(tabId, { ...draft, lintErrors: errors, lintWarnings: warnings });
}

/**
 * Lint this tab's current text.
 *
 * `canEdit()` gates the call the way the metamodel editor's `isEditBlocked()`
 * gates its own: `POST /rules/lint` is deliberately outside the backend's
 * read-only-POST allowlist, so a viewer is answered 403 — only the editing
 * flow lints, and a viewer has nothing to lint.
 */
async function lintNow(tabId: string): Promise<void> {
	if (!canEdit()) return;
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const gen = bump(tabId);
	try {
		const out = await rulesApi.lintRules(draft.yaml);
		if (_lintGenerations.get(tabId) !== gen || !_drafts.has(tabId)) return;
		// Warnings ride along whatever `ok` says: drift is a degradation, not
		// invalidity, so it must never render as a broken document.
		setLint(tabId, out.errors, out.warnings);
	} catch (err) {
		if (_lintGenerations.get(tabId) !== gen || !_drafts.has(tabId)) return;
		// The route is always-200 for a well-formed envelope, and this one always
		// is — so a 422 means the document itself was refused for its size. That
		// IS a finding about the document and is shown as one. Anything else is
		// transient (lint is advisory) and leaves the last result standing.
		if (err instanceof ApiError && err.status === 422) {
			setLint(
				tabId,
				[
					{
						message: 'Rule set is too large to lint — trim it below the size limit.',
						line: null,
						column: null
					}
				],
				[]
			);
		}
	}
}

function scheduleLint(tabId: string): void {
	const existing = _lintTimers.get(tabId);
	if (existing !== undefined) clearTimeout(existing);
	_lintTimers.set(
		tabId,
		setTimeout(() => {
			_lintTimers.delete(tabId);
			void lintNow(tabId);
		}, RULES_LINT_DEBOUNCE_MS)
	);
}

export function getRulesDraft(tabId: string): RulesDraft | undefined {
	return _drafts.get(tabId);
}

/** The peer holding this tab's artifact, or null when the tab is editable
 * (lease granted, or the user is a viewer — see `_lockDenied`). */
export function getRulesLockHolder(tabId: string): string | null {
	return _lockDenied.get(tabId) ?? null;
}

/** Banner "Retry": re-attempt the check-out the tab was refused. A draft that
 * has no server-side row yet (unsaved, or a staged create under a temp id) has
 * nothing to lock, so it is silently skipped. The `.catch` is load-bearing:
 * `ensureCheckout` RETHROWS anything that is not a lock conflict and the banner
 * calls this as `void retryRulesLock(tabId)`, so a 500 would otherwise become an
 * unhandled rejection. A failed retry just leaves the banner up. */
export async function retryRulesLock(tabId: string): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft?.artifactId || isTempId(draft.artifactId)) return;
	const res = await acquireArtifactLease(draft.artifactId, 'edit').catch(() => null);
	if (res === null) return;
	if (res.ok) _lockDenied.delete(tabId);
	else if (res.reason === 'conflict') _lockDenied.set(tabId, lockHolderLabel(res));
}

/** Mark this tab lock-denied from OUTSIDE the editor — the only such writer is
 * the post-commit lease sweep (`reacquireOpenArtifactLeases`, dispatched by
 * `artifact-lock-denied.ts`). See `setSnippetLockDenied`'s docstring for the
 * full rationale. */
export function setRulesLockDenied(tabId: string, holder: string): void {
	_lockDenied.set(tabId, holder);
}

/** Mirrors hasDirtySnippetDrafts: only the `dirty` flag matters. A never-saved
 * draft holds nothing but the starter comment until it is edited. */
export function hasDirtyRulesDrafts(): boolean {
	for (const d of _drafts.values()) if (d.dirty) return true;
	return false;
}

export async function ensureRulesDraft(tabId: string): Promise<RulesDraft> {
	const existing = _drafts.get(tabId);
	if (existing) return existing;
	let draft: RulesDraft;
	const id = tabId.slice('rules:'.length);
	// An unsaved draft tab is the `rules:draft:N` a New-rules click mints — or a
	// `rules:<tempId>` shape reachable from a future save-as. A temp id names
	// nothing server-side, so it must never reach the lease/fetch branch below:
	// `getArtifact('tmp_…')` 404s and our only caller is a fire-and-forget
	// `$effect`, which would leave the tab on "Loading…" forever. The prefix test
	// alone does not catch that shape.
	if (tabId.startsWith('rules:draft:') || isTempId(id)) {
		draft = {
			name: 'New rule set',
			artifactId: null,
			yaml: DEFAULT_YAML,
			dirty: false,
			lintErrors: [],
			lintWarnings: []
		};
	} else {
		// Check the artifact out on open, so the user learns who holds it BEFORE
		// investing work in a tab whose edits can never land. A denial does NOT
		// refuse the tab — the payload still loads and the tab opens UNSAVEABLE
		// behind the holder banner (a viewer gets no banner: see `_lockDenied`).
		//
		// The `.catch` is load-bearing, not defensive noise: `ensureCheckout`
		// RETHROWS anything that is not a lock conflict, and our only caller is a
		// fire-and-forget `$effect` — a 500 or a network blip from POST /locks
		// would otherwise reject before `getArtifact` runs and strand the tab on
		// "Loading…" forever. Fail OPEN with no banner: an infrastructure error is
		// not a peer holding the artifact.
		const res = await acquireArtifactLease(id, 'edit').catch(() => null);
		if (res !== null && !res.ok && res.reason === 'conflict') {
			_lockDenied.set(tabId, lockHolderLabel(res));
		} else {
			_lockDenied.delete(tabId);
		}
		const artifact = await artifactsApi.getArtifact(id);
		const payload = artifact.payload as Record<string, unknown>;
		draft = {
			name: artifact.name,
			artifactId: artifact.id,
			yaml: typeof payload['yaml'] === 'string' ? payload['yaml'] : '',
			dirty: false,
			lintErrors: [],
			lintWarnings: []
		};
	}
	_drafts.set(tabId, draft);
	void lintNow(tabId); // immediate — gutter + drift strip without an edit
	return draft;
}

export function editRulesDraft(tabId: string, yaml: string): void {
	const draft = _drafts.get(tabId);
	if (!draft || draft.yaml === yaml) return;
	_drafts.set(tabId, { ...draft, yaml, dirty: true });
	scheduleLint(tabId);
}

export function setRulesName(tabId: string, name: string): void {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	_drafts.set(tabId, { ...draft, name, dirty: true });
	retitleTab(tabId, name);
}

/** Move per-tab lint bookkeeping from a draft tab id to the canonical artifact
 * id its staged create was minted at commit. The lint RESULTS live on the draft
 * and move with it; a pending debounced lint is cancelled under the old id and
 * rescheduled under the new one, and the old id's generation is bumped so an
 * in-flight response for it is orphaned rather than landing on a tab id nobody
 * reads anymore. */
function rekeyRulesTab(oldTab: string, newTab: string): void {
	const timer = _lintTimers.get(oldTab);
	if (timer !== undefined) {
		clearTimeout(timer);
		_lintTimers.delete(oldTab);
		scheduleLint(newTab);
	}
	bump(oldTab);
}

/**
 * "Save" = STAGE an artifact op. Nothing is sent here; the op joins the staged
 * batch that the DiffDrawer's Commit posts to `/commits`.
 *
 * An unsaved draft stages a `create_artifact` and adopts its TEMP id, but the
 * TAB IS NOT RE-KEYED — a temp id is not an artifact id, and re-keying now would
 * strand the tab on an id the server may never mint if the batch is discarded.
 * The rebind to `rules:<id>` happens in the commit listener at the bottom of
 * this file, driven by the commit's `id_map`.
 *
 * A saved draft stages a FULL-payload `update_artifact` (name + yaml);
 * re-saving coalesces into that same entry (see `stageArtifactUpdate`). No
 * `artifact_rev` is sent with either op: the `art:` lease taken at open time is
 * the concurrency control, not OCC.
 */
export function saveRulesDraft(tabId: string): void {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const payload = { schema_version: 1, yaml: draft.yaml };
	// Best-effort: the server's uniqueness check is authoritative and fires at
	// preview/commit. Throws, and RulesTab renders it as `saveError`.
	assertNoNameClash('validation_rules', draft.name, draft.artifactId);
	if (draft.artifactId === null) {
		const tempId = stageArtifactCreate('validation_rules', draft.name, payload, tabId);
		_drafts.set(tabId, { ...draft, artifactId: tempId, dirty: false });
		repointTabArtifact(tabId, tempId); // tab RECORD follows the draft; tab KEY does not
	} else {
		stageArtifactUpdate(draft.artifactId, { name: draft.name, payload });
		_drafts.set(tabId, { ...draft, dirty: false });
	}
}

export function closeRulesDraft(tabId: string): void {
	const draft = _drafts.get(tabId); // read BEFORE the delete: it owns the lease
	_drafts.delete(tabId);
	_lockDenied.delete(tabId);
	const timer = _lintTimers.get(tabId);
	if (timer !== undefined) {
		clearTimeout(timer);
		_lintTimers.delete(tabId);
	}
	bump(tabId);
	// Give the check-out back: no editor is behind this lease. A NO-OP when a
	// staged op still needs it (a saved-but-uncommitted edit must keep its lease
	// or the commit 409s "required lock not held") — that is
	// `releaseArtifactIfUnneeded`'s whole job. A temp id has no server-side row
	// and therefore no lease.
	if (draft?.artifactId && !isTempId(draft.artifactId)) {
		void releaseArtifactIfUnneeded(draft.artifactId).catch(() => {});
	}
}

export function resetRulesEditors(): void {
	for (const timer of _lintTimers.values()) clearTimeout(timer);
	_lintTimers.clear();
	_drafts.clear();
	_lockDenied.clear();
	// Bump (not clear) — mirrors resetSnippetEditors: an in-flight response from
	// before the reset must stay stale even if the same tab id is immediately
	// re-created (a cleared counter restarting at 1 could collide with a low gen
	// the stale response already captured).
	for (const tabId of _lintGenerations.keys()) bump(tabId);
}

// ---------------------------------------------------------------------------
// Staged-artifact listeners (module scope: registered once for the app's life)
// ---------------------------------------------------------------------------

/**
 * The commit landed. Two things follow from the server's authoritative delta:
 *
 *  - a draft whose artifact was DELETED in the batch loses its tab — there is
 *    nothing left to edit. A delete staged from the sidebar already closed the
 *    tab eagerly (see the staged-delete listener below); this is the
 *    authoritative backstop for any path that reaches commit without it;
 *  - a draft still on a TEMP id is rebound to the canonical id the `id_map`
 *    minted: the workspace tab is re-keyed (`bindTabToArtifact`), the draft
 *    moves to `rules:<id>`, and its pending lint bookkeeping follows
 *    (`rekeyRulesTab`).
 */
onArtifactCommit(({ idMap, deletedIds }) => {
	for (const [tabId, draft] of [..._drafts]) {
		if (draft.artifactId === null) continue; // unsaved: nothing committed
		if (deletedIds.includes(draft.artifactId)) {
			closeRulesDraft(tabId);
			closeTab(tabId);
			continue;
		}
		if (!isTempId(draft.artifactId)) continue;
		const realId = idMap[draft.artifactId];
		if (realId === undefined) continue; // not part of this batch
		bindTabToArtifact(tabId, realId);
		const newTab = `rules:${realId}`;
		_drafts.delete(tabId);
		_drafts.set(newTab, { ...draft, artifactId: realId });
		rekeyRulesTab(tabId, newTab);
		_lockDenied.delete(tabId);
	}
});

/**
 * A staged op was DISCARDED — nothing was saved, so the draft goes back to
 * holding unsaved work. A discarded CREATE additionally un-binds: its temp id
 * will never exist, so the draft becomes the unsaved draft it was before Save.
 */
onArtifactStageDiscarded((id) => {
	for (const [tabId, draft] of [..._drafts]) {
		if (draft.artifactId !== id) continue;
		if (isTempId(id)) {
			_drafts.set(tabId, { ...draft, artifactId: null, dirty: true });
			repointTabArtifact(tabId, null); // the record tracks the draft, both ways
		} else {
			_drafts.set(tabId, { ...draft, dirty: true });
		}
	}
});

/** A delete was STAGED (from the sidebar). Close the tab right away rather than
 * leaving an editor open on an artifact the pending batch removes — the user
 * has already decided it is going. */
onArtifactStagedDelete((id) => {
	for (const [tabId, draft] of [..._drafts]) {
		if (draft.artifactId === id) {
			closeRulesDraft(tabId);
			closeTab(tabId);
		}
	}
});
