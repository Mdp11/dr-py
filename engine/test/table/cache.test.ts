import { describe, expect, it } from 'vitest';
import {
	ArtifactSet,
	drain,
	evaluateTable,
	EVALUATIONS,
	Model,
	orderKey,
	readTableDefinition,
	TableOrderCache,
	ReadError,
	ViewPlacements,
	type CachedOrder,
	type CommittedArtifact,
	type EvalContext,
	type ExportFileResult,
	type ReadParams,
	type Steps,
	type TablePageBody
} from '../../src/index.ts';
import { thrown } from '../golden/thrown.ts';
import { nodeMetamodel } from '../model/fixtures.ts';

const COUNT = 3_000;

/** `n0` … refers to the next, the last to the first; names sort otherwise than ids. */
function ring(): Model {
	const model = new Model(nodeMetamodel());
	for (let i = 0; i < COUNT; i++) {
		model.setProperty(model.createElement('Node', `n${i}`), 'name', `node ${(i * 7) % COUNT}`);
	}
	for (let i = 0; i < COUNT; i++) model.connect('Refers', `n${i}`, `n${(i + 1) % COUNT}`, `r${i}`);
	return model;
}

const model = ring();

const hop = (direction: 'out' | 'in') => ({
	kind: 'path',
	start: { kind: 'row' },
	steps: [{ kind: 'relationship', relationship_type: 'Refers', direction }]
});

type CommittedPayload = CommittedArtifact['payload'];

const navigation = (id: string, payload: object): CommittedArtifact => ({
	id,
	kind: 'navigation',
	name: id,
	rev: 1,
	payload: payload as unknown as CommittedPayload
});

/** Nodes, their names, and where each refers through `nv`, sorted by the last. */
const TABLE = {
	row_source: { kind: 'scope', types: ['Node'] },
	columns: [
		{ kind: 'element', header: 'Node', width_px: 120 },
		{ kind: 'property', name: 'name' },
		{ kind: 'navigation', navigation: { ref: 'nv' } }
	],
	sort: [{ column: 2 }]
};

function artifacts(): ArtifactSet {
	const set = new ArtifactSet();
	set.setCommitted([navigation('nv', hop('out')), navigation('other', hop('in'))]);
	return set;
}

type Stamp = { rev: number; stagedVersion: number };

const context = (
	set: ArtifactSet,
	cache: TableOrderCache | null,
	stamp: Stamp = { rev: 0, stagedVersion: 0 }
): EvalContext => ({
	model,
	artifacts: set,
	placements: new ViewPlacements(),
	...(cache === null ? {} : { working: { ...stamp, tableOrders: cache } })
});

/** The body, and how many times the scan yielded: a page served from the cache yields none. */
function run(ctx: EvalContext, params: ReadParams): { body: string; yields: number } {
	const steps = evaluateTable(ctx, params);
	let yields = 0;
	for (;;) {
		const next = steps.next();
		if (next.done === true) return { body: JSON.stringify(next.value), yields };
		yields++;
	}
}

const uncached = (set: ArtifactSet, params: ReadParams) =>
	JSON.stringify(drain(evaluateTable(context(set, null), params)));

const page = (definition: object, offset = 0) => ({ definition, offset, limit: 10 });

