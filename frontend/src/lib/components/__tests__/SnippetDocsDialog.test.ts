import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import SnippetDocsDialog from '../Snippet/SnippetDocsDialog.svelte';
import type { SnippetDocsOut } from '$lib/api/types';

const DOCS: SnippetDocsOut = {
	facade: [
		{
			name: 'dr.create',
			kind: 'function',
			signature: 'dr.create(type_name, properties=None) -> str',
			doc: 'Record a dry-run element create.',
			example: 'tmp = dr.create("Building")'
		},
		{
			name: 'Element.set',
			kind: 'method',
			signature: 'Element.set(key, value)',
			doc: 'Update a property.',
			example: null
		},
		{
			name: 'dr.NotFoundError',
			kind: 'exception',
			signature: 'dr.NotFoundError',
			doc: 'Missing id.',
			example: null
		}
	],
	limits: {
		wall_timeout_s: 10,
		memory_bytes: 268435456,
		stdout_bytes: 262144,
		result_repr_bytes: 65536,
		max_ops: 1000,
		max_op_bytes: 1048576,
		page_limit: 500
	},
	notes: ['Writes are recorded as proposals.']
};

vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	return {
		...actual,
		getSnippetDocs: vi.fn((): SnippetDocsOut | null => DOCS),
		getMetamodel: vi.fn(() => null)
	};
});
import { getSnippetDocs } from '$lib/state';

afterEach(() => {
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

function bodyText(): string {
	return document.body.textContent ?? '';
}

describe('SnippetDocsDialog', () => {
	it('renders the reference tab by default with facade entries', () => {
		const app = mount(SnippetDocsDialog, { target: document.body, props: { open: true } });
		flushSync();
		expect(bodyText()).toContain('dr.create');
		expect(bodyText()).toContain('Record a dry-run element create.');
		void unmount(app);
	});

	it('filter narrows reference entries', async () => {
		const app = mount(SnippetDocsDialog, { target: document.body, props: { open: true } });
		flushSync();
		const input = document.querySelector<HTMLInputElement>('[data-testid="snippet-docs-filter"]');
		expect(input).not.toBeNull();
		input!.value = 'NotFound';
		input!.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(bodyText()).toContain('dr.NotFoundError');
		expect(bodyText()).not.toContain('Element.set');
		void unmount(app);
	});

	it('limits tab shows run limits and notes', async () => {
		const app = mount(SnippetDocsDialog, { target: document.body, props: { open: true } });
		flushSync();
		const tab = document.querySelector<HTMLElement>('[data-testid="snippet-docs-tab-limits"]');
		expect(tab).not.toBeNull();
		tab!.click();
		flushSync();
		expect(bodyText()).toContain('Wall timeout');
		expect(bodyText()).toContain('Writes are recorded as proposals.');
		void unmount(app);
	});

	it('shows the unavailable state without docs', () => {
		vi.mocked(getSnippetDocs).mockReturnValue(null);
		const app = mount(SnippetDocsDialog, { target: document.body, props: { open: true } });
		flushSync();
		expect(bodyText()).toContain('Docs unavailable.');
		void unmount(app);
	});
});
