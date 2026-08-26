// The commit drawer is a fixed-width dialog (`max-w-2xl`). A row's label or
// id is an unbroken string — a long bare id, a name without spaces — and a
// flex child with no `min-w-0` refuses to shrink below its content, so the
// text spills OUTSIDE the dialog instead of wrapping. happy-dom has no layout
// engine, so this pins the classes that make the text wrap rather than
// measuring the overflow itself.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it } from 'vitest';

import DiffRow from '../DiffRow.svelte';

afterEach(() => {
	document.body.innerHTML = '';
});

const LONG_ID = 'a'.repeat(120);
const LONG_NAME = 'Unbroken_Name_' + 'x'.repeat(120);

it('lets a long label and a long id wrap instead of overflowing the row', () => {
	const c = mount(DiffRow, {
		target: document.body,
		props: {
			diff: {
				id: LONG_ID,
				status: 'added',
				after: { id: LONG_ID, type_name: 'Pump', properties: { name: LONG_NAME }, rev: 1 }
			},
			kind: 'element'
		}
	});
	flushSync();
	try {
		const spans = [...document.body.querySelectorAll('span')];
		const label = spans.find((s) => s.textContent === LONG_NAME);
		const id = spans.find((s) => s.textContent === LONG_ID);
		expect(label).toBeDefined();
		expect(id).toBeDefined();
		expect(label!.className).toMatch(/\bmin-w-0\b/);
		expect(label!.className).toMatch(/\bbreak-words\b/);
		// an id has no word boundaries at all, so it must break anywhere
		expect(id!.className).toMatch(/\bbreak-all\b/);
	} finally {
		unmount(c);
	}
});
