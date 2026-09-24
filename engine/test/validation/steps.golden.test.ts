import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('the issue store keeps what the oracle keeps', () => {
	const fixture = loadFixture<StepsFixture>('validation_steps');

	it('seeded by a sweep, spliced by every batch, read as GET /model/issues', () => {
		replaySteps(fixture);
	});

	it('also when every uniqueness key lands in one bucket', () => {
		replaySteps(fixture, { hashKey: () => 0 });
	});
});
