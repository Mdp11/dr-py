import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('criteria searches answer as the route answers', () => {
	const fixture = loadFixture<StepsFixture>('search_criteria');

	it('every criterion and op, coercions, patterns, counts, groups and pages, before and after churn', () => {
		replaySteps(fixture);
	});
});
