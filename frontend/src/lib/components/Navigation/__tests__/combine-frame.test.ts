import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import * as artifactsApi from '$lib/api/artifacts';
import type { ArtifactHeader, PathNavigation, SetExpression } from '$lib/api/types';
import {
	ensureDraft,
	getDraft,
	loadArtifacts,
	resetArtifacts,
	resetCheckout,
	resetNavigationEditors,
	setProjectInfo,
	updateDefinition
} from '$lib/state';
import NavigationNode from '../NavigationNode.svelte';

beforeEach(() => {
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
	// Every rendered card now registers itself visible on mount (see
	// PathCard/CombineFrame's `$effect`), which fires an immediate preview
	// run for any runnable operand — mock the evaluate call so these
	// structural-edit tests never hit the network.
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue({
		step_types: [],
		chains: [],
		total: 0,
		truncated: false
	});
});
afterEach(() => {
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

/** A single-start bare path — the smallest distinguishable PathNavigation. */
function pathOf(type: string): PathNavigation {
	return {
		kind: 'path',
		schema_version: 2,
		start: { kind: 'scope', types: [type], criteria: [] },
		steps: [],
		exclude_visited: true
	};
}

/** A combine node whose N operands are inline bare paths, one per given start
 * type — distinguishable in the rendered operand label without needing a
 * saved-navigation ref. */
function combineOf(types: string[], op: SetExpression['op'] = 'union'): SetExpression {
	return {
		kind: 'set_op',
		schema_version: 2,
		op,
		operands: types.map((t) => ({ definition: pathOf(t), step_index: null }))
	};
}

function render(tabId: string) {
	const component = mount(NavigationNode, { target: document.body, props: { tabId, path: [] } });
	flushSync();
	return component;
}

function buttonsByLabel(label: string): HTMLButtonElement[] {
	return [...document.querySelectorAll(`button[aria-label="${label}"]`)] as HTMLButtonElement[];
}

async function seedCombine(tabId: string, types: string[], op: SetExpression['op'] = 'union') {
	await ensureDraft(tabId);
	updateDefinition(tabId, combineOf(types, op));
	flushSync();
}

/** Seed the artifact library headers via the module's real surface — there's
 * no direct headers setter, so mock the API call `loadArtifacts` fetches
 * from (see the module's exports in `state/artifacts.svelte.ts`). */
async function setArtifactHeaders(
	items: ReadonlyArray<Omit<ArtifactHeader, 'artifact_rev'> & { artifact_rev?: number }>
): Promise<void> {
	vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({
		items: items.map((h) => ({ artifact_rev: 1, ...h }))
	});
	await loadArtifacts();
}

/** Open the LAST "+ Add another part ▾" trigger in document order — the ROOT
 * frame's, since its add-row renders after every nested part — and click the
 * named item. */
function addPart(item: 'A new path' | 'A saved navigation…' | 'A nested combination'): void {
	const triggers = [...document.querySelectorAll('button')].filter(
		(b) => b.textContent?.trim() === '+ Add another part ▾'
	);
	(triggers.at(-1) as HTMLButtonElement).click();
	flushSync();
	const entry = [...document.querySelectorAll('[role="menuitem"], button')].find((b) =>
		b.textContent?.trim().startsWith(item)
	);
	if (!entry) throw new Error(`add-part item "${item}" not found`);
	(entry as HTMLElement).click();
	flushSync();
}

it('"+ Add another part → A new path" appends an operand', async () => {
	const tabId = 'nav:draft:insert';
	await seedCombine(tabId, ['A', 'B']);
	const c = render(tabId);
	try {
		const before = (getDraft(tabId)?.definition as SetExpression).operands.length;
		addPart('A new path');
		const after = (getDraft(tabId)?.definition as SetExpression).operands.length;
		expect(after).toBe(before + 1);
	} finally {
		unmount(c);
	}
});

it('"+ Add another part → A nested combination" appends a nested set_op operand', async () => {
	const tabId = 'nav:draft:insert-nested';
	await seedCombine(tabId, ['A', 'B']);
	const c = render(tabId);
	try {
		addPart('A nested combination');
		const defn = getDraft(tabId)?.definition as SetExpression;
		expect(defn.operands.at(-1)?.definition?.kind).toBe('set_op');
	} finally {
		unmount(c);
	}
});

it('remove operand down to one auto-unwraps to a bare path', async () => {
	const tabId = 'nav:draft:remove';
	await seedCombine(tabId, ['A', 'B']);
	const c = render(tabId);
	try {
		buttonsByLabel('Remove operand')[0].click();
		flushSync();
		expect(getDraft(tabId)?.definition.kind).toBe('path');
	} finally {
		unmount(c);
	}
});

it('reorder moves an operand', async () => {
	const tabId = 'nav:draft:reorder';
	await seedCombine(tabId, ['A', 'B', 'C']);
	const c = render(tabId);
	try {
		const labelOf = (i: number) => {
			const defn = getDraft(tabId)?.definition as SetExpression;
			const op = defn.operands[i];
			return op.definition?.kind === 'path' && op.definition.start.kind === 'scope'
				? op.definition.start.types[0]
				: undefined;
		};
		expect(labelOf(0)).toBe('A');
		expect(labelOf(1)).toBe('B');

		buttonsByLabel('Move down')[0].click();
		flushSync();

		expect(labelOf(0)).toBe('B');
		expect(labelOf(1)).toBe('A');
		expect(labelOf(2)).toBe('C');
	} finally {
		unmount(c);
	}
});

it('difference marks the first part with the base badge and the others without it', async () => {
	const tabId = 'nav:draft:difference';
	await seedCombine(tabId, ['A', 'B'], 'difference');
	const c = render(tabId);
	try {
		const badges = [...document.querySelectorAll('[data-testid="base-badge"]')];
		expect(badges).toHaveLength(1);
		expect(badges[0].textContent?.trim()).toBe('base');
	} finally {
		unmount(c);
	}
});

it('renders the operator word on the divider between consecutive parts', async () => {
	const tabId = 'nav:draft:divider';
	await seedCombine(tabId, ['A', 'B', 'C'], 'intersection');
	const c = render(tabId);
	try {
		const dividers = [...document.querySelectorAll('[data-testid="op-divider"]')];
		expect(dividers).toHaveLength(2); // between 3 parts
		expect(dividers[0].textContent).toContain('∩ intersection');
	} finally {
		unmount(c);
	}
});

it('a path part inside a combination gets a feeds chip; the frame itself does not', async () => {
	const tabId = 'nav:draft:feeds-presence';
	await seedCombine(tabId, ['A', 'B']);
	const c = render(tabId);
	try {
		expect(document.querySelectorAll('[data-testid="feeds-chip"]')).toHaveLength(2);
	} finally {
		unmount(c);
	}
});

it('a nested combination part shows the no-steps-to-feed note and no chip', async () => {
	const tabId = 'nav:draft:nested-note';
	await ensureDraft(tabId);
	updateDefinition(tabId, {
		kind: 'set_op',
		schema_version: 2,
		op: 'union',
		operands: [
			{ definition: pathOf('A'), step_index: null },
			{ definition: combineOf(['B', 'C']), step_index: null }
		]
	});
	flushSync();
	const c = render(tabId);
	try {
		expect(document.body.textContent).toContain('contributes its members — no steps to feed');
		// paths A, B, C each get one chip; the nested frame gets none.
		expect(document.querySelectorAll('[data-testid="feeds-chip"]')).toHaveLength(3);
	} finally {
		unmount(c);
	}
});

it('a ref operand renders a compact ref card with the artifact name', async () => {
	const tabId = 'nav:draft:refcard';
	await setArtifactHeaders([
		{ id: 'nav-1', kind: 'navigation', name: 'Sensors network', updated_at: '', updated_by: null }
	]);
	await ensureDraft(tabId);
	updateDefinition(tabId, {
		kind: 'set_op',
		schema_version: 2,
		op: 'union',
		operands: [
			{ definition: pathOf('A'), step_index: null },
			{ ref: 'nav-1', step_index: null }
		]
	});
	flushSync();
	const c = render(tabId);
	try {
		const card = document.querySelector('[data-testid="ref-card"]');
		expect(card?.textContent).toContain('Sensors network');
		expect(card?.textContent).toContain('saved navigation');
		expect(card?.textContent).toContain('linked');
	} finally {
		unmount(c);
	}
});

it('the feeds chip writes step_index for the operand it belongs to', async () => {
	const tabId = 'nav:draft:feeds-write';
	await seedCombine(tabId, ['A', 'B']);
	// Seed the target operand with a non-null step_index so the pick below is
	// an observable write, not a null -> null no-op.
	const seeded = getDraft(tabId)!.definition as SetExpression;
	updateDefinition(tabId, {
		...seeded,
		operands: seeded.operands.map((o, i) => (i === 1 ? { ...o, step_index: 2 } : o))
	});
	flushSync();
	const c = render(tabId);
	try {
		const chips = [...document.querySelectorAll('[data-testid="feeds-chip"]')] as HTMLElement[];
		chips[1].click();
		flushSync();
		const opts = [...document.querySelectorAll('[data-testid="feeds-option"]')] as HTMLElement[];
		opts[0].click(); // single-column path -> the last-step default -> null
		flushSync();
		expect((getDraft(tabId)!.definition as SetExpression).operands[1].step_index).toBeNull();
	} finally {
		unmount(c);
	}
});
