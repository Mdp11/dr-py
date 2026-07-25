// Render tests for the script-warnings recap panel (Task 7). Follows the
// repo's established Svelte-5 render convention (mount/unmount/flushSync)
// used by `Table/__tests__/ColumnManager.test.ts` and
// `Table/__tests__/TableGrid.test.ts` rather than the brief's literal
// `@testing-library/svelte` snippet — that package is not a project
// dependency (see those files' own header comments).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';

import type { ScriptWarning } from '$lib/api/types';
import ScriptWarningsPanel from '../ScriptWarningsPanel.svelte';

const WARNINGS: ScriptWarning[] = [
	{ code: 'nav_unknown_ids', occurrences: 17, total: 42, detail: null },
	{ code: 'sort_needs_script_nav', occurrences: 1, total: 0, detail: null }
];

function render(warnings: ScriptWarning[]) {
	const c = mount(ScriptWarningsPanel, {
		target: document.body,
		props: { id: 'p', warnings }
	});
	flushSync();
	return c;
}

afterEach(() => {
	document.body.innerHTML = '';
});

describe('ScriptWarningsPanel', () => {
	it('renders one formatted line per warning', () => {
		const c = render(WARNINGS);
		try {
			const items = document.querySelectorAll('[data-testid="script-warning-entry"]');
			expect(items).toHaveLength(2);
			expect(items[0].textContent).toContain('42 unknown element ids across 17 calls');
			expect(items[1].textContent).toContain('rows stay in build order');
		} finally {
			unmount(c);
		}
	});

	it('names itself for assistive tech', () => {
		const c = render(WARNINGS);
		try {
			const dialog = document.querySelector('[role="dialog"]');
			expect(dialog).not.toBeNull();
			expect(dialog?.getAttribute('aria-label')).toMatch(/script warnings/i);
		} finally {
			unmount(c);
		}
	});
});
