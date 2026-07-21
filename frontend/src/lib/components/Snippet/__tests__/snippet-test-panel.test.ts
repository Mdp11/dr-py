// The embedded Test panel (Task 3): component-local run state, run gating
// mirroring the server's SnippetRunIn validators, and a read-only ops
// surface. Follows the repo's mount/flushSync convention and drives
// POST /snippets/run through MSW (see snippet-source-editor.test.ts).
import { flushSync, mount, unmount } from 'svelte';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { server } from '../../../api/__tests__/server';
import * as modelRead from '$lib/api/model-read';
import type { SnippetSource } from '$lib/api/types';
import SnippetTestPanel from '../SnippetTestPanel.svelte';

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
	const c = render({ snippet: inline('def value(els): return 1\n'), entry: 'value', entryPoints: ['value'] });
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
	server.use(
		http.post('*/snippets/run', () => new HttpResponse(null, { status: 429 }))
	);
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

it('ignores a late run response after unmount (runSeq guard)', async () => {
	// Hold the response open with a deferred promise, mirroring the
	// stale-fetch race in snippet-source-editor.test.ts's "does not clobber
	// a newer ref pick" test — here the concurrent event is unmount, not a
	// second pick.
	let resolveRun: ((result: Record<string, unknown>) => void) | undefined;
	const pending = new Promise<Record<string, unknown>>((resolve) => {
		resolveRun = resolve;
	});
	server.use(http.post('*/snippets/run', async () => HttpResponse.json(await pending)));
	const c = render({
		snippet: inline('def value(els): return 1\n'),
		entry: 'value',
		entryPoints: ['value']
	});
	expand();
	await bindElement('a', 'Alpha');
	click(testid('snippet-test-run')); // requestRun captures seq and awaits the response
	unmount(c); // onDestroy bumps runSeq before the response arrives

	resolveRun!(OK_RESULT);
	await pending;
	// Let requestRun's `seq !== runSeq` continuation run to completion.
	await Promise.resolve();
	await Promise.resolve();

	// No throw from the late response, and nothing was written back into
	// the now-empty (unmounted) body.
	expect(document.body.innerHTML).toBe('');
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
