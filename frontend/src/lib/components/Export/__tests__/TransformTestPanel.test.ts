// The exporter entry's Test panel: the whole ENTRY goes to
// POST /exports/preview-transform, the result renders prints + before/after
// per file (flat for the single unsplit file, one collapsible per file for a
// split run), a snippet failure is data (error block, no after-pane), an
// entry problem is the 422's own sentence. Same MSW + mount/flushSync
// scaffolding as Snippet/__tests__/snippet-test-panel.test.ts.
import { flushSync, mount, unmount } from 'svelte';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { server } from '../../../api/__tests__/server';
import type { ExporterEntry } from '$lib/api/types';
import TransformTestPanel from '../TransformTestPanel.svelte';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
	server.resetHandlers();
	document.body.innerHTML = '';
});
afterAll(() => server.close());

const FILE = {
	filename: 'doc.json',
	input: '[\n  {\n    "Block": "a"\n  }\n]',
	output: '{\n  "count": 1\n}',
	stdout: 'rows: 1\n',
	error: null,
	duration_ms: 4
};
const OK = { files: [FILE], split: false, truncated: false, duration_ms: 6 };
const BOOM = {
	kind: 'runtime',
	message: 'ValueError: boom',
	traceback:
		'Traceback (most recent call last):\n  File "<snippet>", line 2, in transform\nValueError: boom\n'
};

function entry(overrides: Partial<ExporterEntry> = {}): ExporterEntry {
	return {
		source: { ref: 'tbl-1' },
		name: 'doc',
		format: 'json',
		folder: '',
		split_folder: true,
		columns: [],
		export_order: [],
		show_row_numbers: false,
		transform: {
			definition: {
				schema_version: 1,
				language: 'python',
				code: 'def transform(doc):\n    return doc\n',
				entry_points: []
			}
		},
		...overrides
	};
}

function capture(response: Record<string, unknown> = OK, status = 200) {
	let seen: Record<string, unknown> | null = null;
	server.use(
		http.post('*/exports/preview-transform', async ({ request }) => {
			seen = (await request.json()) as Record<string, unknown>;
			return HttpResponse.json(response, { status });
		})
	);
	return { body: () => seen };
}

function render(props: { entry: ExporterEntry; onGoToLine?: (l: number) => void }) {
	const c = mount(TransformTestPanel, { target: document.body, props });
	flushSync();
	return c;
}

function testid(id: string): HTMLElement | null {
	return document.querySelector(`[data-testid="${id}"]`);
}

function click(el: Element | null): void {
	if (!el) throw new Error('element not found');
	el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	flushSync();
}

