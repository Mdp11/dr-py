import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { server } from '$lib/api/__tests__/server';
import { installKeyboardShortcuts } from '../keyboard.svelte';
import { getDiffDrawerOpen, setDiffDrawerOpen } from '../state';
import { isReplicaBlocked, retryReplica } from '../state/replica.svelte';
import {
	engineStore,
	forceFailed,
	type EngineStore
} from '../state/__tests__/support/engine-store';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

let store: EngineStore | null = null;
let uninstall: (() => void) | null = null;

afterEach(() => {
	uninstall?.();
	uninstall = null;
	store?.dispose();
	store = null;
	setDiffDrawerOpen(false);
});

const save = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));

describe('the save shortcut', () => {
	it('opens no commit drawer while the replica blocks the workspace', async () => {
		store = await engineStore();
		const s = store;
		uninstall = installKeyboardShortcuts();

		await forceFailed(s, { waitForReady: false });
		expect(isReplicaBlocked()).toBe(true);
		save();
		expect(getDiffDrawerOpen()).toBe(false);

		s.project.fail('snapshot', 503, 0);
		const ready = s.until((status) => status.phase === 'ready');
		retryReplica();
		await ready;
		save();
		expect(getDiffDrawerOpen()).toBe(true);
	});
});
