import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import * as checkoutApi from '$lib/api/checkout';
import * as rulesApi from '$lib/api/rules';
import { ConflictError, ValidationError } from '$lib/api/errors';
import type { ArtifactHeader } from '$lib/api/types';
import {
	closeRulesDraft,
	editRulesDraft,
	ensureRulesDraft,
	getRulesDraft,
	getRulesLockHolder,
	hasDirtyRulesDrafts,
	resetRulesEditors,
	retryRulesLock,
	RULES_LINT_DEBOUNCE_MS,
	saveRulesDraft,
	setRulesName
} from '../rules-editor.svelte';
import { getDynamicTabs, openArtifactTab, resetWorkspaceTabs } from '../workspace.svelte';
import { loadArtifacts, resetArtifacts } from '../artifacts.svelte';
import {
	getStagedArtifactOps,
	notifyArtifactCommit,
	resetArtifactEdits,
	stageArtifactDelete
} from '../artifact-edits.svelte';
import { isCheckedOutByMe, resetCheckout, setProjectInfo } from '../checkout.svelte';
import { isTempId } from '../ops';

const RULES_YAML = 'rules:\n  - name: r1\n    applies_to: Sensor\n    then:\n      property: id\n';

const RULES_ARTIFACT = {
	id: 'r1',
	kind: 'validation_rules',
	name: 'House rules',
	artifact_rev: 3,
	updated_at: '2026-08-24T00:00:00Z',
	updated_by: 'u1',
	entry_points: null,
	payload: { schema_version: 1, yaml: RULES_YAML }
};

function header(id: string, name: string, rev = 1): ArtifactHeader {
	return {
		id,
		kind: 'validation_rules',
		name,
		artifact_rev: rev,
		updated_at: '',
		updated_by: null,
		entry_points: null
	};
}

/** Mirror of the backend's lock canonicalization: targets go out with the bare
 * id + `type: "artifact"`, leases come back keyed `art:<id>` under one token. */
function mockAcquire() {
	return vi.spyOn(checkoutApi, 'acquireLocks').mockImplementation(async (req) => {
		const token = `t_${req.targets[0].resource_id}`;
		return {
			token,
			leases: req.targets.map((t) => ({
				resource_id: t.type === 'artifact' ? `art:${t.resource_id}` : t.resource_id,
				mode: t.mode,
				holder: 'me',
				token,
				intent: req.intent,
				expires_at: 1
			}))
		};
	});
}

/** What POST /locks throws when a peer holds the artifact. */
function lockConflict(email: string): ConflictError {
	return new ConflictError(
		409,
		{
			conflicts: [
				{ resource_id: 'art:r1', held_by: 'u2', held_by_email: email, held_mode: 'exclusive' }
			]
		},
		'lock conflict'
	);
}

/** The checked-out-editor path: the default role after `resetCheckout` is
 * viewer, which short-circuits the lease open before any network call. */
function asEditor() {
	setProjectInfo({ role: 'editor', lockTtlSeconds: 100 });
}

beforeEach(() => {
	resetRulesEditors();
	resetWorkspaceTabs();
	resetArtifacts();
	resetArtifactEdits();
	resetCheckout();
	vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [] });
	// ensureRulesDraft fires `void lintNow()` unconditionally, so EVERY test here
	// triggers a lint whether or not it cares about one. Without a default stub
	// that escapes to a real fetch against happy-dom's origin. Tests asserting on
	// lint re-spy with their own value.
	vi.spyOn(rulesApi, 'lintRules').mockResolvedValue({ ok: true, errors: [], warnings: [] });
});
afterEach(() => {
	resetRulesEditors();
	resetWorkspaceTabs();
	resetArtifacts();
	vi.restoreAllMocks();
});

