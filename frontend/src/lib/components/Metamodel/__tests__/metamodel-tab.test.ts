import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MetamodelTab from '../MetamodelTab.svelte';
import { resetCheckout, setProjectInfo } from '../../../state/checkout.svelte';
import {
	editMetamodelBuffer,
	getMetamodelEditor,
	previewMetamodelChanges,
	resetMetamodelEditor
} from '../../../state/metamodel-editor.svelte';
import {
	closeMetamodelStage,
	getStagedNodeMoves,
	stageNodeMove
} from '../../../state/metamodel-stage.svelte';
import { setActiveProject } from '../../../state/active-project.svelte';
import * as mmApi from '$lib/api/metamodel';
import * as lockApi from '$lib/api/checkout';
import type { LockResponse, MetamodelDiff } from '$lib/api/types';

const BASE = '# base\nelements: []\n';

// Mirrors metamodel-editor.test.ts's fixtures — the narrowest way to reach an
// edited, previewed buffer without re-deriving that recipe.
const LEASE: LockResponse = {
	token: 't-mm',
	leases: [
		{
			resource_id: 'mm',
			mode: 'exclusive',
			holder: 'default-user',
			holder_email: 'default@example.com',
			token: 't-mm',
			intent: 'edit',
			expires_at: 1
		}
	]
};
const DIFF: MetamodelDiff = {
	now_failing: [],
	now_passing: [],
	unchanged_count: 0,
	current_error_count: 0,
	candidate_error_count: 0,
	structural: {
		enums: { added: [], removed: [], changed: [] },
		element_types: { added: [], removed: [], changed: [] },
		relationship_types: { added: [], removed: [], changed: [] }
	}
};

beforeEach(() => {
	localStorage.clear();
	closeMetamodelStage();
	resetCheckout();
	resetMetamodelEditor();
	setActiveProject('p1');
	vi.spyOn(mmApi, 'getMetamodelRaw').mockResolvedValue({ blob: BASE, source: 'stored' });
	// The tab now boots the diagram half alongside the editor, and that fetches
	// the baseline layout blob. The module swallows a failure by design, so
	// leaving it unmocked costs nothing but a wall of connection-refused noise
	// over every test in this file.
	vi.spyOn(mmApi, 'getMetamodelLayout').mockResolvedValue({ positions: {} });
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = '';
});

async function settle(): Promise<void> {
	// mount()'s onMount doesn't run synchronously — flush it first so the
	// initMetamodelEditor() call it kicks off is actually in flight before we
	// start waiting on its promise chain, or the two ticks below elapse with
	// nothing yet running and the trailing flushSync() only starts the load.
	flushSync();
	await Promise.resolve();
	await Promise.resolve();
	flushSync();
}

/** The tab's init is a CHAIN — editor raw fetch, then the diagram's init, then
 * its layout fetch — and it is the DIAGRAM half that re-points the staging
 * store at this project (`initMetamodelStage`, which clears whatever was
 * staged). Anything a test stages before that lands gets wiped, so cases that
 * stage a node move settle the whole chain first. */
async function settleInit(): Promise<void> {
	for (let i = 0; i < 4; i++) await settle();
}

