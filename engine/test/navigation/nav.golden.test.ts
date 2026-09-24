import { describe, it } from 'vitest';
import { loadFixture } from '../golden/load.ts';
import { replaySteps, type StepsFixture } from '../golden/model-steps.ts';

describe('navigations answer as the route and the core answer', () => {
	const fixture = loadFixture<StepsFixture>('nav_eval');

	it('every step kind, scope, set operation, row start, ref, cap and script reach', () => {
		replaySteps(fixture);
	});
});
