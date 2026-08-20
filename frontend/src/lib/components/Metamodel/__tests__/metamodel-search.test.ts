import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as mmApi from '$lib/api/metamodel';
import { FIXTURE } from '$lib/metamodel/__tests__/fixtures';
import type { DiagramSelection } from '$lib/metamodel/diagram-build';
import { setActiveProject } from '../../../state/active-project.svelte';
import { resetCheckout, setProjectInfo } from '../../../state/checkout.svelte';
import { initMetamodelEditor, resetMetamodelEditor } from '../../../state/metamodel-editor.svelte';
import MetamodelSearchHost from './MetamodelSearchHost.svelte';

/** A metamodel draft carrying TWO `Zone` element blocks. `mm.elements` is a
 * plain `z.array` (yaml-edit.ts), so a duplicated same-named block survives
 * parsing intact — and hand-editing the YAML, which is the entire point of
 * this surface, reaches that state with one copy-paste. The dropdown has to
 * render it, not die on it. */
const DUP_FIXTURE = FIXTURE.replace(
	'  - name: Building\n    extends: NamedElement\n',
	'  - name: Building\n    extends: NamedElement\n  - name: Zone\n    extends: NamedElement\n'
);

/** Same seeding recipe as metamodel-tab.test.ts: the search reads
 * `getMetamodelDiagramView().mm`, which parses the REAL editor module's
 * buffer, so the editor is initialized with the fixture over spied APIs. */
beforeEach(async () => {
	localStorage.clear();
	resetCheckout();
	resetMetamodelEditor();
	setActiveProject('p1');
	setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });
	vi.spyOn(mmApi, 'getMetamodelRaw').mockResolvedValue({ blob: FIXTURE, source: 'stored' });
	vi.spyOn(mmApi, 'getMetamodelLayout').mockResolvedValue({ positions: {} });
	await initMetamodelEditor('p1');
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = '';
});

function input(): HTMLInputElement {
	const el = document.querySelector('[data-testid="mm-search-input"]');
	if (!(el instanceof HTMLInputElement)) throw new Error('search input not rendered');
	return el;
}

function type(text: string): void {
	const el = input();
	el.value = text;
	el.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

function press(key: string): void {
	input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
	flushSync();
}

function rows(): string[] {
	return [...document.querySelectorAll('[data-testid="mm-search-hit"]')].map(
		(r) => r.textContent ?? ''
	);
}

describe('MetamodelSearch', () => {
	// AMENDMENT 1: the fixture yields FOUR hits for 'o' (Observes, Contains,
	// Monitors, Zone) — `Contains` has an 'o' at index 1 and was omitted from
	// the original brief's count. Verified against Task 6's own matcher tests.
	it('shows ranked hits with kind badges while typing', () => {
		const c = mount(MetamodelSearchHost, { target: document.body, props: {} });
		flushSync();
		try {
			type('o');
			const r = rows();
			expect(r).toHaveLength(4);
			expect(r[0]).toContain('Observes');
			expect(r[0]).toContain('no mappings');
			expect(r[1]).toContain('Contains');
			expect(r[2]).toContain('Monitors');
			expect(r[3]).toContain('Zone');
		} finally {
			unmount(c);
		}
	});

	it('ArrowDown/Enter picks the active hit and clears the input', () => {
		const picked: DiagramSelection[] = [];
		const c = mount(MetamodelSearchHost, {
			target: document.body,
			props: { onReveal: (sel: DiagramSelection) => picked.push(sel) }
		});
		flushSync();
		try {
			type('o');
			press('ArrowDown'); // active: Contains
			press('Enter');
			expect(picked).toEqual([{ kind: 'relationship', name: 'Contains' }]);
			expect(input().value).toBe('');
			expect(rows()).toHaveLength(0);
		} finally {
			unmount(c);
		}
	});

	it('Enter with no navigation picks the first hit; Escape closes', () => {
		const picked: DiagramSelection[] = [];
		const c = mount(MetamodelSearchHost, {
			target: document.body,
			props: { onReveal: (sel: DiagramSelection) => picked.push(sel) }
		});
		flushSync();
		try {
			type('zone');
			press('Enter');
			expect(picked).toEqual([{ kind: 'element', name: 'Zone' }]);
			type('zone');
			press('Escape');
			expect(rows()).toHaveLength(0);
		} finally {
			unmount(c);
		}
	});

	/**
	 * A duplicated type name is a reachable draft state, not a malformed one
	 * (see DUP_FIXTURE), and Svelte THROWS `each_key_duplicate` in dev and prod
	 * alike — so keying the dropdown on `kind:name` alone took the whole
	 * toolbar, and everything rendered under it, down with the first query that
	 * matched both blocks. The index is part of the key for exactly this
	 * reason, the same way the panel's TOC keys its rows.
	 */
	it('renders duplicate same-named types instead of throwing', async () => {
		resetMetamodelEditor();
		vi.spyOn(mmApi, 'getMetamodelRaw').mockResolvedValue({ blob: DUP_FIXTURE, source: 'stored' });
		await initMetamodelEditor('p1');

		const c = mount(MetamodelSearchHost, { target: document.body, props: {} });
		flushSync();
		try {
			type('zone');
			const r = rows();
			expect(r).toHaveLength(2);
			expect(r[0]).toContain('Zone');
			expect(r[1]).toContain('Zone');
		} finally {
			unmount(c);
		}
	});

	// AMENDMENT 2 (spec §6): each row highlights the matched substring via a
	// dedicated element rather than rendering the name plain.
	it('highlights the matched substring in each row', () => {
		const c = mount(MetamodelSearchHost, { target: document.body, props: {} });
		flushSync();
		try {
			type('nit');
			const marks = [...document.querySelectorAll('[data-testid="mm-search-match"]')];
			expect(marks).toHaveLength(1);
			expect(marks[0].textContent).toBe('nit');
		} finally {
			unmount(c);
		}
	});
});
