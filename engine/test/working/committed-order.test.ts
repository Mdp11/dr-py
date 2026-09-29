import { describe, expect, it } from 'vitest';
import {
	Metamodel,
	Model,
	OpError,
	type ElementImage,
	type ModelOp,
	type RelImage,
	type WorkingCopy
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { seededRandom, type StepsFixture } from '../golden/model-steps.ts';
import { family } from '../model/fixtures.ts';
import { clone, Server, workingCopy } from './helpers.ts';
import { RandomOps } from './random-ops.ts';

type Seen = { id: string; typeName: string; props: object; rev: number; ord: number };
type SeenRel = Seen & { sourceId: string; targetId: string };

const seen = ({ id, typeName, props, rev, ord }: ElementImage): Seen => ({
	id,
	typeName,
	props: { ...props },
	rev,
	ord
});

const seenRel = (image: RelImage): SeenRel => ({
	...seen(image),
	sourceId: image.sourceId,
	targetId: image.targetId
});

/** The committed state as the ordered iteration walks it, copied as it goes. */
function iterated(wc: WorkingCopy) {
	return {
		elements: [...wc.committedElementsInOrder()].map(seen),
		relationships: [...wc.committedRelationshipsInOrder()].map(seenRel)
	};
}

/** The committed state as the model holds it with every staged batch rewound. */
function rewound(wc: WorkingCopy) {
	return wc.probeStaged(
		() => null,
		() => ({
			elements: [...wc.model.elements()].map((element) => seen(element)),
			relationships: [...wc.model.relationships()].map((rel) => ({
				...seen(rel),
				sourceId: rel.source.id,
				targetId: rel.target.id
			}))
		})
	).committed;
}

const rename = (id: string, name: string): ModelOp => ({
	kind: 'update_element',
	id,
	properties_patch: { name }
});

const remove = (id: string): ModelOp => ({ kind: 'delete_element', id });

const node = (temp_id: string, name: string, id?: string): ModelOp => ({
	kind: 'create_element',
	temp_id,
	type_name: 'Node',
	properties: { name },
	...(id === undefined ? {} : { id })
});

const refers = (temp_id: string, source_id: string, target_id: string, id?: string): ModelOp => ({
	kind: 'create_relationship',
	temp_id,
	type_name: 'Refers',
	source_id,
	target_id,
	...(id === undefined ? {} : { id })
});

const SHAPES: [string, ModelOp[][]][] = [
	['an update', [[rename('b', 'staged')]]],
	['a delete, cascading', [[remove('b')]]],
	['a create', [[node('tmp_e', 'E'), refers('tmp_r', 'tmp_e', 'a')]]],
	['a delete and a create under the same id', [[remove('b'), node('tmp_b', 'again', 'b')]]],
	[
		'a relationship rewired under its own id',
		[[{ kind: 'delete_relationship', id: 'a-c' }, refers('tmp_r', 'c', 'a', 'a-c')]]
	],
	['two batches touching one id', [[rename('c', 'one')], [remove('c'), node('tmp_c', 'two', 'c')]]]
];

describe('the committed iteration', () => {
	it.each(SHAPES)('is the rewound state, in order, under %s', (_, batches) => {
		const wc = workingCopy(clone(family()));
		for (const ops of batches) wc.stage(ops);
		const walked = iterated(wc);
		expect(walked).toEqual(rewound(wc));
		expect(walked).toEqual(iterated(workingCopy(clone(family()))));
	});

	it('keeps a committed element deleted and created again at its own place, as committed', () => {
		const wc = workingCopy(clone(family()));
		wc.stage([remove('b'), node('tmp_b', 'again', 'b')]);
		// The working model holds the new `b` last; `d`, which `b` contained, went with it.
		expect([...wc.model.elements()].map((element) => element.id)).toEqual(['a', 'c', 'b']);
		const { elements, relationships } = iterated(wc);
		expect(elements.map((element) => [element.id, element.props])).toEqual([
			['a', { name: 'A' }],
			['b', { name: 'B' }],
			['c', { name: 'C' }],
			['d', { name: 'D' }]
		]);
		expect(relationships.map((rel) => rel.id)).toEqual(['a-b', 'b-d', 'a-c']);
	});

	it('keeps a rewired relationship on its committed ends', () => {
		const wc = workingCopy(clone(family()));
		wc.stage([{ kind: 'delete_relationship', id: 'a-c' }, refers('tmp_r', 'c', 'a', 'a-c')]);
		expect(wc.model.getRelationship('a-c').source.id).toBe('c');
		const rel = iterated(wc).relationships.find((image) => image.id === 'a-c');
		expect(rel).toMatchObject({ sourceId: 'a', targetId: 'c' });
	});

	it('copies no property bag of an entity nothing staged touched', () => {
		const wc = workingCopy(clone(family()));
		wc.stage([rename('b', 'staged')]);
		const a = [...wc.committedElementsInOrder()].find((image) => image.id === 'a')!;
		expect(a.props).toBe(wc.model.getElement('a').props);
	});

	it('follows a delta under staged batches', () => {
		const committed = family();
		const server = new Server(clone(committed));
		const wc = workingCopy(clone(committed));
		wc.stage([rename('a', 'mine'), remove('c')]);
		const { delta } = server.commit([rename('c', 'theirs'), remove('d'), node('tmp_x', 'X')]);
		expect(wc.applyDelta(delta).status).toBe('applied');
		const walked = iterated(wc);
		expect(walked).toEqual(rewound(wc));
		expect(walked.elements.map((element) => [element.id, element.props])).toEqual(
			[...server.model.elements()].map((element) => [element.id, element.props])
		);
	});

	const churn = Metamodel.fromJSON(loadFixture<StepsFixture>('ops_churn').metamodel);

	function tryStage(wc: WorkingCopy, ops: readonly ModelOp[]): boolean {
		try {
			wc.stage(ops);
			return true;
		} catch (caught) {
			if (!(caught instanceof OpError)) throw caught;
			return false;
		}
	}

	it.each([1, 2, 3, 4, 5, 6])(
		'seed %i: is the committed state under random staged batches',
		(s) => {
			const random = seededRandom(s);
			const server = new Server(new Model(churn));
			const grow = new RandomOps(random, 'tmp_grow');
			for (let landed = 0; landed < 30;) {
				try {
					server.commit(grow.batch(server.model));
					landed++;
				} catch (caught) {
					if (!(caught instanceof OpError)) throw caught;
				}
			}
			const wc = workingCopy(clone(server.model), server.rev);
			const mine = new RandomOps(random);
			for (let staged = 0; staged < 6;) {
				if (tryStage(wc, mine.batch(wc.model))) staged++;
				// Now and then a committed element deleted and created again under its id.
				const ids = [...wc.model.elements()].map((element) => element.id);
				const id = ids[Math.floor(random() * ids.length)];
				if (id !== undefined && !id.startsWith('tmp_') && random() < 0.5) {
					const typeName = wc.model.getElement(id).typeName;
					const again: ModelOp = {
						kind: 'create_element',
						temp_id: `tmp_again_${staged}`,
						type_name: typeName,
						properties: {},
						id
					};
					tryStage(wc, [remove(id), again]);
				}
			}
			const walked = iterated(wc);
			expect(walked).toEqual(rewound(wc));
			// The server's own model, whose places are its own: the order, not the `ord`, must agree.
			const plain = (item: Seen) =>
				Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'ord'));
			expect(walked.elements.map(plain)).toEqual([...server.model.elements()].map(seen).map(plain));
			expect(walked.relationships.map(plain)).toEqual(
				[...server.model.relationships()].map((rel) =>
					plain({ ...seen(rel), sourceId: rel.source.id, targetId: rel.target.id } as SeenRel)
				)
			);
		}
	);
});
