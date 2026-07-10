import { beforeEach, describe, expect, it } from 'vitest';
import {
	endProgress,
	getActiveProgress,
	resetProgress,
	setProgressLabel,
	startProgress,
	updateProgress
} from '../progress.svelte';

describe('progress store', () => {
	beforeEach(() => resetProgress());

	it('starts indeterminate and becomes determinate on update', () => {
		const id = startProgress('Uploading…');
		expect(getActiveProgress()).toMatchObject({ label: 'Uploading…', done: null, total: null });
		updateProgress(id, 50, 200);
		expect(getActiveProgress()).toMatchObject({ done: 50, total: 200 });
	});

	it('oldest entry wins; end reveals the next', () => {
		const a = startProgress('A');
		const b = startProgress('B');
		expect(getActiveProgress()?.id).toBe(a);
		endProgress(a);
		expect(getActiveProgress()?.id).toBe(b);
		endProgress(b);
		expect(getActiveProgress()).toBeNull();
	});

	it('relabels and ignores updates to unknown ids', () => {
		const id = startProgress('A');
		setProgressLabel(id, 'B');
		updateProgress(999, 1, 2);
		expect(getActiveProgress()).toMatchObject({ label: 'B', done: null });
	});
});
