import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ProgressOverlay from '../ProgressOverlay.svelte';
import {
	endProgress,
	resetProgress,
	startProgress,
	updateProgress
} from '$lib/state/progress.svelte';

describe('ProgressOverlay', () => {
	let component: ReturnType<typeof mount>;

	beforeEach(() => {
		resetProgress();
		component = mount(ProgressOverlay, { target: document.body });
		flushSync();
	});

	afterEach(() => {
		unmount(component);
		document.body.innerHTML = '';
	});

	it('renders nothing when idle', () => {
		expect(document.querySelector('[data-testid="progress-overlay"]')).toBeNull();
	});

	it('shows indeterminate (no percent) then determinate with centered number', () => {
		const id = startProgress('Uploading…');
		flushSync();
		expect(document.querySelector('[data-testid="progress-overlay"]')).not.toBeNull();
		expect(document.querySelector('[data-testid="progress-percent"]')).toBeNull();
		updateProgress(id, 30, 60);
		flushSync();
		expect(document.querySelector('[data-testid="progress-percent"]')?.textContent).toBe('50%');
		endProgress(id);
		flushSync();
		expect(document.querySelector('[data-testid="progress-overlay"]')).toBeNull();
	});

	it('renders a spinner (not a bar) while indeterminate — a partial bar reads as stuck', () => {
		const id = startProgress('Opening project…');
		flushSync();
		expect(document.querySelector('[data-testid="progress-spinner"]')).not.toBeNull();
		updateProgress(id, 1, 4);
		flushSync();
		// determinate: the spinner yields to the percentage bar
		expect(document.querySelector('[data-testid="progress-spinner"]')).toBeNull();
		expect(document.querySelector('[data-testid="progress-percent"]')?.textContent).toBe('25%');
		endProgress(id);
		flushSync();
	});
});
