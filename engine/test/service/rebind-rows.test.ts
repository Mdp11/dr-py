import { describe, expect, it } from 'vitest';
import {
	Metamodel,
	Model,
	parseJson,
	type MetamodelDoc,
	type PreviewBody,
	type StageResult,
	type Value
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { connect, openReplica, refusal, type Client } from './helpers.ts';

type Entities = { elements: object[]; relationships: object[] };
type Case = {
	case: string;
	model: Entities;
	candidate: MetamodelDoc;
	detail: string | null;
};

/**
 * Written for the server: `tests/api/test_rebind_rows.py` answers the same cases
 * from its head rows, and the texts are the ones its 422s carry.
 */
const { metamodel, cases } = loadFixture<{ metamodel: MetamodelDoc; cases: Case[] }>('rebind_rows');

const byName = (name: string) => cases.find((c) => c.case === name)!;

/** A ready replica of the case's model under the fixture's metamodel. */
async function replicaOf(entities: Entities): Promise<Client> {
	const model = new Model(Metamodel.fromJSON(metamodel));
	const read = (items: object[]) => parseJson(JSON.stringify(items)) as Value[];
	for (const element of read(entities.elements)) model.loadElement(element);
	for (const rel of read(entities.relationships)) model.loadRelationship(rel);
	model.rebuildIndexes();
	const client = connect();
	await openReplica(client, model, metamodel);
	return client;
}

const preview = (client: Client, candidate: MetamodelDoc, batchIds: number[] = []) =>
	client.call<PreviewBody>('previewCommit', {
		base_rev: 0,
		batch_ids: batchIds,
		strict: true,
		rebind: { metamodel: candidate }
	});

describe('previewCommit with a rebind, over the committed rows', () => {
	for (const c of cases) {
		it(`answers ${c.case} as the server's commit does`, async () => {
			const body = await preview(await replicaOf(c.model), c.candidate);
			if (c.detail === null) {
				expect(body.would_block).toBe(false);
				expect(body).not.toHaveProperty('block_reason');
			} else {
				expect(body).toEqual({
					conformance_error_count: 0,
					structural_blockers: [],
					issues: [],
					would_block: true,
					block_reason: c.detail
				});
			}
		});
	}

	it('judges the committed state: a staged delete of an offender does not lift the block', async () => {
		const c = byName('dropped-type-in-use');
		const client = await replicaOf(c.model);
		const { batch } = await client.call<StageResult>('stage', {
			ops: [{ kind: 'delete_element', id: 'g0' }]
		});
		expect((await preview(client, c.candidate, [batch.id])).block_reason).toBe(c.detail);
	});

	it('judges the committed state: a staged edit does not block a candidate the rows hold, and the staged ops are then judged', async () => {
		const c = byName('dropped-property-nobody-sets');
		const client = await replicaOf(c.model);
		const { batch } = await client.call<StageResult>('stage', {
			ops: [{ kind: 'update_element', id: 'n1', properties_patch: { label: 'x' } }]
		});
		// The candidate drops `label`, which no committed row holds: the staged
		// update that sets it is the refusal, as the server's applier answers it.
		expect(await refusal(preview(client, c.candidate, [batch.id]))).toEqual({
			status: 422,
			detail: "'Node' has no property 'label'"
		});
	});

	it('answers the rows before a staged op the candidate refuses, as the server does', async () => {
		const c = byName('dropped-type-in-use');
		const client = await replicaOf(c.model);
		const { batch } = await client.call<StageResult>('stage', {
			ops: [{ kind: 'create_element', temp_id: 'tmp_g', type_name: 'Gadget', properties: {} }]
		});
		expect((await preview(client, c.candidate, [batch.id])).block_reason).toBe(c.detail);
	});

	it('leaves a rebind to the current metamodel unblocked', async () => {
		for (const c of cases) {
			if (c.detail !== null) continue;
			const body = await preview(await replicaOf(c.model), metamodel);
			expect(body.would_block, c.case).toBe(false);
		}
	});
});
