import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('fuzzy search ranks as the route ranks', () => {
	const fixture = loadFixture<StepsFixture>('read_search');

	it('tiers, signals, Unicode, ties and pages, before and after churn', () => {
		replaySteps(fixture);
	});

	it('also when every uniqueness key lands in one bucket', () => {
		replaySteps(fixture, { hashKey: () => 0 });
	});
});