describe('the table order cache', () => {
	it('serves a later page without building the rows again', () => {
		const set = artifacts();
		const cache = new TableOrderCache();
		const first = run(context(set, cache), page(TABLE));
		expect(first.yields).toBeGreaterThan(2);
		expect(first.body).toBe(uncached(set, page(TABLE)));
		for (const offset of [10, 2_990, 3_000]) {
			const later = run(context(set, cache), page(TABLE, offset));
			expect(later.yields).toBe(0);
			expect(later.body).toBe(uncached(set, page(TABLE, offset)));
		}
		expect(cache.size).toBe(1);
	});

	it('misses after a stage or a delta, and keeps the order under the new stamp', () => {
		const set = artifacts();
		const cache = new TableOrderCache();
		run(context(set, cache), page(TABLE));
		for (const stamp of [
			{ rev: 0, stagedVersion: 1 },
			{ rev: 1, stagedVersion: 1 },
			{ rev: 1, stagedVersion: 0 }
		]) {
			expect(run(context(set, cache, stamp), page(TABLE)).yields).toBeGreaterThan(2);
			expect(run(context(set, cache, stamp), page(TABLE, 10)).yields).toBe(0);
			expect(cache.size).toBe(1);
		}
		// The entry of the first stamp was replaced: going back misses too.
		expect(run(context(set, cache), page(TABLE)).yields).toBeGreaterThan(2);
	});

	it('stores the order under the stamp read before the first step', () => {
		const set = artifacts();
		const cache = new TableOrderCache();
		const ctx = context(set, cache);
		const steps = evaluateTable(ctx, page(TABLE));
		ctx.working!.stagedVersion = 5;
		drain(steps);
		expect(run(context(set, cache), page(TABLE, 10)).yields).toBe(0);
	});

	it('hits after an edit of what is only shown or exported, the columns as asked', () => {
		const set = artifacts();
		const cache = new TableOrderCache();
		run(context(set, cache), page(TABLE));
		const [element, name, links] = TABLE.columns;
		const shown = [
			{ ...TABLE, columns: [{ ...element, header: 'Renamed', width_px: 300 }, name, links] },
			{ ...TABLE, columns: [element, { ...name, hidden: true, width_px: 40 }, links] },
			{ ...TABLE, columns: [element, name, { ...links, header: 'Refers' }] },
			{ ...TABLE, display_order: [2, 0, 1], export_order: [1, 0] },
			{ ...TABLE, show_row_numbers: true, default_cell_mode: 'expand' },
			{
				...TABLE,
				columns: [
					{ ...element, export: { include: false, header: 'x' } },
					{ ...name, json_export: { key: 'k', value: 'id' } },
					links
				]
			},
			{
				...TABLE,
				export_row_number: { include: true, header: '#', key: 'n' },
				json_split: { enabled: true, filename_template: '{name}.json' },
				transform: { ref: 'nope' }
			}
		];
		for (const definition of shown) {
			const hit = run(context(set, cache), page(definition, 20));
			expect(hit.yields).toBe(0);
			expect(hit.body).toBe(uncached(set, page(definition, 20)));
		}
		expect(JSON.parse(run(context(set, cache), page(shown[0]!)).body).columns[0]).toEqual({
			kind: 'element',
			header: 'Renamed',
			width_px: 300
		});
		expect(cache.size).toBe(1);
	});

	it('misses after an edit of the sort or of what a column reads', () => {
		const set = artifacts();
		const cache = new TableOrderCache();
		run(context(set, cache), page(TABLE));
		const [element, name, links] = TABLE.columns;
		const read = [
			{ ...TABLE, sort: [{ column: 2, direction: 'desc' }] },
			{ ...TABLE, sort: [{ column: 1 }] },
			{ ...TABLE, columns: [element, { ...name, name: 'peer' }, links] },
			{ ...TABLE, columns: [element, name, { ...links, source: { kind: 'column', index: 0 } }] },
			{ ...TABLE, columns: [element, name, { ...links, navigation: { definition: hop('in') } }] },
			{ ...TABLE, columns: [element, name, { ...links, cell_cap: 1 }] },
			{ ...TABLE, row_source: { kind: 'scope', types: ['Node'], criteria: [{ type: 'orphan' }] } }
		];
		for (const definition of read) {
			const miss = run(context(set, cache), page(definition));
			expect(miss.yields, JSON.stringify(definition)).toBeGreaterThan(0);
			expect(miss.body).toBe(uncached(set, page(definition)));
		}
	});

	it('misses when a navigation the table reaches changes, and hits when another does', () => {
		const set = artifacts();
		const cache = new TableOrderCache();
		const before = run(context(set, cache), page(TABLE));

		set.setStaged([
			{ op: 'update', id: 'other', payload: hop('out') as unknown as CommittedPayload }
		]);
		expect(run(context(set, cache), page(TABLE)).yields).toBe(0);

		set.setStaged([{ op: 'update', id: 'nv', payload: hop('in') as unknown as CommittedPayload }]);
		const after = run(context(set, cache), page(TABLE));
		expect(after.yields).toBeGreaterThan(2);
		expect(after.body).toBe(uncached(set, page(TABLE)));
		expect(after.body).not.toBe(before.body);

		// A navigation inlined, or referred to by id, is one table.
		const inline = {
			...TABLE,
			columns: [
				TABLE.columns[0],
				TABLE.columns[1],
				{ kind: 'navigation', navigation: { definition: hop('in') } }
			]
		};
		expect(run(context(set, cache), page(inline, 10)).yields).toBe(0);

		set.setStaged([]);
		const back = run(context(set, cache), page(TABLE));
		expect(back.yields).toBe(0);
		expect(back.body).toBe(before.body);
	});

	it('keys a saved table by what it reads, not by its id', () => {
		const set = artifacts();
		set.put(
			[
				{ id: 't', kind: 'table', name: 'T', rev: 1, payload: TABLE as unknown as CommittedPayload }
			],
			[]
		);
		const cache = new TableOrderCache();
		run(context(set, cache), page(TABLE));
		const saved = run(context(set, cache), { artifact_id: 't', offset: 10, limit: 10 });
		expect(saved.yields).toBe(0);
		set.setStaged([
			{
				op: 'update',
				id: 't',
				payload: {
					...TABLE,
					sort: [{ column: 2, direction: 'desc' }]
				} as unknown as CommittedPayload
			}
		]);
		expect(run(context(set, cache), { artifact_id: 't', limit: 10 }).yields).toBeGreaterThan(2);
	});

	/** The step a scan of every row's cells stores its order in, counted from 1; the scan goes on after it. */
	function storingStep(set: ArtifactSet, cache: TableOrderCache): number {
		const steps: Steps<TablePageBody> = evaluateTable(context(set, cache), WHOLE);
		for (let step = 1; ; step++) {
			expect(steps.next().done).toBe(false);
			if (cache.size === 1) return step;
		}
	}

	const WHOLE = { definition: TABLE, limit: 500 };

	it('stores nothing from a scan dropped before its sort ends', () => {
		const set = artifacts();
		const storing = storingStep(set, new TableOrderCache());
		expect(storing).toBeGreaterThan(3);
		const cache = new TableOrderCache();
		const steps = evaluateTable(context(set, cache), WHOLE);
		for (let step = 1; step < storing; step++) expect(steps.next().done).toBe(false);
		expect(cache.size).toBe(0);
		expect(run(context(set, cache), page(TABLE)).yields).toBeGreaterThan(2);
	});

	it('stores the whole order of a scan dropped during its cells', () => {
		const set = artifacts();
		const cache = new TableOrderCache();
		storingStep(set, cache);
		// Cells remain: the scan is dropped here.
		for (const offset of [0, 40, 2_995]) {
			const hit = run(context(set, cache), page(TABLE, offset));
			expect(hit.yields).toBe(0);
			expect(hit.body).toBe(uncached(set, page(TABLE, offset)));
		}
	});

	it('stores nothing from a scan that refuses in its build, and the order of one that refuses in its cells', () => {
		const set = artifacts();
		const cache = new TableOrderCache();
		const beyond = (mode: string) => ({
			...TABLE,
			columns: [
				...TABLE.columns,
				{ kind: 'navigation', navigation: { ref: 'nv' }, step_index: 5, mode }
			]
		});
		const refusal = (definition: object) =>
			thrown(() => drain(evaluateTable(context(set, cache), page(definition))));
		const inBuild = refusal(beyond('expand'));
		expect(inBuild).toBeInstanceOf(ReadError);
		expect(cache.size).toBe(0);
		const inCells = refusal(beyond('collapse'));
		expect(inCells).toBeInstanceOf(ReadError);
		expect(cache.size).toBe(1);
		expect(refusal(beyond('collapse'))).toEqual(inCells);
	});
});

