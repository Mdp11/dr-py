import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('rules evaluate as the oracle evaluates them', () => {
	const fixture = loadFixture<StepsFixture>('rules_eval');

	it('every test against every value, relationship atoms, issues in order', () => {
		replaySteps(fixture);
	});

	it('also when every uniqueness key lands in one bucket', () => {
		replaySteps(fixture, { hashKey: () => 0 });
	});
});