async function runAndSettle(): Promise<void> {
	click(testid('transform-test-run'));
	await new Promise((r) => setTimeout(r, 0));
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

describe('TransformTestPanel', () => {
	it('starts collapsed and needs no element binding', () => {
		const c = render({ entry: entry() });
		expect(testid('transform-test-run')).toBeNull();
		click(testid('transform-test-toggle'));
		expect(testid('transform-test-run')).not.toBeNull();
		expect(document.querySelector('[data-testid="element-context-row"]')).toBeNull();
		unmount(c);
	});

	it('posts the whole entry and renders prints, before and after', async () => {
		const seen = capture();
		const e = entry({
			json_doc: { shape: 'object', key_column: 0, pretty: true, on_error: 'emit' }
		});
		const c = render({ entry: e });
		click(testid('transform-test-toggle'));
		await runAndSettle();
		expect(seen.body()).toEqual({ entry: e });
		expect(testid('transform-test-stdout')?.textContent).toBe('rows: 1\n');
		expect(testid('transform-test-input')?.textContent).toBe(FILE.input);
		expect(testid('transform-test-output')?.textContent).toBe(FILE.output);
		expect(testid('transform-test-error')).toBeNull();
		expect(testid('transform-test-truncated')).toBeNull();
		unmount(c);
	});

	it('a snippet failure keeps the before-pane, shows the error, and drops the after-pane', async () => {
		capture({
			...OK,
			files: [{ ...FILE, output: null, stdout: 'before\n', error: BOOM }]
		});
		const jumps: number[] = [];
		const c = render({ entry: entry(), onGoToLine: (l) => jumps.push(l) });
		click(testid('transform-test-toggle'));
		await runAndSettle();
		expect(testid('transform-test-stdout')?.textContent).toBe('before\n');
		expect(testid('transform-test-input')).not.toBeNull();
		expect(testid('transform-test-output')).toBeNull();
		expect(testid('transform-test-no-output')).not.toBeNull();
		expect(testid('transform-test-error')?.textContent).toContain('boom');
		// Traceback frames jump the host's editor, as in the snippet console.
		click(testid('transform-test-error')!.querySelector('button'));
		const frame = [...testid('transform-test-error')!.querySelectorAll('button')].find((b) =>
			b.textContent?.includes('line 2')
		);
		click(frame ?? null);
		expect(jumps).toEqual([2]);
		unmount(c);
	});

	it('shows the truncation badge when the sample is partial', async () => {
		capture({ ...OK, truncated: true });
		const c = render({ entry: entry() });
		click(testid('transform-test-toggle'));
		await runAndSettle();
		expect(testid('transform-test-truncated')?.textContent).toContain('head of the table');
		expect(testid('transform-test-input')).not.toBeNull();
		unmount(c);
	});

	it('a split run renders one collapsible per file, all collapsed, named by file', async () => {
		capture({
			files: [
				{ ...FILE, filename: 'Alpha.json' },
				{ ...FILE, filename: 'Beta.json', output: null, error: BOOM },
				{ ...FILE, filename: 'Gamma.json' }
			],
			split: true,
			truncated: false,
			duration_ms: 12
		});
		const c = render({ entry: entry() });
		click(testid('transform-test-toggle'));
		await runAndSettle();
		const files = [...document.querySelectorAll('[data-testid="transform-test-file"]')];
		expect(files.map((f) => f.getAttribute('data-filename'))).toEqual([
			'Alpha.json',
			'Beta.json',
			'Gamma.json'
		]);
		// All collapsed: nothing of any file's body is in the DOM yet.
		expect(testid('transform-test-input')).toBeNull();
		expect(testid('transform-test-output')).toBeNull();
		expect(testid('transform-test-error')).toBeNull();
		// The header names the file and flags the one whose transform failed.
		const headers = files.map((f) => f.querySelector('[data-testid="transform-test-file-toggle"]'));
		expect(headers[1]?.getAttribute('aria-expanded')).toBe('false');
		expect(headers[1]?.textContent).toContain('Beta.json');
		expect(files[1].querySelector('[data-testid="transform-test-file-failed"]')).not.toBeNull();
		expect(files[0].querySelector('[data-testid="transform-test-file-failed"]')).toBeNull();
		// Expanding one shows only that file's before/after.
		click(headers[1]);
		expect(headers[1]?.getAttribute('aria-expanded')).toBe('true');
		expect(document.querySelectorAll('[data-testid="transform-test-input"]').length).toBe(1);
		expect(testid('transform-test-error')?.textContent).toContain('boom');
		expect(testid('transform-test-no-output')).not.toBeNull();
		click(headers[0]);
		expect(document.querySelectorAll('[data-testid="transform-test-input"]').length).toBe(2);
		expect(document.querySelectorAll('[data-testid="transform-test-output"]').length).toBe(1);
		unmount(c);
	});

	it('a split run past the file cap says more files exist', async () => {
		capture({
			files: [{ ...FILE, filename: 'Alpha.json' }],
			split: true,
			truncated: true,
			duration_ms: 3
		});
		const c = render({ entry: entry() });
		click(testid('transform-test-toggle'));
		await runAndSettle();
		expect(testid('transform-test-truncated')?.textContent).toContain('file');
		expect(testid('transform-test-truncated')?.textContent).not.toContain('head of the table');
		unmount(c);
	});

	it("a 422 shows the server's own sentence", async () => {
		capture({ detail: 'doc: transform is only supported for JSON-family formats' }, 422);
		const c = render({ entry: entry({ format: 'csv' }) });
		click(testid('transform-test-toggle'));
		await runAndSettle();
		expect(testid('transform-test-notice')?.textContent).toContain('JSON-family');
		expect(testid('transform-test-input')).toBeNull();
		unmount(c);
	});

	it('an unconfigured transform disables Run and requestRun explains why', async () => {
		const c = render({ entry: entry({ transform: {} }) });
		click(testid('transform-test-toggle'));
		expect((testid('transform-test-run') as HTMLButtonElement).disabled).toBe(true);
		await (c as unknown as { requestRun: () => Promise<void> }).requestRun();
		flushSync();
		expect(testid('transform-test-notice')?.textContent).toContain('Pick a saved snippet');
		unmount(c);
	});
});
