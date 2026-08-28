// The embedded Test panel: component-local run state, run gating mirroring
// the server's SnippetRunIn validators, and a read-only ops surface. Follows
// the repo's mount/flushSync convention and drives POST /snippets/run through
// MSW (see snippet-source-editor.test.ts).
import { flushSync, mount, unmount } from 'svelte';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { server } from '../../../api/__tests__/server';
import * as modelRead from '$lib/api/model-read';
import type { SnippetSource } from '$lib/api/types';
import SnippetTestPanel from '../SnippetTestPanel.svelte';
import type { DeclaredInput } from '$lib/snippet/run-inputs';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => vi.useFakeTimers()); // the element picker debounces 250 ms
afterEach(() => {
	server.resetHandlers();
	document.body.innerHTML = '';
	vi.restoreAllMocks();
	vi.useRealTimers();
});
afterAll(() => server.close());

const OK_RESULT = {
	run_id: 'r1',
	stdout: '',
	result_repr: "['Alpha']",
	ops: [],
	error: null,
	duration_ms: 3,
	model_rev: 0,
	stale: false,
	truncated: false
};

/** Capture the body of the next POST /snippets/run and answer `response`. */
function captureRun(response: Record<string, unknown> = OK_RESULT): {
	body: () => Record<string, unknown> | null;
} {
	let seen: Record<string, unknown> | null = null;
	server.use(
		http.post('*/snippets/run', async ({ request }) => {
			seen = (await request.json()) as Record<string, unknown>;
			return HttpResponse.json(response);
		})
	);
	return { body: () => seen };
}

function inline(code: string): SnippetSource {
	return { definition: { schema_version: 1, language: 'python', code, entry_points: [] } };
}

