import { describe, expect, it } from 'vitest';
import {
	ArtifactSet,
	drain,
	EVALUATIONS,
	readArtifacts,
	readStagedArtifacts,
	ReadError,
	readViewDoc,
	validateViewDoc,
	ViewPlacements,
	type FolderDoc,
	type ViewDoc
} from '../../src/index.ts';
import { smartCity } from '../service/helpers.ts';

const { model } = smartCity();
const all = [...model.elements()];
const rootId = all.find((e) => e.parents.length === 0)!.id;
const otherRootId = all.filter((e) => e.parents.length === 0)[1]!.id;
const containedId = all.find((e) => e.parents.length > 0)!.id;

const folder = (name: string, rest: Partial<FolderDoc> = {}): FolderDoc => ({
	id: '',
	name,
	folders: [],
	elements: [],
	artifacts: [],
	...rest
});
const view = (folders: FolderDoc[], artifacts: ViewDoc['artifacts'] = []): ViewDoc => ({
	name: "it's",
	folders,
	artifacts
});
const knowing =
	(...ids: string[]) =>
	(id: string) =>
		ids.includes(id);
const run = (v: ViewDoc, known = knowing()) => validateViewDoc(v, model, known);
const messages = (v: ViewDoc, known = knowing()) => run(v, known).map((i) => i.message);

describe('validateViewDoc', () => {
	it('warns of an unknown artifact in a folder, and at the view root', () => {
		const issues = run(
			view(
				[folder('a/b', { artifacts: [{ id: 'gone', kind: 'table' }] })],
				[{ id: 'g2', kind: 'table' }]
			)
		);
		expect(issues).toEqual([
			{
				severity: 'warning',
				message: `view "it's": folder 'a/b' references unknown artifact 'gone'; renderers skip it`,
				targetIds: [],
				category: 'conformance',
				check: 'view'
			},
			{
				severity: 'warning',
				message: `view "it's": the view root references unknown artifact 'g2'; renderers skip it`,
				targetIds: [],
				category: 'conformance',
				check: 'view'
			}
		]);
	});

	it('warns of a duplicate folder under its parent, and under the root path', () => {
		expect(messages(view([folder('p', { folders: [folder('c'), folder('c')] })]))).toEqual([
			`view "it's": duplicate folder 'c' under 'p'; later occurrence ignored`
		]);
		expect(messages(view([folder('', { folders: [folder('c'), folder('c')] })]))).toEqual([
			`view "it's": duplicate folder 'c' under '/'; later occurrence ignored`
		]);
	});

	it('warns of an unknown element, naming it', () => {
		const issues = run(view([folder('p', { elements: ['nope'] })]));
		expect(issues).toEqual([
			{
				severity: 'warning',
				message: `view "it's": folder 'p' references unknown element 'nope'`,
				targetIds: ['nope'],
				category: 'conformance',
				check: 'view'
			}
		]);
	});

	it('warns of a contained element, naming it', () => {
		const issues = run(view([folder('p', { elements: [containedId] })]));
		expect(issues.map((i) => [i.message, i.targetIds])).toEqual([
			[
				`view "it's": element '${containedId}' has a containment parent and cannot be placed in folder 'p'; placement ignored`,
				[containedId]
			]
		]);
	});

	it('warns of an element placed twice, in one folder or two, the first placement winning', () => {
		expect(
			run(
				view([folder('p', { elements: [rootId, rootId] }), folder('q', { elements: [rootId] })])
			).map((i) => [i.message, i.targetIds])
		).toEqual([
			[
				`view "it's": element '${rootId}' is placed in multiple folders ('p' and 'p'); first placement wins`,
				[rootId]
			],
			[
				`view "it's": element '${rootId}' is placed in multiple folders ('p' and 'q'); first placement wins`,
				[rootId]
			]
		]);
	});

	it('warns of a duplicate top-level folder and skips its subtree', () => {
		const issues = run(view([folder('t'), folder('t', { elements: ['nope'] })]));
		expect(issues.map((i) => [i.message, i.targetIds])).toEqual([
			[`view "it's": duplicate top-level folder 't'; later occurrence ignored`, []]
		]);
	});

	it('orders a folder: its artifacts, its children, then its elements, the root artifacts last', () => {
		const v = view(
			[
				folder('t', {
					artifacts: [{ id: 'a1', kind: 'table' }],
					folders: [
						folder('c', { elements: ['m1'] }),
						folder('c', { elements: ['m9'] }),
						folder('d', { elements: ['m2'] })
					],
					elements: ['m3']
				}),
				folder('t'),
				folder('u', { elements: [rootId, otherRootId, rootId] })
			],
			[{ id: 'r1', kind: 'table' }]
		);
		expect(messages(v)).toEqual([
			`view "it's": folder 't' references unknown artifact 'a1'; renderers skip it`,
			`view "it's": folder 't/c' references unknown element 'm1'`,
			`view "it's": duplicate folder 'c' under 't'; later occurrence ignored`,
			`view "it's": folder 't/d' references unknown element 'm2'`,
			`view "it's": folder 't' references unknown element 'm3'`,
			`view "it's": duplicate top-level folder 't'; later occurrence ignored`,
			`view "it's": element '${rootId}' is placed in multiple folders ('u' and 'u'); first placement wins`,
			`view "it's": the view root references unknown artifact 'r1'; renderers skip it`
		]);
	});

	it('does not place an element that failed an earlier check', () => {
		expect(
			messages(
				view([
					folder('p', { elements: ['nope', 'nope'] }),
					folder('q', { elements: [containedId, containedId] })
				])
			)
		).toEqual([
			`view "it's": folder 'p' references unknown element 'nope'`,
			`view "it's": folder 'p' references unknown element 'nope'`,
			`view "it's": element '${containedId}' has a containment parent and cannot be placed in folder 'q'; placement ignored`,
			`view "it's": element '${containedId}' has a containment parent and cannot be placed in folder 'q'; placement ignored`
		]);
	});

	it('reads and walks a 2,000-deep folder chain from raw JSON without overflowing the stack', () => {
		let bottom: unknown = { name: 'f2000', elements: ['nope'] };
		for (let i = 1999; i >= 0; i--) bottom = { name: `f${i}`, folders: [bottom] };
		const raw = JSON.parse(JSON.stringify({ name: "it's", folders: [bottom] }));
		const out = drain(
			EVALUATIONS['validateView']!(
				{ model, artifacts: new ArtifactSet(), placements: new ViewPlacements() },
				{ view: raw }
			)
		) as { message: string; target_ids: string[] }[];
		expect(out).toHaveLength(1);
		expect(out[0]!.target_ids).toEqual(['nope']);
		expect(out[0]!.message).toMatch(
			/^view "it's": folder 'f0\/f1\/.*\/f2000' references unknown element 'nope'$/
		);
	});

	it('checks artifacts against the set: a staged create is known and a staged delete is not', () => {
		const set = new ArtifactSet();
		set.setCommitted(
			readArtifacts([{ id: 'a2', kind: 'table', name: 'A2', artifact_rev: 1, payload: {} }])
		);
		set.setStaged(
			readStagedArtifacts([
				{ op: 'create', id: 'a1', kind: 'table', name: 'A1', payload: {} },
				{ op: 'delete', id: 'a2' }
			])
		);
		const v = view(
			[],
			[
				{ id: 'a1', kind: 'table' },
				{ id: 'a2', kind: 'table' }
			]
		);
		const out = drain(
			EVALUATIONS['validateView']!(
				{ model, artifacts: set, placements: new ViewPlacements() },
				{ view: v }
			)
		) as { message: string; origin: string }[];
		expect(out.map((i) => [i.message, i.origin])).toEqual([
			[
				`view "it's": the view root references unknown artifact 'a2'; renderers skip it`,
				'on_server'
			]
		]);
	});
});