describe('rules drafts', () => {
	it('creates a fresh draft carrying the starter template for a rules:draft:* tab', async () => {
		const tabId = openArtifactTab('rules', { artifactId: null, title: 'New rules' });
		expect(tabId).toMatch(/^rules:draft:/);
		const draft = await ensureRulesDraft(tabId);
		expect(draft.artifactId).toBeNull();
		expect(draft.dirty).toBe(false);
		// A comment-only document: it parses to an empty rule set, so the tab
		// opens lint-clean rather than red.
		expect(draft.yaml).toContain('rules:');
		expect(draft.yaml.split('\n').every((l) => l === '' || l.startsWith('#'))).toBe(true);
	});

	it('a fresh never-saved draft does not count as dirty until edited', async () => {
		const tabId = 'rules:draft:9';
		await ensureRulesDraft(tabId);
		expect(hasDirtyRulesDrafts()).toBe(false);
		editRulesDraft(tabId, RULES_YAML);
		expect(hasDirtyRulesDrafts()).toBe(true);
		expect(getRulesDraft(tabId)?.yaml).toBe(RULES_YAML);
	});

	it('loads a saved artifact draft verbatim from payload.yaml', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(RULES_ARTIFACT);
		const tabId = openArtifactTab('rules', { artifactId: 'r1', title: 'House rules' });
		const draft = await ensureRulesDraft(tabId);
		expect(draft.name).toBe('House rules');
		expect(draft.yaml).toBe(RULES_YAML);
		expect(draft.dirty).toBe(false);
	});

	it('treats a TEMP-id tab as an unsaved draft rather than fetching it', async () => {
		asEditor();
		const acquire = mockAcquire();
		const get = vi.spyOn(artifactsApi, 'getArtifact');

		const draft = await ensureRulesDraft('rules:tmp_abc');

		expect(get).not.toHaveBeenCalled();
		expect(acquire).not.toHaveBeenCalled();
		expect(draft.artifactId).toBeNull();
	});

	it('saveRulesDraft on an unsaved draft stages a create and binds the draft to the temp id', async () => {
		const tabId = openArtifactTab('rules', { artifactId: null, title: 'New rules' });
		await ensureRulesDraft(tabId);
		editRulesDraft(tabId, RULES_YAML);
		setRulesName(tabId, 'House rules');
		expect(getRulesDraft(tabId)?.dirty).toBe(true);

		saveRulesDraft(tabId);

		expect(getStagedArtifactOps()).toEqual([
			{
				kind: 'create_artifact',
				temp_id: expect.stringMatching(/^tmp_/),
				artifact_kind: 'validation_rules',
				name: 'House rules',
				payload: { schema_version: 1, yaml: RULES_YAML }
			}
		]);
		const draft = getRulesDraft(tabId)!;
		expect(isTempId(draft.artifactId!)).toBe(true);
		expect(draft.dirty).toBe(false);
		// The tab KEY is NOT re-keyed at stage time: it keeps living under
		// rules:draft:N until the commit's id_map supplies a canonical id. The tab
		// RECORD does follow the draft onto the temp id.
		expect(getDynamicTabs()[0].id).toBe(tabId);
		expect(getDynamicTabs()[0].artifactId).toBe(draft.artifactId);
	});

	it('saveRulesDraft on a saved artifact stages a full-payload update', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(RULES_ARTIFACT);
		await ensureRulesDraft('rules:r1');
		editRulesDraft('rules:r1', '# emptied\n');

		saveRulesDraft('rules:r1');

		expect(getStagedArtifactOps()).toEqual([
			{
				kind: 'update_artifact',
				id: 'r1',
				name: 'House rules',
				payload: { schema_version: 1, yaml: '# emptied\n' }
			}
		]);
		expect(getRulesDraft('rules:r1')?.dirty).toBe(false);
	});

	it('saveRulesDraft refuses a name another rule set already uses', async () => {
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({
			items: [header('r2', 'Taken')]
		});
		await loadArtifacts();
		const tabId = openArtifactTab('rules', { artifactId: null, title: 'New rules' });
		await ensureRulesDraft(tabId);
		setRulesName(tabId, 'Taken');

		expect(() => saveRulesDraft(tabId)).toThrow(/rule set named "Taken" already exists/);
		expect(getStagedArtifactOps()).toEqual([]);
		expect(getRulesDraft(tabId)?.artifactId).toBeNull();
		expect(getRulesDraft(tabId)?.dirty).toBe(true);
	});

	it('a commit rebinds a staged create onto its canonical id', async () => {
		const tabId = openArtifactTab('rules', { artifactId: null, title: 'New rules' });
		await ensureRulesDraft(tabId);
		editRulesDraft(tabId, RULES_YAML);
		setRulesName(tabId, 'Mine');
		saveRulesDraft(tabId);
		const tempId = getRulesDraft(tabId)!.artifactId!;

		notifyArtifactCommit({
			idMap: { [tempId]: 'r9' },
			changed: [header('r9', 'Mine')],
			deletedIds: []
		});

		expect(getRulesDraft(tabId)).toBeUndefined();
		const bound = getRulesDraft('rules:r9')!;
		expect(bound.artifactId).toBe('r9');
		expect(bound.yaml).toBe(RULES_YAML);
		expect(getDynamicTabs()[0].id).toBe('rules:r9');
	});

	it('a staged delete closes the tab and drops the draft', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(RULES_ARTIFACT);
		openArtifactTab('rules', { artifactId: 'r1', title: 'House rules' });
		await ensureRulesDraft('rules:r1');

		stageArtifactDelete('r1', header('r1', 'House rules', 3));

		expect(getRulesDraft('rules:r1')).toBeUndefined();
		expect(getDynamicTabs()).toEqual([]);
	});

	it('close drops the draft', async () => {
		const tabId = openArtifactTab('rules', { artifactId: null, title: 'New rules' });
		await ensureRulesDraft(tabId);
		closeRulesDraft(tabId);
		expect(getRulesDraft(tabId)).toBeUndefined();
	});
});

