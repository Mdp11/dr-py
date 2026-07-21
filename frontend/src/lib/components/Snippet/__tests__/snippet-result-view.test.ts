// SnippetResultView is pure presentation (Task 2): every branch is a function
// of its props, so these tests need no store and no MSW.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it } from 'vitest';

import type { SnippetRunOut } from '$lib/api/snippets';
import SnippetResultView from '../SnippetResultView.svelte';

function result(over: Partial<SnippetRunOut> = {}): SnippetRunOut {
	return {
		run_id: 'r1',
		stdout: '',
		result_repr: null,
		ops: [],
		error: null,
		duration_ms: 7,
		model_rev: 0,
		stale: false,
		truncated: false,
		...over
	} as SnippetRunOut;
}

function render(props: Record<string, unknown>) {
	const c = mount(SnippetResultView, {
		target: document.body,
		props: { phase: 'idle', notice: null, result: null, stale: false, onGoToLine: () => {}, ...props }
	});
	flushSync();
	return c;
}

afterEach(() => {
	document.body.innerHTML = '';
});

it('renders stdout, the result repr and the duration footer', () => {
	const c = render({ result: result({ stdout: 'hello', result_repr: "['A']" }) });
	try {
		expect(document.querySelector('[data-testid="snippet-stdout"]')?.textContent).toBe('hello');
		expect(document.querySelector('[data-testid="snippet-result"]')?.textContent).toBe("['A']");
		expect(document.body.textContent).toContain('7 ms');
	} finally {
		unmount(c);
	}
});

it('lists ops and renders nothing under them without an opsFooter', () => {
	const ops = [{ kind: 'delete_element', id: 'e1' }] as SnippetRunOut['ops'];
	const c = render({ result: result({ ops }) });
	try {
		expect(document.querySelector('[data-testid="snippet-ops"]')?.textContent).toContain(
			'delete e1'
		);
		expect(document.querySelector('[data-testid="snippet-stage"]')).toBeNull();
	} finally {
		unmount(c);
	}
});

it('shows the running spinner and the notice line', () => {
	const c = render({ phase: 'running', notice: 'Another run is already in progress.' });
	try {
		expect(document.body.textContent).toContain('Running…');
		expect(document.querySelector('[data-testid="snippet-notice"]')?.textContent).toContain(
			'Another run is already in progress.'
		);
	} finally {
		unmount(c);
	}
});

it('renders the error box with its kind label', () => {
	const c = render({
		result: result({ error: { kind: 'runtime', message: 'boom', traceback: null } })
	});
	try {
		const box = document.querySelector('[data-testid="snippet-error"]');
		expect(box?.textContent).toContain('Runtime error');
		expect(box?.textContent).toContain('boom');
	} finally {
		unmount(c);
	}
});

it('shows the stale banner when told it is stale', () => {
	const c = render({ result: result(), stale: true });
	try {
		expect(document.querySelector('[data-testid="snippet-stale"]')).not.toBeNull();
	} finally {
		unmount(c);
	}
});
