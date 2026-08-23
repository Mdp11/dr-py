// Render tests for the ref-only export transform picker. Mirrors the mount
// scaffolding used across Export/__tests__ (mocked $lib/api/artifacts + real
// $lib/state store, `mount`/`flushSync`/`unmount`).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import { loadArtifacts, resetArtifacts } from '$lib/state';
import TransformPicker from '../TransformPicker.svelte';

const WITH_TRANSFORM = {
	id: 'snip-1',
	kind: 'code_snippet',
	name: 'Redact PII',
	artifact_rev: 1,
	updated_at: '',
	updated_by: null,
	entry_points: ['script', 'transform']
};

const WITHOUT_TRANSFORM = {
	id: 'snip-2',
	kind: 'code_snippet',
	name: 'Just a value snippet',
	artifact_rev: 1,
	updated_at: '',
	updated_by: null,
	entry_points: ['script', 'value']
};

const NAV_HEADER = {
	id: 'nav-1',
	kind: 'navigation',
	name: 'Some navigation',
	artifact_rev: 1,
	updated_at: '',
	updated_by: null,
	entry_points: null
};

let mounted: ReturnType<typeof mount>[] = [];

beforeEach(() => {
	resetArtifacts();
});

afterEach(() => {
	for (const m of mounted) unmount(m);
	mounted = [];
	document.body.innerHTML = '';
	resetArtifacts();
	vi.restoreAllMocks();
});

function render(value: string | null, onChange: (ref: string | null) => void, disabled = false) {
	const host = mount(TransformPicker, {
		target: document.body,
		props: { value, disabled, onChange }
	});
	mounted.push(host);
	flushSync();
	return document.body;
}

function select(): HTMLSelectElement {
	return document.querySelector('[data-testid="transform-picker"]') as HTMLSelectElement;
}

describe('TransformPicker', () => {
	it('lists only code_snippet artifacts whose entry_points include transform', async () => {
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({
			items: [WITH_TRANSFORM, WITHOUT_TRANSFORM, NAV_HEADER]
		});
		await loadArtifacts();

		render(null, vi.fn());

		const options = [...select().options].map((o) => ({ value: o.value, text: o.textContent }));
		expect(options.some((o) => o.value === 'snip-1')).toBe(true);
		expect(options.some((o) => o.value === 'snip-2')).toBe(false);
		expect(options.some((o) => o.value === 'nav-1')).toBe(false);
	});

	it('renders a "None" option; picking it calls onChange(null)', async () => {
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [WITH_TRANSFORM] });
		await loadArtifacts();

		const onChange = vi.fn();
		render('snip-1', onChange);

		const el = select();
		el.value = '';
		el.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();

		expect(onChange).toHaveBeenCalledWith(null);
	});

	it('picking a snippet calls onChange(its id)', async () => {
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [WITH_TRANSFORM] });
		await loadArtifacts();

		const onChange = vi.fn();
		render(null, onChange);

		const el = select();
		el.value = 'snip-1';
		el.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();

		expect(onChange).toHaveBeenCalledWith('snip-1');
	});

	it('a selected ref that fell out of the option list renders the "(missing)" option rather than being silently cleared', async () => {
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [WITH_TRANSFORM] });
		await loadArtifacts();

		const onChange = vi.fn();
		render('snip-deleted', onChange);

		const options = [...select().options].map((o) => ({ value: o.value, text: o.textContent }));
		expect(options.some((o) => o.value === 'snip-deleted' && o.text?.includes('missing'))).toBe(
			true
		);
		expect(select().value).toBe('snip-deleted');
		// Never silently cleared: onChange is not invoked just because the
		// current value fell out of the filtered list.
		expect(onChange).not.toHaveBeenCalled();
	});
});