describe('MetamodelTab', () => {
	it('owner sees Preview, and no Rebind control at all (spec 2026-08-16)', async () => {
		setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });
		const c = mount(MetamodelTab, { target: document.body });
		await settle();
		try {
			const text = document.body.textContent ?? '';
			expect(text).toContain('Preview changes');
			// The metamodel is a staged commit family now: it lands through the
			// Commit drawer's batch, so the tab owns no commit control of its own.
			expect(text).not.toContain('Rebind');
			expect(text).not.toContain('Commit message');
		} finally {
			unmount(c);
		}
	});

	it('non-owner gets the read-only notice and no rebind controls', async () => {
		setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
		const c = mount(MetamodelTab, { target: document.body });
		await settle();
		try {
			const text = document.body.textContent ?? '';
			expect(/read-only/i.test(text)).toBe(true);
			expect(text).not.toContain('Rebind');
		} finally {
			unmount(c);
		}
	});

	it('shows the load-error state with a retry button when raw fetch fails', async () => {
		setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });
		vi.spyOn(mmApi, 'getMetamodelRaw').mockRejectedValue(new Error('boom'));
		const c = mount(MetamodelTab, { target: document.body });
		await settle();
		try {
			const text = document.body.textContent ?? '';
			expect(text).toContain("Couldn't load the metamodel");
			expect(text).toContain('Retry');
		} finally {
			unmount(c);
		}
	});

	it('points a dirty buffer at the Commit drawer instead of a Rebind button', async () => {
		setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });
		vi.spyOn(mmApi, 'lintMetamodel').mockResolvedValue({ ok: true, errors: [] });
		vi.spyOn(lockApi, 'acquireLocks').mockResolvedValue(LEASE);
		vi.spyOn(lockApi, 'releaseLock').mockResolvedValue(undefined);

		const c = mount(MetamodelTab, { target: document.body });
		await settle();
		try {
			// Clean buffer: the hint is a change indicator, so it stays away.
			expect(document.body.textContent ?? '').not.toMatch(/staged/i);

			editMetamodelBuffer(`${BASE}candidate: true\n`);
			await settle();

			expect((document.body.textContent ?? '').replace(/\s+/g, ' ')).toContain(
				'Metamodel changes are staged'
			);
		} finally {
			unmount(c);
		}
	});

	it('keeps the on-demand Preview panel (the tab surface the commit flow did NOT take over)', async () => {
		setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });
		vi.spyOn(mmApi, 'lintMetamodel').mockResolvedValue({ ok: true, errors: [] });
		vi.spyOn(lockApi, 'acquireLocks').mockResolvedValue(LEASE);
		vi.spyOn(lockApi, 'releaseLock').mockResolvedValue(undefined);
		const diff = vi.spyOn(mmApi, 'diffMetamodel').mockResolvedValue(DIFF);

		const c = mount(MetamodelTab, { target: document.body });
		await settle();
		try {
			editMetamodelBuffer(`${BASE}candidate: true\n`);
			await previewMetamodelChanges();
			await settle();

			expect(diff).toHaveBeenCalledWith(`${BASE}candidate: true\n`);
			expect(getMetamodelEditor().previewCurrent).toBe(true);
		} finally {
			unmount(c);
		}
	});

	it('shows the staged hint for node moves alone, with a pristine buffer', async () => {
		setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });

		const c = mount(MetamodelTab, { target: document.body });
		await settleInit();
		try {
			// AFTER the init chain: the diagram's init re-points the stage at this
			// project and would clear anything staged before it.
			stageNodeMove('el:Pump', { x: 1, y: 2 });
			await settle();

			expect(getMetamodelEditor().dirty).toBe(false);
			expect((document.body.textContent ?? '').replace(/\s+/g, ' ')).toContain(
				'Metamodel changes are staged'
			);
		} finally {
			unmount(c);
		}
	});

	it('Discard changes drops the staged node moves as well as the draft', async () => {
		setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });
		vi.spyOn(mmApi, 'lintMetamodel').mockResolvedValue({ ok: true, errors: [] });
		vi.spyOn(lockApi, 'acquireLocks').mockResolvedValue(LEASE);
		vi.spyOn(lockApi, 'releaseLock').mockResolvedValue(undefined);

		const c = mount(MetamodelTab, { target: document.body });
		await settleInit();
		try {
			editMetamodelBuffer(`${BASE}candidate: true\n`);
			stageNodeMove('el:Pump', { x: 1, y: 2 });
			await settle();
			expect(getStagedNodeMoves().size).toBe(1);

			[...document.body.querySelectorAll('button')]
				.find((b) => b.textContent?.trim() === 'Discard changes')
				?.click();
			await settle();

			// One button, one family: leaving the moves behind would keep the `mm`
			// lease alive and re-offer them in the next commit batch.
			expect(getMetamodelEditor().dirty).toBe(false);
			expect(getStagedNodeMoves().size).toBe(0);
		} finally {
			unmount(c);
		}
	});
});
