import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MetamodelTab from '../MetamodelTab.svelte';
import { resetCheckout, setProjectInfo } from '../../../state/checkout.svelte';
import {
	editMetamodelBuffer,
	previewMetamodelChanges,
	resetMetamodelEditor
} from '../../../state/metamodel-editor.svelte';
import { setActiveProject } from '../../../state/active-project.svelte';
import * as mmApi from '$lib/api/metamodel';
import * as lockApi from '$lib/api/checkout';
import type { LockResponse, MetamodelDiff, Rebind } from '$lib/api/types';

const BASE = '# base\nelements: []\n';

// Mirrors metamodel-editor.test.ts's `initEditedAndPreviewed` fixtures — the
// narrowest way to reach a commit-eligible state (edited + previewed-current)
// without re-deriving that recipe.
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
const REBIND: Rebind = {
	model_rev: 5,
	metamodel_id: 'mm2',
	validation_error_count: 0,
	issue_counts: {},
	issues: []
};

beforeEach(() => {
	localStorage.clear();
	resetCheckout();
	resetMetamodelEditor();
	setActiveProject('p1');
	vi.spyOn(mmApi, 'getMetamodelRaw').mockResolvedValue({ blob: BASE, source: 'stored' });
	// The tab now boots the diagram half alongside the editor, and that fetches
	// (and, after a rebind, PUTs) the shared layout blob. The module swallows
	// both failures by design, so leaving them unmocked costs nothing but a wall
	// of connection-refused noise over every test in this file.
	vi.spyOn(mmApi, 'getMetamodelLayout').mockResolvedValue({ positions: {} });
	vi.spyOn(mmApi, 'putMetamodelLayout').mockResolvedValue(undefined);
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

describe('MetamodelTab', () => {
	it('owner sees Preview and Rebind controls', async () => {
		setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });
		const c = mount(MetamodelTab, { target: document.body });
		await settle();
		try {
			const text = document.body.textContent ?? '';
			expect(text).toContain('Preview changes');
			expect(text).toContain('Rebind');
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

	it('disables Discard changes while a rebind is in flight', async () => {
		setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });
		vi.spyOn(mmApi, 'lintMetamodel').mockResolvedValue({ ok: true, errors: [] });
		vi.spyOn(lockApi, 'acquireLocks').mockResolvedValue(LEASE);
		vi.spyOn(lockApi, 'releaseLock').mockResolvedValue(undefined);
		vi.spyOn(mmApi, 'diffMetamodel').mockResolvedValue(DIFF);
		// Never resolves: the assertions below are about the in-flight window.
		vi.spyOn(mmApi, 'rebindMetamodel').mockImplementation(() => new Promise<Rebind>(() => {}));

		const c = mount(MetamodelTab, { target: document.body });
		await settle();
		try {
			editMetamodelBuffer(`${BASE}candidate: true\n`);
			await previewMetamodelChanges();
			await settle();

			const discard = (): HTMLButtonElement | undefined =>
				[...document.body.querySelectorAll('button')].find(
					(b) => b.textContent?.trim() === 'Discard changes'
				);
			expect(discard()?.hasAttribute('disabled')).toBe(false);

			[...document.body.querySelectorAll('button')]
				.find((b) => b.textContent?.trim() === 'Rebind')
				?.click();
			await settle();

			// Adopting the baseline over a buffer whose rebind is in flight has
			// no coherent meaning — the surface refuses the interleaving rather
			// than leaving the state module to reconcile it.
			expect(discard()?.hasAttribute('disabled')).toBe(true);
		} finally {
			unmount(c);
		}
	});

	it('surfaces a failed post-rebind refresh instead of showing stale state, without throwing', async () => {
		setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });
		vi.spyOn(mmApi, 'lintMetamodel').mockResolvedValue({ ok: true, errors: [] });
		vi.spyOn(lockApi, 'acquireLocks').mockResolvedValue(LEASE);
		vi.spyOn(mmApi, 'diffMetamodel').mockResolvedValue(DIFF);
		vi.spyOn(mmApi, 'rebindMetamodel').mockResolvedValue(REBIND);
		// The rebind itself succeeds; only the follow-up refresh call fails.
		vi.spyOn(mmApi, 'getMetamodel').mockRejectedValue(new Error('refresh boom'));
		// Unmount's teardown drops the mm lease this test acquires below —
		// mock the release too, or it fires an unmocked real fetch and the
		// "pristine, no unhandled rejections" bar this test is meant to enforce
		// would be tripped by teardown noise unrelated to what it's testing.
		vi.spyOn(lockApi, 'releaseLock').mockResolvedValue(undefined);

		const c = mount(MetamodelTab, { target: document.body });
		await settle();
		try {
			editMetamodelBuffer(`${BASE}candidate: true\n`);
			await previewMetamodelChanges();
			await settle();

			const rebindBtn = [...document.body.querySelectorAll('button')].find(
				(b) => b.textContent?.trim() === 'Rebind'
			);
			expect(rebindBtn).toBeDefined();
			expect(rebindBtn?.hasAttribute('disabled')).toBe(false);

			rebindBtn?.click();
			// The success path is a longer chain than one settle() covers:
			// commitMetamodelRebind's own internal await, then fetchMetamodel's
			// await inside the try, then the catch and its reactive update each
			// need their own microtask tick before the DOM reflects refreshError.
			await settle();
			await settle();
			await settle();
			await settle();

			const text = document.body.textContent ?? '';
			expect(text).toContain('Rebind succeeded');
			expect(text).toContain('could not refresh');
		} finally {
			unmount(c);
		}
	});
});