describe('artifact lease on open', () => {
	it('acquires the art: lease before fetching the payload', async () => {
		asEditor();
		const acquire = mockAcquire();
		const get = vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(RULES_ARTIFACT);

		await ensureRulesDraft('rules:r1');

		expect(acquire.mock.calls[0][0]).toMatchObject({
			targets: [{ resource_id: 'r1', mode: 'exclusive', type: 'artifact' }],
			intent: 'edit'
		});
		expect(acquire.mock.invocationCallOrder[0]).toBeLessThan(get.mock.invocationCallOrder[0]);
		expect(isCheckedOutByMe('art:r1')).toBe(true);
		expect(getRulesLockHolder('rules:r1')).toBeNull();
	});

	it('marks the tab lock-denied (unsaveable) when the lease is refused, but still loads it', async () => {
		asEditor();
		vi.spyOn(checkoutApi, 'acquireLocks').mockRejectedValue(lockConflict('peer@x'));
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(RULES_ARTIFACT);

		const draft = await ensureRulesDraft('rules:r1');

		expect(getRulesLockHolder('rules:r1')).toBe('peer@x');
		// A denial must not refuse the tab — it opens unsaveable with the banner.
		expect(draft.yaml).toBe(RULES_YAML);
	});

	it('fails OPEN when POST /locks errors for a non-conflict reason', async () => {
		asEditor();
		vi.spyOn(checkoutApi, 'acquireLocks').mockRejectedValue(new Error('boom'));
		const get = vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(RULES_ARTIFACT);

		const draft = await ensureRulesDraft('rules:r1');

		expect(get).toHaveBeenCalledWith('r1');
		expect(draft.name).toBe('House rules');
		// No banner: an infrastructure error is not a peer holding the artifact.
		expect(getRulesLockHolder('rules:r1')).toBeNull();
	});

	it('retryRulesLock clears the banner once the peer releases', async () => {
		asEditor();
		const acquire = mockAcquire();
		acquire.mockRejectedValueOnce(lockConflict('peer@x'));
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(RULES_ARTIFACT);
		await ensureRulesDraft('rules:r1');
		expect(getRulesLockHolder('rules:r1')).toBe('peer@x');

		await retryRulesLock('rules:r1');

		expect(getRulesLockHolder('rules:r1')).toBeNull();
		expect(isCheckedOutByMe('art:r1')).toBe(true);
	});

	it('closeRulesDraft releases the lease when nothing staged needs it', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(RULES_ARTIFACT);
		const release = vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		await ensureRulesDraft('rules:r1');

		closeRulesDraft('rules:r1');
		await Promise.resolve();

		expect(release).toHaveBeenCalledWith('t_r1', undefined);
		expect(isCheckedOutByMe('art:r1')).toBe(false);
	});

	it('closeRulesDraft keeps the lease while a staged op still needs it', async () => {
		asEditor();
		mockAcquire();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(RULES_ARTIFACT);
		await ensureRulesDraft('rules:r1');
		saveRulesDraft('rules:r1'); // stages update_artifact r1 — the commit needs it
		const release = vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);

		closeRulesDraft('rules:r1');
		await Promise.resolve();

		expect(release).not.toHaveBeenCalled();
		expect(isCheckedOutByMe('art:r1')).toBe(true);
	});
});

