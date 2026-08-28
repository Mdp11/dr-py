// The exporter entry's Test panel: the whole ENTRY goes to
// POST /exports/preview-transform, the result renders prints + before/after,
// a snippet failure is data (error block, no after-pane), an entry problem is
// the 422's own sentence. Same MSW + mount/flushSync scaffolding as
// Snippet/__tests__/snippet-test-panel.test.ts.
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

const OK = {
	input: '[\n  {\n    "Block": "a"\n  }\n]',
	output: '{\n  "count": 1\n}',
	stdout: 'rows: 1\n',
	error: null,
	truncated: false,
	split_file: null,
	duration_ms: 4
};

function entry(overrides: Partial<ExporterEntry> = {}): ExporterEntry {
	return {
		source: { ref: 'tbl-1' },
		name: 'doc',
		format: 'json',
		folder: '',
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
		expect(testid('transform-test-input')?.textContent).toBe(OK.input);
		expect(testid('transform-test-output')?.textContent).toBe(OK.output);
		expect(testid('transform-test-error')).toBeNull();
		expect(testid('transform-test-truncated')).toBeNull();
		unmount(c);
	});

	it('a snippet failure keeps the before-pane, shows the error, and drops the after-pane', async () => {
		capture({
			...OK,
			output: null,
			stdout: 'before\n',
			error: {
				kind: 'runtime',
				message: 'ValueError: boom',
				traceback:
					'Traceback (most recent call last):\n  File "<snippet>", line 2, in transform\nValueError: boom\n'
			}
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

	it('shows the split/truncation badges when the sample is partial', async () => {
		capture({ ...OK, truncated: true, split_file: 'Alpha.json' });
		const c = render({ entry: entry() });
		click(testid('transform-test-toggle'));
		await runAndSettle();
		expect(testid('transform-test-truncated')).not.toBeNull();
		expect(testid('transform-test-split')?.textContent).toContain('Alpha.json');
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
