// Render tests for the export transform hook's nullable-edge wrapper: `null`
// (no transform at all) versus a `SnippetSource` the shared
// `SnippetSourceEditor` owns. Everything about ref/inline MODE is that
// editor's own contract (Snippet/__tests__/snippet-source-editor.test.ts);
// what is asserted here is the add/remove edge, the delegation, and the
// `disabled` gate. Mirrors the mount scaffolding used across
// Export/__tests__ (mocked $lib/api/artifacts + the real $lib/state store,
// `mount`/`flushSync`/`unmount`).
import { flushSync, mount, unmount } from 'svelte';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '../../../api/__tests__/server';
import * as artifactsApi from '$lib/api/artifacts';
import { loadArtifacts, resetArtifacts, resetSnippetCollapse } from '$lib/state';
import type { SnippetSource } from '$lib/api/types';
import TransformSourceEditor from '../TransformSourceEditor.svelte';

const TRANSFORM_SNIPPET = {
	id: 'snip-1',
	kind: 'code_snippet',
	name: 'Redact PII',
	artifact_rev: 1,
	updated_at: '',
	updated_by: null,
	entry_points: ['script', 'transform']
};

const VALUE_ONLY_SNIPPET = {
	id: 'snip-2',
	kind: 'code_snippet',
	name: 'Just a value snippet',
	artifact_rev: 1,
	updated_at: '',
	updated_by: null,
	entry_points: ['script', 'value']
};

function inlineSource(code: string): SnippetSource {
	return { definition: { schema_version: 1, language: 'python', code, entry_points: [] } };
}

let mounted: ReturnType<typeof mount>[] = [];

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
	resetArtifacts();
	// Inline mode lints on a 300 ms debounce; every test here unmounts well
	// before that, but the handler keeps an escaping request from tripping
	// msw's onUnhandledRequest: 'error'.
	server.use(
		http.post('*/snippets/lint', () =>
			HttpResponse.json({ diagnostics: [], entry_points: ['script', 'transform'] })
		)
	);
});
afterEach(() => {
	for (const m of mounted) unmount(m);
	mounted = [];
	server.resetHandlers();
	document.body.innerHTML = '';
	resetArtifacts();
	resetSnippetCollapse();
	vi.restoreAllMocks();
});
afterAll(() => server.close());

async function seedHeaders(items: unknown[] = [TRANSFORM_SNIPPET, VALUE_ONLY_SNIPPET]) {
	vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({
		items: items as never
	});
	await loadArtifacts();
}

function render(
	value: SnippetSource | null,
	onChange: (next: SnippetSource | null) => void,
	extra: { disabled?: boolean; collapseKey?: string } = {}
) {
	const c = mount(TransformSourceEditor, {
		target: document.body,
		props: { value, onChange, ...extra }
	});
	mounted.push(c);
	flushSync();
	return c;
}

const byTestId = (id: string): HTMLElement | null =>
	document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

function click(el: Element | null): void {
	if (!el) throw new Error('element not found');
	el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	flushSync();
}

describe('TransformSourceEditor — the nullable edge', () => {
	it('renders only the add affordance for a null value', () => {
		render(null, vi.fn());
		expect(byTestId('transform-add')).not.toBeNull();
		expect(byTestId('transform-add')!.textContent).toMatch(/add transform/i);
		expect(byTestId('snippet-source-editor')).toBeNull();
		expect(byTestId('transform-remove')).toBeNull();
	});

	it('adding writes the tolerant unconfigured source, so the editor opens in saved mode with nothing picked', () => {
		const onChange = vi.fn();
		render(null, onChange);
		click(byTestId('transform-add'));
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith({});
	});

	it('renders the delegated editor and a remove affordance for a non-null value', () => {
		render({}, vi.fn());
		expect(byTestId('transform-add')).toBeNull();
		expect(byTestId('snippet-source-editor')).not.toBeNull();
		expect(byTestId('transform-remove')).not.toBeNull();
	});

	it('removing writes null, never the unconfigured `{}`', () => {
		const onChange = vi.fn();
		render({ ref: 'snip-1' }, onChange);
		click(byTestId('transform-remove'));
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith(null);
	});
});