describe('an export and the table order cache', () => {
	const csv = (definition: object) => ({
		definition,
		format: 'csv',
		date: '20240229',
		project: 'p'
	});

	/** The file's bytes as text, and how many times the scan yielded. */
	function exportRun(ctx: EvalContext, params: ReadParams): { text: string; yields: number } {
		const steps = EVALUATIONS.exportTable!(ctx, params);
		let yields = 0;
		for (;;) {
			const next = steps.next();
			if (next.done === true) {
				const { parts } = next.value as ExportFileResult;
				const text = parts.map((part) => new TextDecoder().decode(part)).join('');
				return { text, yields };
			}
			yields++;
		}
	}

	it('reuses the order of a page of the same table, what is only exported set otherwise', () => {
		const set = artifacts();
		const cold = exportRun(context(set, new TableOrderCache()), csv(TABLE));
		const cache = new TableOrderCache();
		const built = run(context(set, cache), page(TABLE)).yields;
		const exported = { ...TABLE, show_row_numbers: true, export_order: [2, 1] };
		const warm = exportRun(context(set, cache), csv(exported));
		expect(warm.yields).toBeLessThanOrEqual(cold.yields - built + 2);
		expect(warm.yields).toBeLessThan(cold.yields / 2);
		expect(warm.text).toBe(exportRun(context(set, null), csv(exported)).text);
		expect(cache.size).toBe(1);
	});

	it('keeps the order it built for a later page', () => {
		const set = artifacts();
		const cache = new TableOrderCache();
		exportRun(context(set, cache), csv(TABLE));
		const later = run(context(set, cache), page(TABLE, 10));
		expect(later.yields).toBe(0);
		expect(later.body).toBe(uncached(set, page(TABLE, 10)));
	});
});

