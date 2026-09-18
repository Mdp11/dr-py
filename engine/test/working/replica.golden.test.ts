import { describe, expect, it } from 'vitest';
import {
	Metamodel,
	Model,
	parseJson,
	shuffleAdjacency,
	verifyConsistent,
	WorkingCopy
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import {
	observe,
	seededRandom,
	type BatchOutcome,
	type StepsFixture
} from '../golden/model-steps.ts';

/**
 * A replica that starts empty and is told of each landed batch only what a
 * commit delta says (whole changed entities, deleted ids, the digest) must
 * stand where the oracle stands, entity order included.
 */
function follow(name: string): void {
	const fixture = loadFixture<StepsFixture>(name);
	const model = new Model(Metamodel.fromJSON(fixture.metamodel));
	const replica = new WorkingCopy(model, { rev: 0, digest: '0'.repeat(16) });
	const random = seededRandom(20260919);
	let expected = { digest: replica.digest, fingerprint: observe(model).fingerprint };
	fixture.steps.forEach((step, index) => {
		if (step.error !== null) return;
		const label = `step ${index}: ${step.do}`;
		const landed = step.result as BatchOutcome;
		if (!step.unchanged) expected = { digest: step.digest!, fingerprint: step.fingerprint! };
		shuffleAdjacency(model, random);
		const { status } = replica.applyDelta({
			rev: replica.rev + 1,
			prev_rev: replica.rev,
			state_digest: expected.digest,
			changed_elements: landed.changed_elements.map(parseJson),
			changed_relationships: landed.changed_relationships.map(parseJson),
			deleted_element_ids: landed.deleted_element_ids,
			deleted_relationship_ids: landed.deleted_relationship_ids
		});
		expect(status, label).toBe('applied');
		expect(replica.diverged, label).toBe(false);
		const seen = observe(model);
		if (step.state !== undefined) expect(seen.state, label).toEqual(step.state);
		expect(seen.digest, label).toBe(expected.digest);
		expect(seen.fingerprint, label).toBe(expected.fingerprint);
		verifyConsistent(model);
	});
}

describe('a replica fed only deltas stands where the oracle stands', () => {
	it('through every op kind, id hints, undo, a rewire and a change of type', () => {
		follow('ops_batches');
	});

	it('through a random walk of batches', () => {
		follow('ops_churn');
	});
});
