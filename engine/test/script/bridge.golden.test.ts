import { describe, expect, it } from 'vitest';
import type { MetamodelDoc } from '../../src/index.ts';
import {
	BridgeDispatcher,
	dumpDefault,
	projectRoots,
	type BridgeLimits
} from '../../src/script/bridge.ts';
import { loadFixture } from '../golden/load.ts';
import { loadLines } from '../golden/model-load.ts';

type Group = {
	name: string;
	record_ops: boolean;
	limits: {
		max_ops?: number;
		max_op_bytes?: number;
		page_limit?: number;
		max_inline_far_endpoints?: number;
	};
	exchanges: { request: string; reply: string }[];
	ops: string[];
};

type Fixture = {
	metamodel: MetamodelDoc;
	elements: string[];
	relationships: string[];
	groups: Group[];
	roots: { ids: string[]; projection: string }[];
};

const fixture = loadFixture<Fixture>('script_bridge');

function limitsOf(group: Group): Partial<BridgeLimits> {
	const { max_ops, max_op_bytes, page_limit, max_inline_far_endpoints } = group.limits;
	const limits: Partial<BridgeLimits> = {};
	if (max_ops !== undefined) limits.maxOps = max_ops;
	if (max_op_bytes !== undefined) limits.maxOpBytes = max_op_bytes;
	if (page_limit !== undefined) limits.pageLimit = page_limit;
	if (max_inline_far_endpoints !== undefined)
		limits.maxInlineFarEndpoints = max_inline_far_endpoints;
	return limits;
}

function freshModel() {
	return loadLines(fixture.metamodel, fixture.elements, fixture.relationships);
}

describe('the script bridge answers as the oracle does, text for text', () => {
	for (const group of fixture.groups) {
		it(`group ${group.name}`, () => {
			const dispatcher = new BridgeDispatcher(freshModel(), group.record_ops, limitsOf(group));
			for (const { request, reply } of group.exchanges) {
				expect(dispatcher.dispatch(request), request).toBe(reply);
			}
			expect(dispatcher.ops.map(dumpDefault)).toEqual(group.ops);
		});
	}

	it('projects roots in input order, omitting the ids the model lacks', () => {
		const model = freshModel();
		for (const { ids, projection } of fixture.roots) {
			expect(dumpDefault(projectRoots(model, ids)), JSON.stringify(ids)).toBe(projection);
		}
	});
});