describe('TableOrderCache', () => {
	const order = (n: number): CachedOrder => ({
		keys: [[`n${n}`]],
		truncated: false,
		baseTotal: 1,
		baseSlots: 1
	});
	const stamp = { rev: 3, stagedVersion: 2 };

	it('keeps 16 orders, evicting the least recently used', () => {
		const cache = new TableOrderCache();
		for (let i = 0; i < 16; i++) cache.put(`k${i}`, stamp, order(i));
		expect(cache.get('k0', stamp)).toEqual(order(0));
		cache.put('k16', stamp, order(16));
		expect(cache.size).toBe(16);
		expect(cache.get('k1', stamp)).toBeUndefined();
		for (const i of [0, ...Array.from({ length: 15 }, (_, j) => j + 2)]) {
			expect(cache.get(`k${i}`, stamp), `k${i}`).toEqual(order(i));
		}
	});

	it('answers the very order put, and drops it when asked under another stamp', () => {
		const cache = new TableOrderCache();
		const stored = order(1);
		cache.put('k', stamp, stored);
		expect(cache.get('k', stamp)).toBe(stored);
		expect(cache.get('k', { rev: 3, stagedVersion: 3 })).toBeUndefined();
		expect(cache.get('k', stamp)).toBeUndefined();
		expect(cache.size).toBe(0);
		cache.put('k', stamp, stored);
		cache.clear();
		expect(cache.size).toBe(0);
	});
});

describe('orderKey', () => {
	const read = (raw: object) => readTableDefinition(raw, 'definition');

	it('is the definition as text without what is only shown or exported', () => {
		expect(orderKey(read({ ...TABLE, show_row_numbers: true, display_order: [1] }))).toBe(
			orderKey(read(TABLE))
		);
		expect(orderKey(read({ ...TABLE, sort: [] }))).not.toBe(orderKey(read(TABLE)));
		const key = orderKey(read(TABLE));
		for (const hidden of [
			'header',
			'width_px',
			'hidden',
			'json_export',
			'export',
			'display_order'
		]) {
			expect(key).not.toContain(`"${hidden}"`);
		}
		expect(key).toContain('"cell_cap":20');
	});
});
