import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MetamodelTab from '../MetamodelTab.svelte';
import { resetCheckout, setProjectInfo } from '../../../state/checkout.svelte';
import { resetMetamodelEditor } from '../../../state/metamodel-editor.svelte';
import { setActiveProject } from '../../../state/active-project.svelte';
import * as mmApi from '$lib/api/metamodel';

const BASE = '# base\nelements: []\n';

beforeEach(() => {
	localStorage.clear();
	resetCheckout();
	resetMetamodelEditor();
	setActiveProject('p1');
	vi.spyOn(mmApi, 'getMetamodelRaw').mockResolvedValue({ blob: BASE, source: 'stored' });
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
});