function render(props: {
	snippet: SnippetSource;
	entry: 'value' | 'step';
	entryPoints: string[];
	declaredInputs?: DeclaredInput[];
}) {
	const c = mount(SnippetTestPanel, {
		target: document.body,
		props: { onGoToLine: () => {}, ...props }
	});
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

function expand(): void {
	click(testid('snippet-test-toggle'));
}

/** Bind one element by driving the REAL picker inside ElementContextRow:
 * stub the search endpoint, type, let the 250 ms debounce fire, click the
 * result. The panel deliberately exposes no test-only bind method. */
async function bindElement(id: string, label: string): Promise<void> {
	vi.spyOn(modelRead, 'listElementsPage').mockResolvedValue({
		items: [{ id, type_name: 'Block', properties: { name: label }, rev: 1 }],
		total: 1
	});
	const search = testid('snippet-element-search') as HTMLInputElement;
	if (!search) throw new Error('element search not rendered — is the panel expanded?');
	search.value = label;
	search.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
	await vi.advanceTimersByTimeAsync(300);
	flushSync();
	const option = [...document.querySelectorAll('button')].find((b) =>
		b.textContent?.includes(label)
	);
	if (!option) throw new Error(`no search result button for ${label}`);
	click(option);
}

it('is collapsed until the toggle is clicked', () => {
	const c = render({
		snippet: inline('def value(els): return 1\n'),
		entry: 'value',
		entryPoints: ['value']
	});
	try {
		expect(testid('snippet-test-run')).toBeNull();
		expand();
		expect(testid('snippet-test-run')).not.toBeNull();
	} finally {
		unmount(c);
	}
});

it('disables Run until the element count fits the entry', async () => {
	const snippet = inline('def value(els): return 1\n');
	const c = render({ snippet, entry: 'value', entryPoints: ['value'] });
	try {
		expand();
		const run = testid('snippet-test-run') as HTMLButtonElement;
		expect(run.disabled).toBe(true); // value needs >= 1 element
	} finally {
		unmount(c);
	}
});

it('disables Run when the entry point is missing', async () => {
	const c = render({
		snippet: inline('def other(x): return 1\n'),
		entry: 'value',
		entryPoints: ['script']
	});
	try {
		expand();
		await bindElement('a', 'Alpha'); // satisfy countOk so entryOk is the only false term
		expect((testid('snippet-test-run') as HTMLButtonElement).disabled).toBe(true);
	} finally {
		unmount(c);
	}
});

it('disables Run for an unconfigured source', async () => {
	const c = render({ snippet: {}, entry: 'value', entryPoints: ['value'] });
	try {
		expand();
		await bindElement('a', 'Alpha'); // satisfy countOk so configured is the only false term
		expect((testid('snippet-test-run') as HTMLButtonElement).disabled).toBe(true);
	} finally {
		unmount(c);
	}
});

it('posts inline code with the bound elements and renders the result', async () => {
	const captured = captureRun();
	const c = render({
		snippet: inline('def value(els): return 1\n'),
		entry: 'value',
		entryPoints: ['value']
	});
	try {
		expand();
		await bindElement('a', 'Alpha');
		click(testid('snippet-test-run'));
		await vi.waitFor(() => expect(testid('snippet-result')).not.toBeNull());
		const body = captured.body()!;
		expect(body['code']).toContain('def value(els)');
		expect(body['artifact_id']).toBeUndefined();
		expect(body['entry']).toBe('value');
		expect(body['element_ids']).toEqual(['a']);
		expect(typeof body['run_id']).toBe('string');
		expect(testid('snippet-result')?.textContent).toBe("['Alpha']");
	} finally {
		unmount(c);
	}
});

it('posts artifact_id in saved mode', async () => {
	const captured = captureRun();
	const c = render({ snippet: { ref: 'snip-1' }, entry: 'step', entryPoints: ['step'] });
	try {
		expand();
		await bindElement('a', 'Alpha');
		click(testid('snippet-test-run'));
		await vi.waitFor(() => expect(captured.body()).not.toBeNull());
		const body = captured.body()!;
		expect(body['artifact_id']).toBe('snip-1');
		expect(body['code']).toBeUndefined();
		expect(body['entry']).toBe('step');
	} finally {
		unmount(c);
	}
});

it('binds exactly one element for a step entry (a second pick replaces)', async () => {
	const captured = captureRun();
	const c = render({ snippet: { ref: 'snip-1' }, entry: 'step', entryPoints: ['step'] });
	try {
		expand();
		await bindElement('a', 'Alpha');
		await bindElement('b', 'Beta');
		click(testid('snippet-test-run'));
		await vi.waitFor(() => expect(captured.body()).not.toBeNull());
		expect(captured.body()!['element_ids']).toEqual(['b']);
	} finally {
		unmount(c);
	}
});

it('surfaces the 429 and 503 notices', async () => {
	server.use(http.post('*/snippets/run', () => new HttpResponse(null, { status: 429 })));
	const c = render({
		snippet: inline('def value(els): return 1\n'),
		entry: 'value',
		entryPoints: ['value']
	});
	try {
		expand();
		await bindElement('a', 'Alpha');
		click(testid('snippet-test-run'));
		await vi.waitFor(() =>
			expect(testid('snippet-notice')?.textContent).toContain('Another run is already in progress')
		);
	} finally {
		unmount(c);
	}

	server.use(http.post('*/snippets/run', () => new HttpResponse(null, { status: 503 })));
	const c2 = render({
		snippet: inline('def value(els): return 1\n'),
		entry: 'value',
		entryPoints: ['value']
	});
	try {
		expand();
		await bindElement('a', 'Alpha');
		click(testid('snippet-test-run'));
		await vi.waitFor(() =>
			expect(testid('snippet-notice')?.textContent).toContain('Code execution is unavailable')
		);
	} finally {
		unmount(c2);
	}
});

it('shows a notice explaining what is missing when requestRun is invoked while gated (e.g. Ctrl-Enter before an element is bound)', async () => {
	const c = render({
		snippet: inline('def value(els): return 1\n'),
		entry: 'value',
		entryPoints: ['value'] // entry is fine; no element is bound yet, so countOk is the false term
	});
	try {
		expand();
		expect(testid('snippet-test-run')).not.toBeNull();
		await c.requestRun();
		expect(testid('snippet-notice')?.textContent).toContain('element');
	} finally {
		unmount(c);
	}
});

it('lists recorded ops with the read-only warning and no Stage button', async () => {
	captureRun({ ...OK_RESULT, ops: [{ kind: 'delete_element', id: 'e1' }] });
	const c = render({
		snippet: inline('def value(els): return 1\n'),
		entry: 'value',
		entryPoints: ['value']
	});
	try {
		expand();
		await bindElement('a', 'Alpha');
		click(testid('snippet-test-run'));
		await vi.waitFor(() => expect(testid('snippet-ops')).not.toBeNull());
		expect(testid('snippet-stage')).toBeNull();
		expect(testid('snippet-test-ops-readonly')?.textContent).toContain('discarded');
	} finally {
		unmount(c);
	}
});

// ---- named inputs for a two-argument value() --------------------------------

const TWO_ARG = inline('def value(elements, inputs): return 1\n');

it('sends no inputs key when the host declares none', async () => {
	const cap = captureRun();
	const c = render({ snippet: TWO_ARG, entry: 'value', entryPoints: ['value'] });
	try {
		expand();
		await bindElement('a', 'Alpha');
		click(testid('snippet-test-run'));
		await vi.waitFor(() => expect(cap.body()).not.toBeNull());
		expect(cap.body()).not.toHaveProperty('inputs');
	} finally {
		unmount(c);
	}
});

it('binds a declared value input from the textarea', async () => {
	const cap = captureRun();
	const c = render({
		snippet: TWO_ARG,
		entry: 'value',
		entryPoints: ['value'],
		declaredInputs: [{ name: 'qty', kind: 'scalars' }]
	});
	try {
		expand();
		await bindElement('a', 'Alpha');
		const box = document.querySelector('[aria-label="Values for qty"]') as HTMLTextAreaElement;
		box.value = '7\nBuilding One';
		box.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		click(testid('snippet-test-run'));
		await vi.waitFor(() => expect(cap.body()).not.toBeNull());
		expect(cap.body()?.inputs).toEqual({
			qty: { kind: 'scalars', values: [7, 'Building One'] }
		});
	} finally {
		unmount(c);
	}
});

it('ships an unbound declared input as an empty list', async () => {
	const cap = captureRun();
	const c = render({
		snippet: TWO_ARG,
		entry: 'value',
		entryPoints: ['value'],
		declaredInputs: [{ name: 'owners', kind: 'elements' }]
	});
	try {
		expand();
		await bindElement('a', 'Alpha');
		click(testid('snippet-test-run'));
		await vi.waitFor(() => expect(cap.body()).not.toBeNull());
		expect(cap.body()?.inputs).toEqual({ owners: { kind: 'elements', ids: [] } });
	} finally {
		unmount(c);
	}
});

it('binds a declared element input through its own picker', async () => {
	const cap = captureRun();
	const c = render({
		snippet: TWO_ARG,
		entry: 'value',
		entryPoints: ['value'],
		declaredInputs: [{ name: 'owners', kind: 'elements' }]
	});
	try {
		expand();
		await bindElement('a', 'Alpha'); // the run's own bound elements
		// The input's picker is the SECOND search box on the page — the panel's
		// own ElementContextRow renders first.
		const searches = document.querySelectorAll('[data-testid="snippet-element-search"]');
		expect(searches).toHaveLength(2);
		vi.spyOn(modelRead, 'listElementsPage').mockResolvedValue({
			items: [{ id: 'b2', type_name: 'Block', properties: { name: 'Beta' }, rev: 1 }],
			total: 1
		});
		const search = searches[1] as HTMLInputElement;
		search.value = 'Beta';
		search.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		await vi.advanceTimersByTimeAsync(300);
		flushSync();
		const option = [...document.querySelectorAll('button')].find((b) =>
			b.textContent?.includes('Beta')
		);
		click(option ?? null);
		click(testid('snippet-test-run'));
		await vi.waitFor(() => expect(cap.body()).not.toBeNull());
		expect(cap.body()?.inputs).toEqual({ owners: { kind: 'elements', ids: ['b2'] } });
		// ...and the run's own element binding is untouched by the input's.
		expect(cap.body()?.element_ids).toEqual(['a']);
	} finally {
		unmount(c);
	}
});

it('switching an input to values drops the elements it had bound', async () => {
	const cap = captureRun();
	const c = render({
		snippet: TWO_ARG,
		entry: 'value',
		entryPoints: ['value'],
		declaredInputs: [{ name: 'owners', kind: 'elements' }]
	});
	try {
		expand();
		await bindElement('a', 'Alpha');
		const select = document.querySelector(
			'[aria-label="Binding kind for owners"]'
		) as HTMLSelectElement;
		select.value = 'scalars';
		select.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		click(testid('snippet-test-run'));
		await vi.waitFor(() => expect(cap.body()).not.toBeNull());
		expect(cap.body()?.inputs).toEqual({ owners: { kind: 'scalars', values: [] } });
	} finally {
		unmount(c);
	}
});