describe('debounced lint', () => {
	it('coalesces keystrokes into one call and installs errors AND drift warnings', async () => {
		vi.useFakeTimers();
		const lint = vi.spyOn(rulesApi, 'lintRules').mockResolvedValue({
			ok: false,
			errors: [{ message: 'Malformed rules YAML', line: 2, column: 5 }],
			warnings: [{ rule: 'r1', message: "unknown stereotype 'Sensor'" }]
		});
		const tabId = 'rules:draft:1';
		await ensureRulesDraft(tabId);
		lint.mockClear(); // drop the open-time lint

		editRulesDraft(tabId, 'rules: [');
		editRulesDraft(tabId, 'rules: [ {');
		await vi.advanceTimersByTimeAsync(RULES_LINT_DEBOUNCE_MS + 10);

		expect(lint).toHaveBeenCalledTimes(1);
		expect(lint).toHaveBeenCalledWith('rules: [ {');
		const draft = getRulesDraft(tabId)!;
		expect(draft.lintErrors).toEqual([{ message: 'Malformed rules YAML', line: 2, column: 5 }]);
		expect(draft.lintWarnings).toEqual([{ rule: 'r1', message: "unknown stereotype 'Sensor'" }]);
		vi.useRealTimers();
	});

	it('keeps drift warnings while ok is true — drift is a degradation, not invalidity', async () => {
		vi.spyOn(rulesApi, 'lintRules').mockResolvedValue({
			ok: true,
			errors: [],
			warnings: [{ rule: 'r1', message: "unknown property 'mass'" }]
		});
		const tabId = 'rules:draft:2';
		await ensureRulesDraft(tabId); // the open-time lint, not the debounced one

		await vi.waitFor(() => expect(getRulesDraft(tabId)?.lintWarnings).toHaveLength(1));
		expect(getRulesDraft(tabId)?.lintErrors).toEqual([]);
	});

	it('reports an over-cap document (422) as a lint error rather than crashing', async () => {
		vi.useFakeTimers();
		vi.spyOn(rulesApi, 'lintRules').mockRejectedValue(new ValidationError(422, {}, 'too long'));
		const tabId = 'rules:draft:3';
		await ensureRulesDraft(tabId);

		editRulesDraft(tabId, 'rules: []\n');
		await vi.advanceTimersByTimeAsync(RULES_LINT_DEBOUNCE_MS + 10);

		expect(getRulesDraft(tabId)?.lintErrors).toEqual([
			{ message: expect.stringMatching(/too large/i), line: null, column: null }
		]);
		vi.useRealTimers();
	});

	it('leaves the last result standing when the lint request fails transiently', async () => {
		vi.useFakeTimers();
		const lint = vi.spyOn(rulesApi, 'lintRules').mockResolvedValue({
			ok: false,
			errors: [{ message: 'Malformed rules YAML', line: 1, column: 1 }],
			warnings: []
		});
		const tabId = 'rules:draft:4';
		await ensureRulesDraft(tabId);
		editRulesDraft(tabId, 'rules: [');
		await vi.advanceTimersByTimeAsync(RULES_LINT_DEBOUNCE_MS + 10);

		lint.mockRejectedValue(new Error('network down'));
		editRulesDraft(tabId, 'rules: [ ');
		await vi.advanceTimersByTimeAsync(RULES_LINT_DEBOUNCE_MS + 10);

		expect(getRulesDraft(tabId)?.lintErrors).toEqual([
			{ message: 'Malformed rules YAML', line: 1, column: 1 }
		]);
		vi.useRealTimers();
	});

	it('a pending lint never lands on a closed tab', async () => {
		vi.useFakeTimers();
		const lint = vi.spyOn(rulesApi, 'lintRules').mockResolvedValue({
			ok: false,
			errors: [{ message: 'boom', line: null, column: null }],
			warnings: []
		});
		const tabId = 'rules:draft:5';
		await ensureRulesDraft(tabId);
		lint.mockClear();

		editRulesDraft(tabId, 'rules: [');
		closeRulesDraft(tabId);
		await vi.advanceTimersByTimeAsync(RULES_LINT_DEBOUNCE_MS + 10);

		expect(lint).not.toHaveBeenCalled();
		expect(getRulesDraft(tabId)).toBeUndefined();
		vi.useRealTimers();
	});
});