describe('TransformSourceEditor — delegation', () => {
	it('binds the delegated editor to the transform entry point in saved mode', async () => {
		await seedHeaders();
		render({ ref: 'snip-1' }, vi.fn());

		const sel = byTestId('snippet-ref-select') as HTMLSelectElement;
		const opts = [...sel.options].map((o) => o.value);
		expect(opts).toContain('snip-1');
		// entry="transform": a value-only snippet is not a candidate here.
		expect(opts).not.toContain('snip-2');
		// No console run exists for transform — the test panel must not mount.
		expect(byTestId('snippet-test-toggle')).toBeNull();
	});

	it('names the transform entry point in the missing-ref hint', async () => {
		await seedHeaders([TRANSFORM_SNIPPET]);
		render({ ref: 'gone' }, vi.fn());
		expect(byTestId('snippet-ref-missing')?.textContent).toContain(
			'snippet not found or lacks a transform() entry point'
		);
	});

	it('renders inline code through the delegated editor and forwards its edits verbatim', () => {
		const onChange = vi.fn();
		render(inlineSource('def transform(doc):\n    return doc\n'), onChange);
		expect(byTestId('snippet-editor-box')).not.toBeNull();
		expect(document.body.textContent).toContain('def transform(doc):');

		// Switching back to saved mode is the shared editor's own control; the
		// wrapper passes it straight through rather than intercepting it.
		click(byTestId('snippet-mode-ref'));
		expect(onChange).toHaveBeenCalledWith({});
	});

	it('forwards collapseKey, so the editor renders behind a (default-collapsed) disclosure', () => {
		render({ ref: 'snip-1' }, vi.fn(), { collapseKey: 'exp:1::entry:0::transform' });
		expect(byTestId('snippet-collapse-toggle')).not.toBeNull();
		expect(byTestId('snippet-mode-ref')).toBeNull();

		click(byTestId('snippet-collapse-toggle'));
		expect(byTestId('snippet-mode-ref')).not.toBeNull();
	});
});

describe('TransformSourceEditor — disabled', () => {
	it('leaves the add affordance live when enabled', () => {
		const onChange = vi.fn();
		render(null, onChange, { disabled: false });
		expect((byTestId('transform-add') as HTMLButtonElement).disabled).toBe(false);
		click(byTestId('transform-add'));
		expect(onChange).toHaveBeenCalledWith({});
	});

	it('gates the add affordance', () => {
		const onChange = vi.fn();
		render(null, onChange, { disabled: true });
		expect((byTestId('transform-add') as HTMLButtonElement).disabled).toBe(true);
		click(byTestId('transform-add'));
		expect(onChange).not.toHaveBeenCalled();
	});

	it('gates the remove affordance', () => {
		const onChange = vi.fn();
		render({ ref: 'snip-1' }, onChange, { disabled: true });
		expect((byTestId('transform-remove') as HTMLButtonElement).disabled).toBe(true);
		click(byTestId('transform-remove'));
		expect(onChange).not.toHaveBeenCalled();
	});

	it('forwards `disabled` into the delegated editor — a read-only surface must not author code', async () => {
		await seedHeaders();
		render({ ref: 'snip-1' }, vi.fn(), { disabled: true });
		expect((byTestId('snippet-mode-ref') as HTMLButtonElement).disabled).toBe(true);
		expect((byTestId('snippet-mode-inline') as HTMLButtonElement).disabled).toBe(true);
		expect((byTestId('snippet-ref-select') as HTMLSelectElement).disabled).toBe(true);
	});

	it('leaves the delegated editor editable when enabled', async () => {
		await seedHeaders();
		render({ ref: 'snip-1' }, vi.fn(), { disabled: false });
		expect((byTestId('snippet-mode-inline') as HTMLButtonElement).disabled).toBe(false);
		expect((byTestId('snippet-ref-select') as HTMLSelectElement).disabled).toBe(false);
	});
});