describe('readViewDoc', () => {
	it('fills absent lists with empty ones and keeps a folder id or the empty default', () => {
		expect(readViewDoc({ name: 'v', folders: [{ name: 'f' }] })).toEqual({
			name: 'v',
			folders: [{ id: '', name: 'f', folders: [], elements: [], artifacts: [] }],
			artifacts: []
		});
	});

	const refusal = (value: unknown): string => {
		try {
			readViewDoc(value);
		} catch (error) {
			if (error instanceof ReadError) return `${error.status} ${error.detail}`;
			throw error;
		}
		throw new Error('expected a refusal');
	};

	it('refuses a non-string name and a non-array folders', () => {
		expect(refusal({ name: 3 })).toBe('422 view.name: must be a string');
		expect(refusal({ name: 'v', folders: {} })).toBe('422 view.folders: must be a list');
		expect(refusal({ name: 'v', folders: [{ name: 'f', folders: [{ name: 1 }] }] })).toBe(
			'422 view.folders[0].folders[0].name: must be a string'
		);
		expect(refusal(null)).toMatch(/^422 view[.:]/);
		expect(refusal({ name: 'v', folders: [{ name: 'f', elements: [1] }] })).toMatch(
			/^422 view[.:]/
		);
		expect(refusal({ name: 'v', artifacts: [{ id: 'a' }] })).toMatch(/^422 view[.:]/);
	});

	it('refuses a `validateView` call whose view is unreadable before it yields', () => {
		expect(() =>
			EVALUATIONS['validateView']!(
				{ model, artifacts: new ArtifactSet(), placements: new ViewPlacements() },
				{ view: { name: 1 } }
			)
		).toThrow(ReadError);
	});
});
